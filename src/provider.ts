import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	type ClientReceipt,
	type CredentialStore,
	createPayingFetch,
	TokenCache,
	type TokenStore,
} from "@lightninglabs/aperture-client";
import type { BuyerPolicy, InvoicePayer } from "@lightninglabs/aperture-core";
import OpenAI from "openai";
import { estimateTokens } from "./bundle.ts";
import { mppIntents } from "./policy.ts";
import type { ReceiptRecord } from "./store.ts";

export interface StreamDeps {
	payer: InvoicePayer;
	policy: BuyerPolicy;

	// tokenStore holds paid L402 tokens. A durable store means paid bundles
	// survive process restarts; when absent, tokens live in memory and die
	// with the process.
	tokenStore?: TokenStore;

	// credentialStore holds paid Payment credentials, the MPP counterpart to
	// tokenStore. Durable storage keeps a retry that throws after the money
	// moved from turning into a second payment on the next attempt.
	credentialStore?: CredentialStore;

	// receiptLog receives one record per settled payment, stamped with the
	// model the payment bought inference for. Absent in mock mode, so fake
	// spends never pollute the real ledger.
	receiptLog?: { store(receipt: ReceiptRecord): Promise<void> | void };

	// onRequest runs as each request starts, with the wire model id, so the
	// caller knows which model a payment made during it is for.
	onRequest?: (model: string) => void;

	// onUsage runs once per response that reported usage, with the wire model
	// id and the prompt and completion token counts (reasoning included).
	// Failures in it never reach the response. The stream handle is the same
	// one onProgress received for this response.
	onUsage?: (model: string, promptTokens: number, completionTokens: number, stream: object) => void;

	// onProgress runs as a response streams, once at the start and then per
	// delta, with running estimates: the prompt from the request body size and
	// the completion from the characters streamed so far, reasoning included,
	// each a quarter of the count rounded up. The stream handle identifies the
	// response, so concurrent ones stay apart. Failures in it never reach the
	// response.
	onProgress?: (model: string, promptEstimate: number, completionEstimate: number, stream: object) => void;

	// onStreamEnd runs instead of onUsage when a response ends without usage.
	// "no-usage" means the request was accepted and then the stream ended or
	// broke (a user abort, or an upstream that omits usage) and "failed" means
	// it never got a stream (a rejected request or a budget refusal).
	onStreamEnd?: (model: string, stream: object, outcome: "no-usage" | "failed") => void;

	// returnInvoiceMinter mints the amountless refund invoice a session
	// deposit needs at open. The embedded wallet cannot provide one, so the
	// extension leaves this unset and the session intent stays refused; the
	// dev harness wires one from a local lnd to exercise the session flow
	// on regtest.
	returnInvoiceMinter?: {
		mintAmountlessInvoice(input: { origin: string; realm: string; memo?: string }): Promise<{ invoice: string }>;
	};
}

// BASETEN_MODEL_SLUGS maps the Pi-facing model ids (kept slash-free so they
// compose with Pi's provider/model selection) to the full Baseten Model APIs
// slugs sent on the wire.
const BASETEN_MODEL_SLUGS: Record<string, string> = {
	"deepseek-v4-flash": "deepseek-ai/DeepSeek-V4-Flash-0731",
	"glm-4.7": "zai-org/GLM-4.7",
	"glm-5": "zai-org/GLM-5",
	"glm-5.2": "zai-org/GLM-5.2",
	"kimi-k3": "moonshotai/Kimi-K3",
	"kimi-k3.1-pro": "moonshotai/Kimi-K3.1-Pro",
};

// wireModelId resolves the model id sent to the proxy/upstream.
export function wireModelId(id: string): string {
	return BASETEN_MODEL_SLUGS[id] ?? id;
}

// VENICE_MODEL_IDS are the Pi-facing ids served by a Venice upstream, whose
// own ids are sent unchanged.
const VENICE_MODEL_IDS = new Set(["deepseek-v4-1-flash"]);

// upstreamExtraBody returns extra request fields a model's upstream needs.
//
// Venice prepends its own system prompt, about 1.5k tokens, to every request
// unless told not to. Those tokens are counted in the response's usage, so the
// seller's meter debits the buyer for text the buyer never wrote. Turning the
// prompt off drops a one-word question from about 1,550 prompt tokens to about
// 40, and keeps the bundle for the buyer's own tokens.
export function upstreamExtraBody(modelId: string): Record<string, unknown> {
	if (VENICE_MODEL_IDS.has(modelId)) {
		return { venice_parameters: { include_venice_system_prompt: false } };
	}
	return {};
}

// requestUrl extracts the URL from any of the shapes fetch accepts, without
// consuming the request body.
function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.href;
	}
	return input.url;
}

// tokenRouteId scopes a cached L402 token to one model.
//
// The token cache keys on origin + routeId + method, and routeId defaults to
// the request path. Every model this provider registers posts to the same
// /v1/chat/completions path, so without the model in the key they all share
// one cache slot: paying for model B would overwrite the token for model A and
// strand A's unspent bundle balance, since the macaroon and preimage needed to
// present it are gone. The seller already refuses to spend one model's bundle
// on another, so the buyer must track them separately too.
export function tokenRouteId(input: RequestInfo | URL, model: string): string {
	let path: string;
	try {
		path = new URL(requestUrl(input)).pathname;
	} catch {
		// A URL we cannot parse still needs a stable key; the model alone
		// keeps distinct models from sharing a token.
		path = "";
	}
	return `${path}|${model}`;
}

// makeStreamSimple builds the paid provider's streamSimple. The returned
// function owns the entire request path to the L402 proxy: it constructs an
// OpenAI client whose fetch is a paying fetch, so 402 challenges are paid and
// retried transparently, then translates the OpenAI SSE stream into Pi's event
// stream.
export function makeStreamSimple(deps: StreamDeps) {
	// One token cache per provider instance, so paid L402 tokens are reused
	// across calls until they expire. With a durable store injected, reuse
	// extends across processes too.
	const tokenCache = deps.tokenStore ?? new TokenCache();

	return function streamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

		(async () => {
			const output = emptyAssistantMessage(model);

			// The live-bar bookkeeping: the handle that names this response,
			// whether the seller accepted the request, and whether a final
			// outcome has been reported yet.
			const handle = {};
			let accepted = false;
			let reported = false;
			let promptEstimate = 0;
			let completionChars = 0;
			const wireModel = wireModelId(model.id);
			const progress = (): void => {
				try {
					deps.onProgress?.(wireModel, promptEstimate, estimateTokens(completionChars), handle);
				} catch {
					// The bar is a convenience.
				}
			};
			const end = (outcome: "no-usage" | "failed"): void => {
				if (reported) {
					return;
				}
				reported = true;
				try {
					deps.onStreamEnd?.(wireModel, handle, outcome);
				} catch {
					// The bar is a convenience.
				}
			};

			try {
				// The receipt adapter stamps each settled payment with the
				// model it bought inference for. It is built per call, so
				// the model rides in via closure without threading through
				// the buyer loop.
				const receiptLog = deps.receiptLog;
				const receiptCache = receiptLog
					? {
							store: (receipt: ClientReceipt) => receiptLog.store({ ...receipt, model: wireModelId(model.id) }),
						}
					: undefined;

				// The paying fetch runs the buyer loop: detect 402, assert the
				// budget policy, pay via the wallet, cache the credential, and
				// retry. Which scheme it answers with is the seller's choice
				// as narrowed by ours: aperture with --enablempp offers a
				// Payment challenge alongside L402 in one merged header, and
				// mppIntents decides whether we take it.
				const payingFetch = createPayingFetch({
					payer: deps.payer,
					buyerPolicy: deps.policy,
					tokenCache,
					receiptCache,
					mpp: {
						// The session intent is only usable with a minter for
						// the amountless refund invoice an open must carry;
						// mppIntents refuses it otherwise, so a deposit is
						// never paid for an open the server is guaranteed to
						// refuse.
						intents: mppIntents({
							hasReturnInvoiceMinter: deps.returnInvoiceMinter !== undefined,
						}),
						credentialCache: deps.credentialStore,
						returnInvoiceMinter: deps.returnInvoiceMinter,
						onReceiptMismatch: ({ receipt, reasons }) => {
							console.warn(
								`pi-402: payment receipt ${receipt.reference} disagrees with what was paid for: ${reasons.join("; ")}`,
							);
						},
					},
				});

				deps.onRequest?.(wireModel);

				const client = new OpenAI({
					baseURL: model.baseUrl,
					apiKey: "unused",
					// Scope the cached token to this model, so one model's
					// paid bundle is never overwritten by another's payment.
					fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
						payingFetch(input, {
							...init,
							routeId: tokenRouteId(input, wireModel),
						})) as typeof fetch,
					// The paying fetch owns retry semantics: it runs the L402
					// buyer loop and retries exactly once after payment. The
					// SDK's default of two retries would re-enter payingFetch on
					// any thrown error, and a throw after payment was dispatched
					// (e.g. a preimage-wait timeout) would fetch a fresh 402 and
					// pay a second time. Disable SDK retries so we never
					// double-pay.
					maxRetries: 0,
				});

				const tools = toOpenAiTools(context);

				const body = {
					model: wireModel,
					messages: toOpenAiMessages(context),
					...(tools ? { tools } : {}),
					...upstreamExtraBody(model.id),
					max_tokens: options?.maxTokens ?? Math.floor(model.maxTokens / 3),
					stream: true as const,
					// Baseten defaults include_usage to true, but ask
					// explicitly: the final chunk's usage is what the
					// seller-side metering debits, so both sides should
					// see the same numbers.
					stream_options: { include_usage: true },
				};

				// The prompt estimate is known before the first token: the
				// body size over four, which is also how the seller settles a
				// stream that ends without usage.
				promptEstimate = estimateTokens(Buffer.byteLength(JSON.stringify(body)));
				progress();

				const sse = await client.chat.completions.create(body, { signal: options?.signal });
				accepted = true;

				stream.push({ type: "start", partial: output });

				const blocks = new BlockWriter(output, stream);

				let sawUsage = false;
				for await (const chunk of sse) {
					const choice = chunk.choices[0];
					const delta = choice?.delta as OpenAiDelta | undefined;

					// Reasoning arrives first and, on a thinking model, can
					// run for most of the response. Surfacing it as thinking
					// content is what keeps the turn from looking hung while
					// the model works.
					if (delta?.reasoning_content) {
						blocks.appendThinking(delta.reasoning_content);
						completionChars += delta.reasoning_content.length;
						progress();
					}

					if (delta?.content) {
						blocks.appendText(delta.content);
						completionChars += delta.content.length;
						progress();
					}

					for (const call of delta?.tool_calls ?? []) {
						blocks.appendToolCall(call);
					}

					const finish = choice?.finish_reason;
					if (finish === "length") {
						output.stopReason = "length";
					} else if (finish === "tool_calls") {
						output.stopReason = "toolUse";
					}

					// Usage arrives on the final chunk (and, on Baseten,
					// as running totals on every chunk); the last write
					// wins either way.
					if (chunk.usage) {
						sawUsage = true;
						output.usage.input = chunk.usage.prompt_tokens ?? 0;
						output.usage.output = chunk.usage.completion_tokens ?? 0;
						output.usage.totalTokens = chunk.usage.total_tokens ?? 0;

						const reasoning = (chunk.usage as { completion_tokens_details?: { reasoning_tokens?: number } })
							.completion_tokens_details?.reasoning_tokens;
						if (typeof reasoning === "number") {
							output.usage.reasoning = reasoning;
						}
					}
				}

				blocks.close();

				// The seller meters this same usage, so the bundle bar
				// debits it here, for paid and reused credentials alike.
				if (sawUsage) {
					reported = true;
					try {
						deps.onUsage?.(wireModel, output.usage.input, output.usage.output, handle);
					} catch {
						// The bar is a convenience.
					}
				} else {
					end("no-usage");
				}

				// A model can emit tool calls without the upstream setting the
				// matching finish_reason. Pi routes on the stop reason, so
				// derive it from what actually arrived rather than trusting
				// the flag: a missed toolUse ends the turn holding calls
				// nobody runs.
				if (output.stopReason !== "toolUse" && output.content.some((part) => part.type === "toolCall")) {
					output.stopReason = "toolUse";
				}

				stream.push({
					type: "done",
					reason: output.stopReason as "stop" | "length" | "toolUse",
					message: output,
				});
				stream.end();
			} catch (error) {
				end(accepted ? "no-usage" : "failed");
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// The OpenAI SDK wraps transport-level throws (including
				// budget-policy rejections from the paying fetch) in a
				// generic connection error; the cause carries the real story.
				const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
				output.errorMessage = cause?.message ?? (error instanceof Error ? error.message : String(error));
				stream.push({
					type: "error",
					reason: output.stopReason as "error" | "aborted",
					error: output,
				});
				stream.end();
			}
		})();

		return stream;
	};
}

// emptyAssistantMessage seeds the output message the stream accumulates into.
function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// toOpenAiTools projects Pi's tool declarations into the OpenAI function-tool
// schema. Declaring the tools matters beyond enabling tool use: Pi's system
// prompt tells the model it has tools regardless, so a model that is not given
// them in the request still tries to call them, and emits its own native
// tool-call syntax as ordinary assistant text. That markup is what the user
// ends up reading. Sending the declarations is what moves those calls onto the
// structured tool_calls channel where they can be translated.
export function toOpenAiTools(context: Context): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
	if (!context.tools?.length) {
		return undefined;
	}
	return context.tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as unknown as Record<string, unknown>,
		},
	}));
}

// textOf flattens a Pi message content array down to its text parts.
function textOf(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part) => (part as { type?: string })?.type === "text")
		.map((part) => (part as { text: string }).text)
		.join("");
}

// toOpenAiMessages converts Pi's context into OpenAI chat messages, including
// the tool-call round trip: an assistant turn that called tools has to be
// replayed with those calls attached, and each result has to come back as a
// tool message naming the call it answers. Dropping either half leaves the
// model looking at a request whose tool results answer nothing, which it
// resolves by calling the same tool again.
export function toOpenAiMessages(context: Context): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
	const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content = textOf(msg.content);
			if (content.trim()) {
				messages.push({ role: "user", content });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const content = textOf(msg.content);
			const toolCalls = (Array.isArray(msg.content) ? msg.content : [])
				.filter((part) => (part as { type?: string })?.type === "toolCall")
				.map((part) => {
					const call = part as { id: string; name: string; arguments: Record<string, unknown> };
					return {
						id: call.id,
						type: "function" as const,
						function: {
							name: call.name,
							arguments: JSON.stringify(call.arguments ?? {}),
						},
					};
				});

			// An assistant turn with neither text nor calls carries nothing
			// the model can use, and an empty turn is rejected outright by
			// some upstreams.
			if (!content.trim() && toolCalls.length === 0) {
				continue;
			}

			messages.push({
				role: "assistant",
				content: content || null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			} as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
			continue;
		}

		if (msg.role === "toolResult") {
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: textOf(msg.content) || (msg.isError ? "error" : ""),
			});
		}
	}

	return messages;
}

// OpenAiDelta is the streaming delta this provider reads. The SDK's own type
// omits reasoning_content, which is where thinking models put the bulk of a
// response.
interface OpenAiDelta {
	content?: string | null;
	reasoning_content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

// BlockWriter turns a flat run of streaming deltas into Pi's content blocks.
//
// Pi's event protocol is bracketed: every block is opened, filled, and closed,
// and the index in each event has to address the block it belongs to. A
// response interleaves reasoning, text, and tool calls, so this tracks which
// block is currently open and closes it before opening the next kind. Tool
// call arguments are the awkward part: they arrive as JSON fragments across
// many chunks and are only parseable once the whole run has landed, so the raw
// text is buffered and parsed at close.
class BlockWriter {
	private readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;

	// open is the block currently accepting deltas, if any.
	private open: { kind: "text" | "thinking" | "toolCall"; index: number } | undefined;

	// rawArguments buffers each tool call's argument fragments, keyed by the
	// content index of its block.
	private readonly rawArguments = new Map<number, string>();

	// toolIndexToContent maps the upstream tool_calls[].index onto the content
	// block holding that call, so later fragments reach the right one.
	private readonly toolIndexToContent = new Map<number, number>();

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
		this.output = output;
		this.stream = stream;
	}

	appendText(delta: string): void {
		const index = this.ensure("text", () => ({ type: "text", text: "" }));
		(this.output.content[index] as { text: string }).text += delta;
		this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.output });
	}

	appendThinking(delta: string): void {
		const index = this.ensure("thinking", () => ({ type: "thinking", thinking: "" }));
		(this.output.content[index] as { thinking: string }).thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.output });
	}

	appendToolCall(call: { index: number; id?: string; function?: { name?: string; arguments?: string } }): void {
		let contentIndex = this.toolIndexToContent.get(call.index);

		if (contentIndex === undefined) {
			this.close();
			this.output.content.push({
				type: "toolCall",
				// The id is what the tool result is matched back to, so a
				// call that arrives without one still needs a stable
				// stand-in rather than an empty string shared by every call.
				id: call.id ?? `call_${call.index}`,
				name: call.function?.name ?? "",
				arguments: {},
			} as never);
			contentIndex = this.output.content.length - 1;
			this.toolIndexToContent.set(call.index, contentIndex);
			this.rawArguments.set(contentIndex, "");
			this.open = { kind: "toolCall", index: contentIndex };
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		} else if (this.open?.index !== contentIndex) {
			// Fragments for a call resumed after another block opened.
			this.close();
			this.open = { kind: "toolCall", index: contentIndex };
		}

		const block = this.output.content[contentIndex] as { id: string; name: string };
		if (call.id) {
			block.id = call.id;
		}
		if (call.function?.name) {
			block.name = call.function.name;
		}

		const fragment = call.function?.arguments ?? "";
		if (fragment) {
			this.rawArguments.set(contentIndex, (this.rawArguments.get(contentIndex) ?? "") + fragment);
			this.stream.push({ type: "toolcall_delta", contentIndex, delta: fragment, partial: this.output });
		}
	}

	// close ends the open block, emitting the matching end event.
	close(): void {
		if (!this.open) {
			return;
		}
		const { kind, index } = this.open;
		this.open = undefined;

		if (kind === "text") {
			const content = (this.output.content[index] as { text: string }).text;
			this.stream.push({ type: "text_end", contentIndex: index, content, partial: this.output });
			return;
		}

		if (kind === "thinking") {
			const content = (this.output.content[index] as { thinking: string }).thinking;
			this.stream.push({ type: "thinking_end", contentIndex: index, content, partial: this.output });
			return;
		}

		const block = this.output.content[index] as { arguments: Record<string, unknown> };
		block.arguments = parseToolArguments(this.rawArguments.get(index) ?? "");
		this.stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: this.output.content[index] as never,
			partial: this.output,
		});
	}

	// ensure returns the index of the open block of the given kind, opening one
	// when the current block is of another kind.
	private ensure(kind: "text" | "thinking", make: () => object): number {
		if (this.open?.kind === kind) {
			return this.open.index;
		}
		this.close();
		this.output.content.push(make() as never);
		const index = this.output.content.length - 1;
		this.open = { kind, index };
		this.stream.push({
			type: kind === "text" ? "text_start" : "thinking_start",
			contentIndex: index,
			partial: this.output,
		});
		return index;
	}
}

// parseToolArguments turns the accumulated argument text into an object. A
// model can stream arguments that never parse, and an empty run is normal for
// a no-argument tool. Neither is worth failing the whole turn over: an empty
// object lets the tool reject the call on its own terms, which reads better
// than the stream erroring out.
export function parseToolArguments(raw: string): Record<string, unknown> {
	const text = raw.trim();
	if (!text) {
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		console.warn("pi-402: tool call arguments did not parse as JSON, passing an empty object:", text);
		return {};
	}
}

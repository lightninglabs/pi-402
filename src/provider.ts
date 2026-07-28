import { createPayingFetch, TokenCache } from "@aperture/client";
import type { BuyerPolicy, InvoicePayer } from "@aperture/core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import OpenAI from "openai";

export interface StreamDeps {
	payer: InvoicePayer;
	policy: BuyerPolicy;
}

// BASETEN_MODEL_SLUGS maps the Pi-facing model ids (kept slash-free so they
// compose with Pi's provider/model selection) to the full Baseten Model APIs
// slugs sent on the wire.
const BASETEN_MODEL_SLUGS: Record<string, string> = {
	"glm-4.7": "zai-org/GLM-4.7",
	"glm-5": "zai-org/GLM-5",
	"glm-5.2": "zai-org/GLM-5.2",
	"kimi-k3": "moonshotai/Kimi-K3",
};

// wireModelId resolves the model id sent to the proxy/upstream.
function wireModelId(id: string): string {
	return BASETEN_MODEL_SLUGS[id] ?? id;
}

// makeStreamSimple builds the paid provider's streamSimple. The returned
// function owns the entire request path to the L402 proxy: it constructs an
// OpenAI client whose fetch is a paying fetch, so 402 challenges are paid and
// retried transparently, then translates the OpenAI SSE stream into Pi's event
// stream.
export function makeStreamSimple(deps: StreamDeps) {
	// One token cache per provider instance, so paid L402 tokens are reused
	// across calls until they expire.
	const tokenCache = new TokenCache();

	return function streamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

		(async () => {
			const output = emptyAssistantMessage(model);

			try {
				// The paying fetch runs the L402 buyer loop: detect 402, assert the
				// budget policy, pay via the wallet, cache the token, and retry.
				const payingFetch = createPayingFetch({
					payer: deps.payer,
					buyerPolicy: deps.policy,
					tokenCache,
				});

				const client = new OpenAI({
					baseURL: model.baseUrl,
					apiKey: "unused",
					fetch: payingFetch as typeof fetch,
					// The paying fetch owns retry semantics: it runs the L402
					// buyer loop and retries exactly once after payment. The
					// SDK's default of two retries would re-enter payingFetch on
					// any thrown error, and a throw after payment was dispatched
					// (e.g. a preimage-wait timeout) would fetch a fresh 402 and
					// pay a second time. Disable SDK retries so we never
					// double-pay.
					maxRetries: 0,
				});

				const sse = await client.chat.completions.create(
					{
						model: wireModelId(model.id),
						messages: toOpenAiMessages(context),
						max_tokens: options?.maxTokens ?? Math.floor(model.maxTokens / 3),
						stream: true,
						// Baseten defaults include_usage to true, but ask
						// explicitly: the final chunk's usage is what the
						// seller-side metering debits, so both sides should
						// see the same numbers.
						stream_options: { include_usage: true },
					},
					{ signal: options?.signal },
				);

				stream.push({ type: "start", partial: output });

				// TODO(milestone-2): translate the full OpenAI streaming surface
				// (tool calls, reasoning) into AssistantMessageEvents. The
				// custom-provider-anthropic example is the reference for the
				// complete mapping; this handles text and usage for now.
				for await (const chunk of sse) {
					const delta = chunk.choices[0]?.delta?.content ?? "";
					if (delta) {
						appendText(output, stream, delta);
					}

					const finish = chunk.choices[0]?.finish_reason;
					if (finish === "length") {
						output.stopReason = "length";
					}

					// Usage arrives on the final chunk (and, on Baseten,
					// as running totals on every chunk); the last write
					// wins either way.
					if (chunk.usage) {
						output.usage.input = chunk.usage.prompt_tokens ?? 0;
						output.usage.output = chunk.usage.completion_tokens ?? 0;
						output.usage.totalTokens = chunk.usage.total_tokens ?? 0;
					}
				}

				stream.push({
					type: "done",
					reason: output.stopReason as "stop" | "length" | "toolUse",
					message: output,
				});
				stream.end();
			} catch (error) {
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

// toOpenAiMessages converts Pi's context into OpenAI chat messages. This is a
// minimal text-only projection; the full converter handles images, tool calls,
// and tool results.
function toOpenAiMessages(context: Context): Array<{ role: "system" | "user" | "assistant"; content: string }> {
	const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}
	for (const msg of context.messages) {
		if (msg.role === "user" || msg.role === "assistant") {
			const content = typeof msg.content === "string" ? msg.content : "";
			if (content.trim()) {
				messages.push({ role: msg.role, content });
			}
		}
	}
	return messages;
}

// appendText appends a streamed text delta to the output message, opening a text
// block on first use.
function appendText(output: AssistantMessage, stream: AssistantMessageEventStream, delta: string): void {
	let block = output.content[output.content.length - 1] as { type: string; text: string } | undefined;
	if (!block || block.type !== "text") {
		output.content.push({ type: "text", text: "" } as never);
		block = output.content[output.content.length - 1] as { type: string; text: string };
		stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
	}
	block.text += delta;
	stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta, partial: output });
}

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
	type StopReason,
} from "@earendil-works/pi-ai";
import OpenAI from "openai";

export interface StreamDeps {
	payer: InvoicePayer;
	policy: BuyerPolicy;
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
				});

				const sse = await client.chat.completions.create(
					{
						model: model.id,
						messages: toOpenAiMessages(context),
						max_tokens: options?.maxTokens ?? Math.floor(model.maxTokens / 3),
						stream: true,
					},
					{ signal: options?.signal },
				);

				stream.push({ type: "start", partial: output });

				// TODO(milestone-2): translate the full OpenAI streaming surface
				// (tool calls, reasoning, usage) into AssistantMessageEvents. The
				// custom-provider-anthropic example is the reference for the complete
				// mapping; this handles the text path only for now.
				for await (const chunk of sse) {
					const delta = chunk.choices[0]?.delta?.content ?? "";
					if (delta) {
						appendText(output, stream, delta);
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
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason as StopReason, error: output });
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolArguments, toOpenAiMessages, toOpenAiTools, tokenRouteId } from "../src/provider.ts";

const CHAT = "http://localhost:8404/v1/chat/completions";

test("tokenRouteId separates models sharing one endpoint", () => {
	// This is the property that keeps a paid bundle alive. Every model this
	// provider registers posts to the same path, so if the route id did not
	// carry the model, paying for the second model would overwrite the first
	// model's token and strand its unspent balance.
	const kimi = tokenRouteId(CHAT, "moonshotai/Kimi-K3");
	const glm = tokenRouteId(CHAT, "zai-org/GLM-4.7");

	assert.notEqual(kimi, glm);
	assert.match(kimi, /moonshotai\/Kimi-K3$/);
});

test("tokenRouteId is stable across the shapes fetch accepts", () => {
	const expected = tokenRouteId(CHAT, "moonshotai/Kimi-K3");

	// A string, a URL and a Request must all key the same token: the buyer
	// loop is handed whichever the SDK happens to build, and a key that
	// varied by input shape would re-buy a bundle it already owns.
	assert.equal(tokenRouteId(new URL(CHAT), "moonshotai/Kimi-K3"), expected);
	assert.equal(tokenRouteId(new Request(CHAT, { method: "POST" }), "moonshotai/Kimi-K3"), expected);
});

test("tokenRouteId keys on the path as well as the model", () => {
	const chat = tokenRouteId(CHAT, "moonshotai/Kimi-K3");
	const other = tokenRouteId("http://localhost:8404/v1/embeddings", "moonshotai/Kimi-K3");

	// Two routes on one origin can be gated by unrelated challenges, so the
	// path has to stay in the key alongside the model.
	assert.notEqual(chat, other);
});

test("tokenRouteId still separates models when the URL is unparseable", () => {
	// A key is required either way; falling back to the model alone keeps
	// distinct models from sharing a token even then.
	const kimi = tokenRouteId("not a url", "moonshotai/Kimi-K3");
	const glm = tokenRouteId("not a url", "zai-org/GLM-4.7");

	assert.notEqual(kimi, glm);
});

test("toOpenAiTools declares Pi's tools to the model", () => {
	// Declaring tools is what keeps a thinking model from inventing its own
	// call syntax. Pi's system prompt tells the model it has tools whether or
	// not the request carries them, so a request without them leaves the
	// model emitting native tool-call markup as ordinary assistant text,
	// which is what the user then reads on screen.
	const tools = toOpenAiTools({
		messages: [],
		tools: [{ name: "bash", description: "Run a command", parameters: { type: "object" } as never }],
	});

	assert.equal(tools?.length, 1);
	assert.equal(tools?.[0].type, "function");
	assert.equal(tools?.[0].function.name, "bash");
});

test("toOpenAiTools sends nothing when Pi offers no tools", () => {
	// An empty tools array is not the same as omitting the field: some
	// upstreams reject it outright.
	assert.equal(toOpenAiTools({ messages: [] }), undefined);
	assert.equal(toOpenAiTools({ messages: [], tools: [] }), undefined);
});

test("toOpenAiMessages replays the tool-call round trip", () => {
	// A tool result that names no call is a result answering nothing. The
	// model resolves that by calling the same tool again, so the agent loops
	// instead of finishing. Pin down that both halves survive the conversion.
	const messages = toOpenAiMessages({
		systemPrompt: "be useful",
		messages: [
			{ role: "user", content: "write a file", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "on it" },
					{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.txt" } },
				],
				timestamp: 0,
			} as never,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "write",
				content: [{ type: "text", text: "written" }],
				isError: false,
				timestamp: 0,
			} as never,
		],
	});

	assert.equal(messages[0].role, "system");
	assert.equal(messages[1].role, "user");

	const assistant = messages[2] as { role: string; tool_calls?: Array<{ id: string; function: { arguments: string } }> };
	assert.equal(assistant.role, "assistant");
	assert.equal(assistant.tool_calls?.[0].id, "call_1");
	// Arguments go back over the wire as a JSON string, not an object.
	assert.equal(assistant.tool_calls?.[0].function.arguments, JSON.stringify({ path: "a.txt" }));

	const result = messages[3] as { role: string; tool_call_id: string; content: string };
	assert.equal(result.role, "tool");
	assert.equal(result.tool_call_id, "call_1");
	assert.equal(result.content, "written");
});

test("toOpenAiMessages drops an assistant turn carrying neither text nor calls", () => {
	// An empty assistant turn contributes nothing and is rejected outright by
	// some upstreams, which would fail the whole request.
	const messages = toOpenAiMessages({
		messages: [{ role: "assistant", content: [], timestamp: 0 } as never],
	});

	assert.deepEqual(messages, []);
});

test("parseToolArguments survives a run the model never finished", () => {
	// Arguments arrive as JSON fragments across many chunks, so a truncated
	// or malformed run is a live possibility. Failing the whole turn over it
	// reads far worse than letting the tool reject an empty call.
	assert.deepEqual(parseToolArguments('{"path":"a.txt"}'), { path: "a.txt" });
	assert.deepEqual(parseToolArguments(""), {});
	assert.deepEqual(parseToolArguments('{"path":'), {});
	// A bare array or scalar is not a valid argument object either.
	assert.deepEqual(parseToolArguments("[1,2]"), {});
	assert.deepEqual(parseToolArguments('"hi"'), {});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenRouteId } from "../src/provider.ts";

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

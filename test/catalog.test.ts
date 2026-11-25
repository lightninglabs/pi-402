import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CatalogCache,
	type CatalogModel,
	fetchCatalog,
	MAX_CATALOG_MODELS,
	parseCatalog,
	piModelId,
	toProviderModels,
} from "../src/catalog.ts";

// builtIns stands in for the extension's built-in list.
const builtIns: CatalogModel[] = [
	{
		id: "deepseek-v4-flash",
		wireId: "deepseek-ai/DeepSeek-V4-Flash-0731",
		name: "DeepSeek V4 Flash (L402)",
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
	},
	{
		id: "deepseek-v4-1-flash",
		wireId: "deepseek-v4-1-flash",
		name: "DeepSeek V4.1 Flash (L402)",
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
	},
];

// rate is a rate-file entry with only the bar's fields.
const rate = { bundleTokens: 500_000, inputUsdPerMtok: 1, outputUsdPerMtok: 2 };

test("piModelId keeps the slug tail, lowercased and slash-free", () => {
	assert.equal(piModelId("zai-org/GLM-5.3-Flash"), "glm-5.3-flash");
	assert.equal(piModelId("nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B"), "nvidia-nemotron-3-ultra-550b-a55b");
	assert.equal(piModelId("deepseek-v4-1-flash"), "deepseek-v4-1-flash");
	assert.equal(piModelId("org/Model_Name:v2"), "model-name-v2");
	assert.equal(piModelId("org/"), "");
});

test("parseCatalog lists the seller's models in the file's order", () => {
	const models = parseCatalog(
		{
			version: 1,
			bundleValidDays: 30,
			models: {
				"zai-org/GLM-5.3-Flash": {
					...rate,
					contextTokens: 1_048_576,
					name: "GLM 5.3 Flash",
					input: ["text", "image"],
					reasoning: true,
					maxTokens: 65_536,
				},
				"deepseek-ai/DeepSeek-V4-Flash-0731": { ...rate, contextTokens: 1_048_576 },
			},
		},
		builtIns,
	);
	assert.deepEqual(models, [
		{
			id: "glm-5.3-flash",
			wireId: "zai-org/GLM-5.3-Flash",
			name: "GLM 5.3 Flash (L402)",
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		},
		{
			// A model the built-in list knows keeps its Pi id and fills its
			// gaps from there; the seller's context size wins.
			id: "deepseek-v4-flash",
			wireId: "deepseek-ai/DeepSeek-V4-Flash-0731",
			name: "DeepSeek V4 Flash (L402)",
			input: ["text"],
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 32_768,
		},
	]);
});

test("parseCatalog reads today's rate files unchanged", () => {
	// The demo seller's file, as published: the menu is its one model.
	const models = parseCatalog(
		{
			version: 1,
			bundleValidDays: 30,
			marginPercent: 25,
			models: { "deepseek-v4-1-flash": { ...rate, contextTokens: 1_000_000 } },
		},
		builtIns,
	);
	assert.deepEqual(models, [builtIns[1]]);

	// An unknown model with no optional fields gets conservative defaults.
	assert.deepEqual(parseCatalog({ version: 1, models: { "acme/Big-1": rate } }, builtIns), [
		{
			id: "big-1",
			wireId: "acme/Big-1",
			name: "acme/Big-1 (L402)",
			input: ["text"],
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 32_768,
		},
	]);
});

test("parseCatalog skips what it cannot use", () => {
	for (const body of [
		null,
		"nope",
		{ version: 2, models: { "a/b": rate } },
		{ version: 1 },
		{ version: 1, models: [] },
	]) {
		assert.equal(parseCatalog(body, builtIns), undefined);
	}
	assert.equal(parseCatalog({ version: 1, models: { "../x": rate, "a b": rate, "": rate } }, builtIns), undefined);

	const models = parseCatalog(
		{
			version: 1,
			models: {
				"acme/Odd": {
					contextTokens: -5,
					maxTokens: 10_000_000,
					input: ["image"],
					reasoning: "yes",
					name: "\u0007 Odd\n model ".padEnd(200, "x"),
				},
				"acme/Not-An-Object": 7,
				// Same Pi id as acme/Odd: the first one wins.
				"other/odd": rate,
			},
		},
		builtIns,
	);
	assert.equal(models?.length, 1);
	const [odd] = models as CatalogModel[];
	assert.equal(odd.contextWindow, 128_000);
	assert.equal(odd.maxTokens, 32_768);
	assert.deepEqual(odd.input, ["text"]);
	assert.equal(odd.reasoning, false);
	assert.ok(odd.name.startsWith("Odd model x"));
	assert.ok(odd.name.length <= 80 + " (L402)".length);
	assert.doesNotMatch(odd.name, /[\u0000-\u001f]/);
});

test("parseCatalog takes at most MAX_CATALOG_MODELS models", () => {
	const entries: Record<string, unknown> = {};
	for (let i = 0; i < MAX_CATALOG_MODELS + 10; i++) {
		entries[`acme/m-${i}`] = rate;
	}
	assert.equal(parseCatalog({ version: 1, models: entries }, builtIns)?.length, MAX_CATALOG_MODELS);
});

test("fetchCatalog reads <origin>/pi402.json without paying or sending credentials", async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const file = { version: 1, models: { "acme/Big-1": rate } };
	const fetchFn = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(file), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await fetchCatalog("https://s.example", builtIns, fetchFn);
	assert.deepEqual(
		result?.models.map((m) => m.id),
		["big-1"],
	);
	assert.deepEqual(result?.body, file);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://s.example/pi402.json");
	assert.equal(new Headers(calls[0].init?.headers).get("authorization"), null);
});

test("fetchCatalog gives up on a 402, bad JSON, an oversized file or a network error", async () => {
	const respond = (body: string, status = 200) =>
		(async () => new Response(body, { status })) as unknown as typeof fetch;
	assert.equal(await fetchCatalog("https://s.example", builtIns, respond("{}", 402)), undefined);
	assert.equal(await fetchCatalog("https://s.example", builtIns, respond("{nope")), undefined);
	assert.equal(await fetchCatalog("https://s.example", builtIns, respond(" ".repeat(300 * 1024))), undefined);
	const offline = (async () => {
		throw new Error("offline");
	}) as typeof fetch;
	assert.equal(await fetchCatalog("https://s.example", builtIns, offline), undefined);
});

test("CatalogCache keeps one menu per seller and re-checks it on read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi402-catalog-"));
	const path = join(dir, "catalog.json");
	const cache = new CatalogCache(path);
	assert.equal(cache.read("https://a.example", builtIns), undefined);

	cache.write("https://a.example", { version: 1, models: { "acme/Big-1": rate } });
	cache.write("https://b.example", { version: 1, models: { "deepseek-v4-1-flash": rate } });
	assert.deepEqual(
		new CatalogCache(path).read("https://a.example", builtIns)?.map((m) => m.id),
		["big-1"],
	);
	assert.deepEqual(
		new CatalogCache(path).read("https://b.example", builtIns)?.map((m) => m.id),
		["deepseek-v4-1-flash"],
	);

	await writeFile(path, "{nope");
	assert.equal(cache.read("https://a.example", builtIns), undefined);
});

test("toProviderModels shapes the menu for Pi with zero per-token cost", () => {
	assert.deepEqual(toProviderModels([builtIns[0]]), [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash (L402)",
			input: ["text"],
			reasoning: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 32_768,
		},
	]);
});

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyUsage,
	BundleTracker,
	type Colorizer,
	debitTokens,
	FileBundleStore,
	formatBar,
	formatTokens,
	isBundleExpired,
	MemoryBundleStore,
	parseModelRate,
	startBundle,
} from "../src/bundle.ts";
import { MockInvoicePayer } from "../src/payer.ts";
import { makeStreamSimple } from "../src/provider.ts";
import { formatFooter } from "../src/usd.ts";

const MODEL = "deepseek-v4-1-flash";
const DAY = 86_400_000;

// rateFile is the live seller's file, version 1.
const rateFile = {
	version: 1,
	bundleValidDays: 30,
	marginPercent: 25,
	models: {
		[MODEL]: { bundleTokens: 500_000, inputUsdPerMtok: 0.375, outputUsdPerMtok: 1.5, contextTokens: 1_000_000 },
	},
};

// tag makes a colorizer that shows which color was chosen.
const tag: Colorizer = (color, text) => `<${color}>${text}</${color}>`;

const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

test("parseModelRate reads the model's entry and the bundle lifetime", () => {
	assert.deepEqual(parseModelRate(rateFile, MODEL), {
		bundleTokens: 500_000,
		inputUsdPerMtok: 0.375,
		outputUsdPerMtok: 1.5,
		validDays: 30,
	});
});

test("parseModelRate yields nothing for a missing model or a malformed file", () => {
	assert.equal(parseModelRate(rateFile, "other"), undefined);
	assert.equal(parseModelRate(null, MODEL), undefined);
	assert.equal(parseModelRate("nope", MODEL), undefined);
	assert.equal(parseModelRate({ ...rateFile, version: 2 }, MODEL), undefined);
	assert.equal(parseModelRate({ ...rateFile, bundleValidDays: 0 }, MODEL), undefined);
	assert.equal(parseModelRate({ ...rateFile, models: undefined }, MODEL), undefined);
	const broken = { ...rateFile, models: { [MODEL]: { ...rateFile.models[MODEL], outputUsdPerMtok: "1.5" } } };
	assert.equal(parseModelRate(broken, MODEL), undefined);
	const zero = { ...rateFile, models: { [MODEL]: { ...rateFile.models[MODEL], bundleTokens: 0 } } };
	assert.equal(parseModelRate(zero, MODEL), undefined);
});

test("debitTokens matches hand-computed cases", () => {
	const rate = { inputUsdPerMtok: 0.375, outputUsdPerMtok: 1.5 };

	// Equal weights: 2 * (a*r + b*r) / (2r) is just a + b.
	assert.equal(debitTokens({ inputUsdPerMtok: 1, outputUsdPerMtok: 1 }, 100, 50), 150);

	// Output costs four times input here. 1000 prompt tokens:
	// 2 * 1000 * 0.375 / 1.875 = 400.
	assert.equal(debitTokens(rate, 1_000, 0), 400);

	// 1000 completion tokens: 2 * 1000 * 1.5 / 1.875 = 1600.
	assert.equal(debitTokens(rate, 0, 1_000), 1_600);

	// 2000 in, 500 out: 2 * (750 + 750) / 1.875 = 1600.
	assert.equal(debitTokens(rate, 2_000, 500), 1_600);
});

test("debitTokens rounds up to the next whole token", () => {
	const rate = { inputUsdPerMtok: 0.375, outputUsdPerMtok: 1.5 };

	// 2 * 1 * 0.375 / 1.875 = 0.4, which charges a whole token.
	assert.equal(debitTokens(rate, 1, 0), 1);

	// 2 * 3 * 0.375 / 1.875 = 1.2, which charges two.
	assert.equal(debitTokens(rate, 3, 0), 2);
	assert.equal(debitTokens(rate, 0, 0), 0);
});

test("formatBar at the boundaries", () => {
	assert.equal(formatBar(500_000, 500_000), "▰▰▰▰▰ ~500k/500k tok");
	assert.equal(formatBar(310_000, 500_000), "▰▰▰▱▱ ~310k/500k tok");
	assert.equal(formatBar(0, 500_000), "▱▱▱▱▱ ~0/500k tok");
});

test("formatBar colors green over half, yellow under half, red under 20 percent", () => {
	const color = (remaining: number) => /^<(\w+)>/.exec(formatBar(remaining, 100, tag))?.[1];

	assert.equal(color(100), "success");
	assert.equal(color(51), "success");
	assert.equal(color(50), "warning");
	assert.equal(color(20), "warning");
	assert.equal(color(19), "error");
	assert.equal(color(0), "error");
});

test("formatBar clamps a remainder outside the range", () => {
	assert.equal(formatBar(700_000, 500_000), "▰▰▰▰▰ ~700k/500k tok");
	assert.equal(formatBar(-5, 500_000), "▱▱▱▱▱ ~0/500k tok");
	assert.match(formatBar(700_000, 500_000, tag), /^<success>/);
	assert.match(formatBar(-5, 500_000, tag), /^<error>/);
});

test("formatTokens abbreviates thousands and millions", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(310_400), "310k");
	assert.equal(formatTokens(1_500_000), "1.5M");
	assert.equal(formatTokens(999_700), "1M");
});

test("formatFooter appends the bar after the existing pieces", () => {
	assert.equal(
		formatFooter(10_000, 80_400, { outSat: 7_000, inSat: 0 }, "▰▰▰▱▱ ~310k/500k tok"),
		"⚡ 10,000 sat ($8.04) · 7,000 pending · ▰▰▰▱▱ ~310k/500k tok",
	);
	assert.equal(formatFooter(10_000), "⚡ 10,000 sat");
});

test("applyUsage debits and floors at zero, and a new bundle starts full", () => {
	const rate = parseModelRate(rateFile, MODEL) as NonNullable<ReturnType<typeof parseModelRate>>;
	const fresh = startBundle(MODEL, rate, 1_000);
	assert.equal(fresh.remaining, 500_000);

	const used = applyUsage(fresh, 2_000, 500);
	assert.equal(used.remaining, 498_400);
	assert.equal(applyUsage(used, 10_000_000, 0).remaining, 0);
});

test("isBundleExpired follows bundleValidDays", () => {
	const rate = parseModelRate(rateFile, MODEL) as NonNullable<ReturnType<typeof parseModelRate>>;
	const state = startBundle(MODEL, rate, 0);
	assert.equal(isBundleExpired(state, 30 * DAY - 1), false);
	assert.equal(isBundleExpired(state, 30 * DAY), true);
});

test("FileBundleStore round-trips and a corrupt file reads as empty", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi402-bundle-"));
	const store = new FileBundleStore(join(dir, "nested", "bundles.json"));
	const rate = parseModelRate(rateFile, MODEL) as NonNullable<ReturnType<typeof parseModelRate>>;
	const state = applyUsage(startBundle(MODEL, rate, 5), 1_000, 0);

	assert.equal(await store.get("a"), undefined);
	await store.put("a", state);
	await store.put("b", state);
	assert.deepEqual(await store.get("a"), state);

	await store.delete("a");
	assert.equal(await store.get("a"), undefined);
	assert.deepEqual(await store.get("b"), state);

	const corrupt = new FileBundleStore(join(dir, "bad.json"));
	await (await import("node:fs/promises")).writeFile(join(dir, "bad.json"), "{nope");
	assert.equal(await corrupt.get("a"), undefined);
});

test("a restart keeps the estimate, and an expired bundle shows nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi402-bundle-"));
	const path = join(dir, "bundles.json");
	let now = 1_000;
	const fetchFn = (async () => jsonResponse(rateFile)) as typeof fetch;

	const first = new BundleTracker("https://s.example", new FileBundleStore(path), fetchFn, () => now);
	await first.start(MODEL);
	await first.debit(MODEL, 2_000, 500);

	// A new tracker over the same file is a restart. It does not need the
	// network, and the estimate is not reset to full.
	const offline = (async () => {
		throw new Error("offline");
	}) as typeof fetch;
	const second = new BundleTracker("https://s.example", new FileBundleStore(path), offline, () => now);
	assert.equal((await second.current(MODEL))?.remaining, 498_400);
	await second.debit(MODEL, 2_000, 500);
	assert.equal((await second.current(MODEL))?.remaining, 496_800);

	now += 30 * DAY;
	assert.equal(await second.current(MODEL), undefined);

	// Usage against an expired bundle changes nothing.
	await second.debit(MODEL, 1_000, 0);
	now = 1_000;
	assert.equal((await second.current(MODEL))?.remaining, 496_800);
});

test("a new payment resets the estimate to full", async () => {
	const fetchFn = (async () => jsonResponse(rateFile)) as typeof fetch;
	const tracker = new BundleTracker("https://s.example", new MemoryBundleStore(), fetchFn);
	await tracker.start(MODEL);
	await tracker.debit(MODEL, 100_000, 0);
	assert.equal((await tracker.current(MODEL))?.remaining, 460_000);

	await tracker.start(MODEL);
	assert.equal((await tracker.current(MODEL))?.remaining, 500_000);
});

test("the rate file is fetched once per origin and cached", async () => {
	const urls: string[] = [];
	const fetchFn = (async (url: string) => {
		urls.push(url);
		return jsonResponse(rateFile);
	}) as unknown as typeof fetch;
	const tracker = new BundleTracker("https://s.example", new MemoryBundleStore(), fetchFn);

	await tracker.start(MODEL);
	await tracker.start(MODEL);
	assert.deepEqual(urls, ["https://s.example/pi402.json"]);
});

test("a failed fetch shows no bar, drops a replaced estimate, and is retried", async () => {
	const store = new MemoryBundleStore();
	let healthy = true;
	let calls = 0;
	const fetchFn = (async () => {
		calls++;
		if (!healthy) {
			throw new Error("down");
		}
		return jsonResponse(rateFile);
	}) as typeof fetch;
	const tracker = new BundleTracker("https://s.example", store, fetchFn);

	await tracker.start(MODEL);
	assert.ok(await tracker.current(MODEL));

	// The next bundle is bought while the seller's file is unreachable. The
	// old estimate describes a replaced bundle, so it must not linger. The
	// cached file still serves, so exercise a fresh tracker for the failure.
	const cold = new BundleTracker("https://s.example", store, (async () => {
		throw new Error("down");
	}) as typeof fetch);
	await cold.start(MODEL);
	assert.equal(await cold.current(MODEL), undefined);

	// A non-OK response and a missing model also mean no bar.
	const notOk = new BundleTracker("https://s.example", new MemoryBundleStore(), (async () =>
		jsonResponse({}, false)) as typeof fetch);
	await notOk.start(MODEL);
	assert.equal(await notOk.current(MODEL), undefined);
	const missing = new BundleTracker("https://s.example", new MemoryBundleStore(), (async () =>
		jsonResponse(rateFile)) as typeof fetch);
	await missing.start("other");
	assert.equal(await missing.current("other"), undefined);

	// A failure is not cached: the same tracker recovers once the seller does.
	healthy = false;
	const flaky = new BundleTracker("https://s.example", new MemoryBundleStore(), fetchFn);
	await flaky.start(MODEL);
	assert.equal(await flaky.current(MODEL), undefined);
	healthy = true;
	await flaky.start(MODEL);
	assert.ok(await flaky.current(MODEL));
	assert.equal(calls, 3);
});

test("the provider reports usage for a response that carries it", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (c: object) => res.write(`data: ${JSON.stringify(c)}\n\n`);
		chunk({ id: "1", choices: [{ index: 0, delta: { content: "hi" } }] });
		chunk({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		chunk({ id: "1", choices: [], usage: { prompt_tokens: 2_000, completion_tokens: 500, total_tokens: 2_500 } });
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;

	const requests: string[] = [];
	const usages: [string, number, number][] = [];
	const streamSimple = makeStreamSimple({
		payer: new MockInvoicePayer(),
		policy: { assertCanPay: async () => {} } as never,
		onRequest: (model) => requests.push(model),
		onUsage: (model, p, c) => usages.push([model, p, c]),
	});
	const model = {
		id: MODEL,
		api: "l402-openai",
		provider: "pi402",
		baseUrl: `http://127.0.0.1:${port}/api/v1`,
		maxTokens: 3_000,
	};

	try {
		const stream = streamSimple(model as never, { messages: [] } as never);
		for await (const _event of stream) {
			// Drain.
		}
	} finally {
		server.close();
	}

	assert.deepEqual(requests, [MODEL]);
	assert.deepEqual(usages, [[MODEL, 2_000, 500]]);
});

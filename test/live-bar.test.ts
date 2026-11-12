import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { estimateTokens, StreamProjection, throttle } from "../src/bundle.ts";
import extension from "../src/index.ts";
import { MockInvoicePayer } from "../src/payer.ts";
import { makeStreamSimple } from "../src/provider.ts";

const MODEL = "deepseek-v4-1-flash";
const WALLET_KEY = Symbol.for("pi-402.walletService");

// Rates of 1 and 3 weight the completion three times the prompt:
// debit = ceil(2 * (p * 1 + c * 3) / 4).
const RATE = { inputUsdPerMtok: 1, outputUsdPerMtok: 3 };
const EVEN = { inputUsdPerMtok: 1, outputUsdPerMtok: 1 };

test("estimateTokens is a quarter of the count, rounded up", () => {
	assert.equal(estimateTokens(0), 0);
	assert.equal(estimateTokens(1), 1);
	assert.equal(estimateTokens(4), 1);
	assert.equal(estimateTokens(5), 2);
});

test("the projection debits the prompt alone before any token streams", () => {
	const live = new StreamProjection();
	const stream = {};
	live.update(stream, MODEL, 1_000, 0);

	// ceil(2 * 1000 / 4) = 500.
	assert.equal(live.debit(RATE, MODEL), 500);
	assert.equal(live.project({ remaining: 10_000, ...RATE }, MODEL), 9_500);
});

test("the projection adds the completion estimate with the output weight", () => {
	const live = new StreamProjection();
	live.update({}, MODEL, 1_000, 200);

	// ceil(2 * (1000 + 600) / 4) = 800.
	assert.equal(live.debit(RATE, MODEL), 800);
	assert.equal(live.project({ remaining: 10_000, ...RATE }, MODEL), 9_200);

	// With even rates the weights drop out: 1000 + 200.
	assert.equal(live.debit(EVEN, MODEL), 1_200);
});

test("the projection clamps at zero", () => {
	const live = new StreamProjection();
	live.update({}, MODEL, 50_000, 50_000);
	assert.equal(live.project({ remaining: 10_000, ...EVEN }, MODEL), 0);
});

test("a growing update replaces the stream's estimate rather than adding to it", () => {
	const live = new StreamProjection();
	const stream = {};
	live.update(stream, MODEL, 100, 0);
	live.update(stream, MODEL, 100, 40);
	assert.equal(live.debit(EVEN, MODEL), 140);
});

test("concurrent streams are summed, and a dropped one stops counting", () => {
	const live = new StreamProjection();
	const a = {};
	const b = {};
	live.update(a, MODEL, 100, 10);
	live.update(b, MODEL, 200, 30);
	live.update({}, "other-model", 9_999, 9_999);

	// Each stream is debited on its own, then summed; other models are
	// ignored.
	assert.equal(live.debit(EVEN, MODEL), 110 + 230);

	live.drop(a);
	assert.equal(live.debit(EVEN, MODEL), 230);
	live.drop(b);
	assert.equal(live.debit(EVEN, MODEL), 0);
});

test("the throttle runs at once, then coalesces calls into one trailing run", () => {
	let clock = 1_000;
	const timers: { cb: () => void; ms: number }[] = [];
	let runs = 0;
	const t = throttle(
		() => runs++,
		250,
		() => clock,
		(cb, ms) => {
			const entry = { cb, ms };
			timers.push(entry);
			return () => timers.splice(timers.indexOf(entry), 1);
		},
	);

	t.call();
	assert.equal(runs, 1);

	// Calls inside the interval coalesce into a single timer.
	clock += 100;
	t.call();
	t.call();
	t.call();
	assert.equal(runs, 1);
	assert.equal(timers.length, 1);
	assert.equal(timers[0].ms, 150);

	clock += 150;
	timers[0].cb();
	assert.equal(runs, 2);

	// Past the interval a call runs immediately again.
	clock += 300;
	t.call();
	assert.equal(runs, 3);
});

test("the throttle can be cancelled and survives a throwing function", () => {
	let clock = 0;
	const timers: (() => void)[] = [];
	let cancelled = 0;
	const t = throttle(
		() => {
			throw new Error("no ui");
		},
		250,
		() => clock,
		(cb) => {
			timers.push(cb);
			return () => cancelled++;
		},
	);

	t.call();
	clock += 10;
	t.call();
	t.cancel();
	assert.equal(cancelled, 1);

	// A new call after the cancel schedules afresh.
	t.call();
	assert.equal(timers.length, 2);
});

// sseServer serves one scripted SSE response per request. The script receives
// a write function and returns when the response should end.
async function sseServer(
	script: (write: (chunk: object) => void, res: import("node:http").ServerResponse) => Promise<void>,
	status = 200,
): Promise<{ server: Server; port: number; bodies: string[] }> {
	const bodies: string[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => {
			body += d;
		});
		req.on("end", async () => {
			bodies.push(body);
			if (status !== 200) {
				res.writeHead(status, { "content-type": "application/json" });
				res.end('{"error":"nope"}');
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			await script((c) => res.write(`data: ${JSON.stringify(c)}\n\n`), res);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: (server.address() as { port: number }).port, bodies };
}

const delta = (d: object) => ({ id: "1", choices: [{ index: 0, delta: d }] });
const usage = (p: number, c: number) => ({
	id: "1",
	choices: [],
	usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
});

type Event = [string, ...unknown[]];

// run drives the provider against a scripted server and records the hooks.
async function run(
	script: Parameters<typeof sseServer>[0],
	opts: { status?: number; signal?: AbortSignal } = {},
): Promise<{ events: Event[]; bodies: string[] }> {
	const { server, port, bodies } = await sseServer(script, opts.status);
	const events: Event[] = [];
	const streamSimple = makeStreamSimple({
		payer: new MockInvoicePayer(),
		policy: { assertCanPay: async () => {} } as never,
		onProgress: (m, p, c) => events.push(["progress", m, p, c]),
		onUsage: (m, p, c) => events.push(["usage", m, p, c]),
		onStreamEnd: (m, _s, outcome) => events.push(["end", m, outcome]),
	});
	const model = {
		id: MODEL,
		api: "l402-openai",
		provider: "pi402",
		baseUrl: `http://127.0.0.1:${port}/api/v1`,
		maxTokens: 3_000,
	};
	try {
		for await (const _e of streamSimple(model as never, { messages: [] } as never, { signal: opts.signal })) {
			// Drain.
		}
	} finally {
		server.close();
	}
	return { events, bodies };
}

test("the provider reports a prompt estimate first, then a growing completion estimate", async () => {
	const { events, bodies } = await run(async (write) => {
		write(delta({ reasoning_content: "x".repeat(9) }));
		write(delta({ content: "y".repeat(8) }));
		write(usage(30, 5));
	});

	const promptEstimate = Math.ceil(Buffer.byteLength(bodies[0]) / 4);
	assert.deepEqual(events, [
		["progress", MODEL, promptEstimate, 0],
		// Nine reasoning characters round up to three tokens.
		["progress", MODEL, promptEstimate, 3],
		// Seventeen characters in all round up to five.
		["progress", MODEL, promptEstimate, 5],
		["usage", MODEL, 30, 5],
	]);
});

test("a stream that ends without usage is reported as no-usage", async () => {
	const { events } = await run(async (write) => {
		write(delta({ content: "hello" }));
	});
	assert.deepEqual(events.at(-1), ["end", MODEL, "no-usage"]);
	assert.ok(!events.some((e) => e[0] === "usage"));
});

test("an aborted stream is reported as no-usage", async () => {
	const ctl = new AbortController();
	const { events } = await run(
		async (write) => {
			write(delta({ content: "hello" }));
			await new Promise((r) => setTimeout(r, 50));
			ctl.abort();
			await new Promise((r) => setTimeout(r, 50));
		},
		{ signal: ctl.signal },
	);
	assert.deepEqual(events.at(-1), ["end", MODEL, "no-usage"]);
});

test("an error response is reported as failed with nothing streamed", async () => {
	const { events } = await run(async () => {}, { status: 500 });
	assert.deepEqual(events.at(-1), ["end", MODEL, "failed"]);
	assert.ok(events.every((e) => e[0] !== "progress" || e[3] === 0));
});

test("a throwing live hook never reaches the response", async () => {
	const { server, port } = await sseServer(async (write) => {
		write(delta({ content: "hi" }));
		write(usage(1, 1));
	});
	const streamSimple = makeStreamSimple({
		payer: new MockInvoicePayer(),
		policy: { assertCanPay: async () => {} } as never,
		onProgress: () => {
			throw new Error("boom");
		},
		onUsage: () => {
			throw new Error("boom");
		},
	});
	const model = {
		id: MODEL,
		api: "l402-openai",
		provider: "pi402",
		baseUrl: `http://127.0.0.1:${port}/api/v1`,
		maxTokens: 3_000,
	};
	let last = "";
	try {
		for await (const e of streamSimple(model as never, { messages: [] } as never)) {
			last = e.type;
		}
	} finally {
		server.close();
	}
	assert.equal(last, "done");
});

// The integration half drives the whole extension against a local SSE server
// and watches the footer.

const saved = { fetch: globalThis.fetch, env: { ...process.env } };

beforeEach(async () => {
	process.env.PI402_DATA_DIR = await mkdtemp(join(tmpdir(), "pi402-live-"));
	delete process.env.PI402_MOCK_PAYER;
	delete process.env.PI402_WALLETD_GATEWAY;
	delete (globalThis as any)[WALLET_KEY];
	// The footer's dollar rate must never reach the network; local servers
	// are reachable.
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith("http://127.0.0.1")) {
			throw new Error("offline");
		}
		return saved.fetch(input, init);
	}) as typeof fetch;
	(globalThis as any).wavewalletdkCall = async (method: string) =>
		method === "status" ? { Ready: true, Balance: { ConfirmedSat: 10_000, PendingOutSat: 0 } } : {};
});

afterEach(() => {
	globalThis.fetch = saved.fetch;
	process.env = { ...saved.env };
	delete (globalThis as any)[WALLET_KEY];
	delete (globalThis as any).wavewalletdkCall;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// bootExtension loads the extension against a proxy at the given port, with a
// persisted bundle of 100k tokens at even rates, and returns the registered
// streamSimple and the footer statuses.
async function bootExtension(port: number) {
	process.env.L402_PROXY_URL = `http://127.0.0.1:${port}`;
	const dir = process.env.PI402_DATA_DIR as string;
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "bundles.json"),
		JSON.stringify({
			version: 1,
			bundles: {
				[`http://127.0.0.1:${port}|${MODEL}`]: {
					model: MODEL,
					bundleTokens: 100_000,
					remaining: 100_000,
					startedAt: Date.now(),
					validDays: 30,
					...EVEN,
				},
			},
		}),
	);

	let streamSimple: any;
	const handlers = new Map<string, (e: any, c: any) => Promise<void> | void>();
	extension({
		on: (name: string, h: any) => handlers.set(name, h),
		registerProvider: (_id: string, cfg: any) => {
			streamSimple = cfg.streamSimple;
		},
		registerCommand: () => {},
	} as never);

	const statuses: string[] = [];
	let uiBroken = false;
	await handlers.get("session_start")?.(
		{},
		{
			ui: {
				setStatus: (_k: string, t: string) => {
					if (uiBroken) {
						throw new Error("stale session");
					}
					statuses.push(t);
				},
				notify: () => {},
			},
			model: { provider: "pi402", id: MODEL },
		},
	);
	const model = {
		id: MODEL,
		api: "l402-openai",
		provider: "pi402",
		baseUrl: `http://127.0.0.1:${port}/api/v1`,
		maxTokens: 3_000,
	};
	const drain = async () => {
		for await (const _e of streamSimple(model, { messages: [] })) {
			// Drain.
		}
	};
	const persisted = async () => {
		const file = JSON.parse(await readFile(join(dir, "bundles.json"), "utf8"));
		return file.bundles[`http://127.0.0.1:${port}|${MODEL}`].remaining as number;
	};
	return {
		statuses,
		drain,
		persisted,
		breakUi: () => {
			uiBroken = true;
		},
	};
}

// gate lets a test hold the server between deltas.
function gate() {
	let open!: () => void;
	const wait = new Promise<void>((r) => {
		open = r;
	});
	return { wait, open };
}

const bar = (statuses: string[]) => statuses.at(-1)?.match(/~\d+k/)?.[0];

test("the footer ticks down between deltas, then lands on the exact usage", async () => {
	const first = gate();
	const second = gate();
	const { server, port } = await sseServer(async (write) => {
		write(delta({ content: "a".repeat(40_000) }));
		await first.wait;
		write(delta({ content: "b".repeat(40_000) }));
		await second.wait;
		write(usage(30, 5_000));
	});

	try {
		const ext = await bootExtension(port);
		assert.equal(bar(ext.statuses), "~100k");

		const done = ext.drain();
		await sleep(400);

		// Ten thousand completion tokens have streamed.
		assert.equal(bar(ext.statuses), "~90k");
		first.open();
		await sleep(400);
		assert.equal(bar(ext.statuses), "~80k");

		// Nothing is persisted from the projection.
		assert.equal(await ext.persisted(), 100_000);

		second.open();
		await done;
		await sleep(50);

		// The exact debit replaces the projection: 30 + 5000 tokens.
		assert.equal(bar(ext.statuses), "~95k");
		assert.equal(await ext.persisted(), 100_000 - 5_030);
	} finally {
		server.close();
	}
});

test("a stream that ends without usage settles at its estimate and persists it", async () => {
	const { server, port, bodies } = await sseServer(async (write) => {
		write(delta({ content: "a".repeat(40_000) }));
	});

	try {
		const ext = await bootExtension(port);
		await ext.drain();
		await sleep(50);

		// Prompt estimate plus ten thousand completion tokens.
		const expected = 100_000 - Math.ceil(Buffer.byteLength(bodies[0]) / 4) - 10_000;
		assert.equal(await ext.persisted(), expected);
		assert.equal(bar(ext.statuses), "~90k");
	} finally {
		server.close();
	}
});

test("an error response leaves the bundle and the bar untouched", async () => {
	const { server, port } = await sseServer(async () => {}, 500);

	try {
		const ext = await bootExtension(port);
		await ext.drain();
		await sleep(50);

		assert.equal(await ext.persisted(), 100_000);
		assert.equal(bar(ext.statuses), "~100k");
	} finally {
		server.close();
	}
});

test("two concurrent streams are both projected and neither is counted twice", async () => {
	const hold = gate();
	const { server, port } = await sseServer(async (write) => {
		write(delta({ content: "a".repeat(40_000) }));
		await hold.wait;
		write(usage(0, 10_000));
	});

	try {
		const ext = await bootExtension(port);
		const one = ext.drain();
		const two = ext.drain();
		await sleep(500);

		// Two streams of ten thousand tokens each.
		assert.equal(bar(ext.statuses), "~80k");

		hold.open();
		await Promise.all([one, two]);
		await sleep(50);

		assert.equal(bar(ext.statuses), "~80k");
		assert.equal(await ext.persisted(), 80_000);
	} finally {
		server.close();
	}
});

test("a UI that throws on every redraw cannot disturb the stream or the debit", async () => {
	const { server, port } = await sseServer(async (write) => {
		write(delta({ content: "a".repeat(400) }));
		write(usage(10, 100));
	});

	try {
		const ext = await bootExtension(port);
		ext.breakUi();
		await ext.drain();
		await sleep(50);
		assert.equal(await ext.persisted(), 100_000 - 110);
	} finally {
		server.close();
	}
});

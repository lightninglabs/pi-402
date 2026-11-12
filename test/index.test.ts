import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import extension from "../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<void> | void;

// WALLET_KEY mirrors the globalThis key the process-wide wallet lives under.
const WALLET_KEY = Symbol.for("pi-402.walletService");

// fakeRuntime installs a stand-in for the embedded wallet runtime's dispatcher
// and records every verb the extension sends it. Like the real runtime, it
// refuses a second start.
function fakeRuntime(balance: () => number, pendingOutSat = 0) {
	const calls: string[] = [];
	let started = false;
	(globalThis as any).wavewalletdkCall = async (method: string) => {
		calls.push(method);
		switch (method) {
			case "start":
				if (started) {
					throw new Error("wavewalletdk mobile already started");
				}
				started = true;
				return {};
			case "status":
				return { Ready: true, Balance: { ConfirmedSat: balance(), PendingOutSat: pendingOutSat } };
			default:
				return {};
		}
	};
	return calls;
}

// loadExtension runs the extension factory against a fake Pi, as Pi does on
// every session it creates, and returns the handlers it registered.
function loadExtension() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerProvider: () => {},
		registerCommand: () => {},
	};
	extension(pi as any);
	return handlers;
}

// fakeUi records the footer statuses it is handed.
function fakeUi() {
	const statuses: string[] = [];
	return {
		statuses,
		ctx: { ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify: () => {} } },
	};
}

const saved = {
	fetch: globalThis.fetch,
	env: { ...process.env },
};

beforeEach(async () => {
	process.env.PI402_DATA_DIR = await mkdtemp(join(tmpdir(), "pi402-index-"));
	delete process.env.PI402_MOCK_PAYER;
	delete process.env.PI402_WALLETD_GATEWAY;
	delete (globalThis as any)[WALLET_KEY];
	delete (globalThis as any).wavewalletdkCall;

	// The footer's dollar rate must never reach the network.
	globalThis.fetch = (async () => {
		throw new Error("offline");
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = saved.fetch;
	process.env = { ...saved.env };
	delete (globalThis as any)[WALLET_KEY];
	delete (globalThis as any).wavewalletdkCall;
});

test("re-running the factory after /new starts the runtime exactly once", async () => {
	const calls = fakeRuntime(() => 1_000);

	// Pi's first session, then the session replaced by /new: the factory
	// runs again and session_start fires on the new instance.
	await loadExtension().get("session_start")?.({}, fakeUi().ctx);
	await loadExtension().get("session_start")?.({}, fakeUi().ctx);

	assert.equal(calls.filter((c) => c === "start").length, 1);
});

test("the footer follows the new session's UI after /new", async () => {
	let balance = 1_000;
	fakeRuntime(() => balance);

	const first = fakeUi();
	await loadExtension().get("session_start")?.({}, first.ctx);
	assert.equal(first.statuses.length, 1);

	balance = 2_500;
	const second = fakeUi();
	await loadExtension().get("session_start")?.({}, second.ctx);

	// The new handle gets the balance, and the old one is left alone.
	assert.equal(second.statuses.length, 1);
	assert.match(second.statuses[0], /2,500 sat/);
	assert.equal(first.statuses.length, 1);
});

test("a replaced session's shutdown leaves the wallet running, a quit stops it", async () => {
	const calls = fakeRuntime(() => 1_000);

	const first = loadExtension();
	await first.get("session_start")?.({}, fakeUi().ctx);
	await first.get("session_shutdown")?.({ reason: "new" }, {});
	assert.ok(!calls.includes("stop"));

	const second = loadExtension();
	await second.get("session_start")?.({}, fakeUi().ctx);
	await second.get("session_shutdown")?.({ reason: "quit" }, {});
	assert.ok(calls.includes("stop"));
});

test("the footer shows the spendable balance and the pending outbound amount apart", async () => {
	// Right after a payment the wallet reports nothing spendable and the sats
	// in flight as outgoing; the footer must not present those as available.
	fakeRuntime(() => 0, 7_000);

	const ui = fakeUi();
	await loadExtension().get("session_start")?.({}, ui.ctx);

	assert.equal(ui.statuses[0], "⚡ 0 sat · 7,000 pending");
});

test("the footer shows the persisted bundle bar, colored by the theme, after a restart", async () => {
	fakeRuntime(() => 10_000);
	delete process.env.L402_PROXY_URL;

	const { mkdir, writeFile } = await import("node:fs/promises");
	const dir = process.env.PI402_DATA_DIR as string;
	await mkdir(dir, { recursive: true });
	const bundle = {
		model: "deepseek-v4-1-flash",
		bundleTokens: 500_000,
		remaining: 310_000,
		startedAt: Date.now(),
		validDays: 30,
		inputUsdPerMtok: 0.375,
		outputUsdPerMtok: 1.5,
	};
	await writeFile(
		join(dir, "bundles.json"),
		JSON.stringify({ version: 1, bundles: { "http://localhost:8402|deepseek-v4-1-flash": bundle } }),
	);

	const ui = fakeUi();
	const ctx = {
		ui: { ...ui.ctx.ui, theme: { fg: (color: string, text: string) => `[${color}]${text}` } },
		model: { provider: "pi402", id: "deepseek-v4-1-flash" },
	};
	await loadExtension().get("session_start")?.({}, ctx);

	assert.equal(ui.statuses[0], "⚡ 10,000 sat · [success]▰▰▰▱▱ ~310k/500k tok");
});

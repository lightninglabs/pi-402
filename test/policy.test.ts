import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { buildBudgetPolicy, maxSatPerRequest, readSatCeiling } from "../src/policy.ts";

// buildBudgetPolicy takes an ExtensionAPI it never uses; a bare cast keeps the
// tests free of the Pi runtime.
const pi = {} as never;

// An assertAllowed context; host/url/routeId are unused by the budget policy.
function ctx(amountSat: number) {
	return { amountSat, host: "proxy.example", url: "https://proxy.example/v1" };
}

const ENV_KEYS = ["PI402_MAX_SAT_PER_REQUEST", "PI402_DAILY_CAP_SAT"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
});

test("readSatCeiling returns the fallback when unset", () => {
	assert.equal(readSatCeiling("PI402_MAX_SAT_PER_REQUEST", 1_000), 1_000);
});

test("readSatCeiling returns the fallback for an empty value", () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "";
	assert.equal(readSatCeiling("PI402_MAX_SAT_PER_REQUEST", 1_000), 1_000);
});

test("readSatCeiling parses a numeric value", () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "250";
	assert.equal(readSatCeiling("PI402_MAX_SAT_PER_REQUEST", 1_000), 250);
});

test("readSatCeiling throws on a comma-formatted number", () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "1,000";
	assert.throws(() => readSatCeiling("PI402_MAX_SAT_PER_REQUEST", 1_000), /must be a positive number/);
});

test("readSatCeiling throws on non-numeric junk", () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "lots";
	assert.throws(() => readSatCeiling("PI402_MAX_SAT_PER_REQUEST", 1_000), /must be a positive number/);
});

test("readSatCeiling throws on zero and negatives", () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "0";
	assert.throws(() => readSatCeiling("PI402_MAX_SAT_PER_REQUEST", 1_000), /must be a positive number/);
	process.env.PI402_MAX_SAT_PER_REQUEST = "-5";
	assert.throws(() => readSatCeiling("PI402_MAX_SAT_PER_REQUEST", 1_000), /must be a positive number/);
});

test("buildBudgetPolicy throws when a ceiling env is garbage", () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "1,000";
	assert.throws(() => buildBudgetPolicy(pi), /must be a positive number/);
});

test("maxSatPerRequest reflects the same env the policy reads", () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "777";
	assert.equal(maxSatPerRequest(), 777);
});

test("per-request cap rejects an over-ceiling payment", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "10000";
	const policy = buildBudgetPolicy(pi);
	await policy.assertAllowed(ctx(100));
	await assert.rejects(() => policy.assertAllowed(ctx(101)), /exceeds per-request cap/);
});

test("daily cap rejects once cumulative spend would exceed it", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "150";
	const policy = buildBudgetPolicy(pi);
	await policy.assertAllowed(ctx(100));
	await assert.rejects(() => policy.assertAllowed(ctx(60)), /exceed daily cap/);
	// A payment that still fits is allowed.
	await policy.assertAllowed(ctx(50));
});

test("daily cap is seeded from the spent-today source", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "150";

	// The ledger says 100 sats already went out today (a prior process), so
	// only 50 remain under the cap.
	const policy = buildBudgetPolicy(pi, { spentTodaySat: async () => 100 });
	await assert.rejects(() => policy.assertAllowed(ctx(60)), /exceed daily cap/);
	await policy.assertAllowed(ctx(50));
});

test("an unreadable spent-today source seeds zero", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "150";

	const policy = buildBudgetPolicy(pi, {
		spentTodaySat: async () => {
			throw new Error("ledger unreadable");
		},
	});
	// A broken ledger must not block inference; the caps still apply from a
	// zero base.
	await policy.assertAllowed(ctx(100));
});

test("daily counter resets at the UTC day boundary", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "100";

	// Freeze the clock on day one, spend to the cap, then advance a day. The
	// policy derives its day key from new Date().toISOString(), so a stub that
	// feeds super() a fixed epoch is enough to drive the boundary.
	const realDate = Date;
	let fakeNow = realDate.parse("2026-07-06T12:00:00.000Z");
	class FakeDate extends realDate {
		constructor() {
			super(fakeNow);
		}
	}
	// @ts-expect-error minimal Date stub for the day-key path used by the policy.
	globalThis.Date = FakeDate;
	try {
		const policy = buildBudgetPolicy(pi);
		await policy.assertAllowed(ctx(100));
		await assert.rejects(() => policy.assertAllowed(ctx(1)), /exceed daily cap/);

		// Roll to the next UTC day; the counter should reset and allow spend.
		fakeNow = realDate.parse("2026-07-07T00:00:01.000Z");
		await policy.assertAllowed(ctx(100));
	} finally {
		globalThis.Date = realDate;
	}
});

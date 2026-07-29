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

test("daily cap counts the ledger's spend on every assertion", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "150";

	// The ledger says 100 sats already went out today (a prior process), so
	// only 50 remain under the cap.
	const policy = buildBudgetPolicy(pi, { spentTodaySat: async () => 100 });
	await assert.rejects(() => policy.assertAllowed(ctx(60)), /exceed daily cap/);
	await policy.assertAllowed(ctx(50));
});

test("concurrent first assertions cannot race past the ledger", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "150";

	// A slow ledger read must not open a window where a second concurrent
	// assertion sees a stale base and slips under the cap.
	const slowLedger = {
		spentTodaySat: () => new Promise<number>((resolve) => setTimeout(() => resolve(100), 20)),
	};
	const policy = buildBudgetPolicy(pi, slowLedger);

	// The amounts are chosen so the two outcomes actually differ. With the
	// ledger at 100 and the cap at 150, exactly one 30-sat payment fits.
	// Under a check-then-update interleaving both assertions would read the
	// ledger's 100 before either incremented, both would compute 130, and
	// both would be allowed. Asserting one-of-each is what catches that; two
	// 60-sat payments would be rejected either way and prove nothing.
	const results = await Promise.allSettled([policy.assertAllowed(ctx(30)), policy.assertAllowed(ctx(30))]);
	const statuses = results.map((r) => r.status).sort();
	assert.deepEqual(statuses, ["fulfilled", "rejected"]);
});

test("a ledger that grows behind the process's back still counts", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "150";

	// Another session settles 120 sats between our assertions; the fresh
	// read on the next assertion must pick it up.
	let ledgerTotal = 0;
	const policy = buildBudgetPolicy(pi, { spentTodaySat: async () => ledgerTotal });

	await policy.assertAllowed(ctx(20));
	ledgerTotal = 120;
	await assert.rejects(() => policy.assertAllowed(ctx(40)), /exceed daily cap/);
});

test("an unreadable ledger degrades to the in-memory counter", async () => {
	process.env.PI402_MAX_SAT_PER_REQUEST = "100";
	process.env.PI402_DAILY_CAP_SAT = "150";

	const policy = buildBudgetPolicy(pi, {
		spentTodaySat: async () => {
			throw new Error("ledger unreadable");
		},
	});
	// A broken ledger must not block inference; the caps still apply from
	// the in-memory counter.
	await policy.assertAllowed(ctx(100));
	await assert.rejects(() => policy.assertAllowed(ctx(60)), /exceed daily cap/);
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

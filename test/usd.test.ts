import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFooter, formatUsd, parseSpot, SPOT_TTL_MS, SPOT_URL, SpotRate } from "../src/usd.ts";

// spotResponse builds a Coinbase-shaped fetch response.
function spotResponse(amount: string, ok = true): Response {
	return { ok, json: async () => ({ data: { base: "BTC", currency: "USD", amount } }) } as Response;
}

test("formatUsd rounds to cents and groups thousands", () => {
	assert.equal(formatUsd(7_000, 80_400), "$5.63");
	assert.equal(formatUsd(100_000_000, 80_400), "$80,400.00");
	assert.equal(formatUsd(0, 80_400), "$0.00");
});

test("formatUsd marks a non-zero balance worth under a cent", () => {
	assert.equal(formatUsd(1, 80_400), "<$0.01");
});

test("formatFooter omits the dollars when no rate is known", () => {
	assert.equal(formatFooter(7_000), "⚡ 7,000 sat");
	assert.equal(formatFooter(7_000, 80_400), "⚡ 7,000 sat ($5.63)");
});

test("formatFooter shows pending amounts after the spendable balance, only when non-zero", () => {
	// The dollar value stays on the spendable number, not the pending one.
	assert.equal(formatFooter(10_000, 80_400, { outSat: 7_000, inSat: 0 }), "⚡ 10,000 sat ($8.04) · 7,000 pending");
	assert.equal(formatFooter(10_000, 80_400, { outSat: 0, inSat: 2_000 }), "⚡ 10,000 sat ($8.04) · 2,000 arriving");
	assert.equal(
		formatFooter(0, undefined, { outSat: 7_000, inSat: 2_000 }),
		"⚡ 0 sat · 7,000 pending · 2,000 arriving",
	);
	assert.equal(formatFooter(10_000, 80_400, { outSat: 0, inSat: 0 }), "⚡ 10,000 sat ($8.04)");
});

test("parseSpot accepts a positive amount and rejects junk", () => {
	assert.equal(parseSpot({ data: { amount: "80400.12" } }), 80_400.12);
	assert.equal(parseSpot({ data: { amount: "abc" } }), undefined);
	assert.equal(parseSpot({ data: { amount: "0" } }), undefined);
	assert.equal(parseSpot({}), undefined);
	assert.equal(parseSpot(null), undefined);
});

test("SpotRate returns nothing at first, then the fetched rate and an update", async () => {
	let updates = 0;
	const urls: string[] = [];
	const spot = new SpotRate(
		async (url) => {
			urls.push(String(url));
			return spotResponse("80400");
		},
		() => updates++,
	);

	// The first call never waits: it starts the fetch and reports no rate.
	assert.equal(spot.rate(), undefined);
	await spot.refresh();
	assert.equal(spot.rate(), 80_400);
	assert.equal(updates, 2);
	assert.equal(urls[0], SPOT_URL);
});

test("SpotRate reuses the cache until the TTL passes", async () => {
	let clock = 1_000;
	let fetches = 0;
	const spot = new SpotRate(
		async () => {
			fetches++;
			return spotResponse(String(80_000 + fetches));
		},
		() => {},
		() => clock,
	);

	await spot.refresh();
	assert.equal(fetches, 1);

	clock += SPOT_TTL_MS - 1;
	assert.equal(spot.rate(), 80_001);
	assert.equal(fetches, 1);

	// Past the TTL the stale value is still returned while a refetch starts.
	clock += 1;
	assert.equal(spot.rate(), 80_001);
	assert.equal(fetches, 2);
});

test("SpotRate stays silent on a failing endpoint and keeps the last rate", async () => {
	const clock = 0;
	const responses: Array<() => Promise<Response>> = [
		async () => spotResponse("80400"),
		async () => {
			throw new Error("network down");
		},
		async () => spotResponse("oops", false),
	];
	const spot = new SpotRate(
		async () => (responses.shift() as () => Promise<Response>)(),
		() => {},
		() => clock,
	);

	await spot.refresh();
	await spot.refresh();
	await spot.refresh();
	assert.equal(spot.rate(), 80_400);
});

test("SpotRate with no successful fetch yields no rate", async () => {
	const spot = new SpotRate(async () => {
		throw new Error("timeout");
	});
	await spot.refresh();
	assert.equal(spot.rate(), undefined);
});

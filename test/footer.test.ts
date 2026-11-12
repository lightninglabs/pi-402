import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { refreshWhileEmpty } from "../src/footer.ts";

// The refresh timers are unref'd so they never hold Pi open, which would
// let the test runner's loop drain mid-test. A ref'd interval stands in for
// the host process.
let keepAlive: NodeJS.Timeout;
before(() => {
	keepAlive = setInterval(() => {}, 1_000);
});
after(() => clearInterval(keepAlive));

test("refreshWhileEmpty shows the balance once sync makes it non-zero", async () => {
	// The wallet reads zero until its sync finishes, then the real balance.
	const reads = [0, 0, 8_000, 9_999];
	const shown: number[] = [];
	await refreshWhileEmpty(
		async () => reads.shift() as number,
		(sat) => shown.push(sat),
		1,
		10,
	);

	// It stops at the first non-zero read instead of polling on.
	assert.deepEqual(shown, [0, 0, 8_000]);
});

test("refreshWhileEmpty gives up after the attempt bound on an empty wallet", async () => {
	let reads = 0;
	await refreshWhileEmpty(
		async () => {
			reads++;
			return 0;
		},
		() => {},
		1,
		4,
	);
	assert.equal(reads, 4);
});

test("refreshWhileEmpty survives a failed read", async () => {
	const results: Array<number | Error> = [new Error("not synced"), 5_000];
	const shown: number[] = [];
	await refreshWhileEmpty(
		async () => {
			const next = results.shift() as number | Error;
			if (next instanceof Error) {
				throw next;
			}
			return next;
		},
		(sat) => shown.push(sat),
		1,
		5,
	);
	assert.deepEqual(shown, [5_000]);
});

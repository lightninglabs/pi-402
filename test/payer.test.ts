import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSat } from "../src/format.ts";
import { WalletInvoicePayer } from "../src/payer.ts";

const INPUT = { invoice: "lnbc1", amountSat: 8000, challengeId: "c" };

function fakeWallet(result: { preimageHex: string; amountPaidSat: number } | Error) {
	return {
		payInvoice: async () => {
			if (result instanceof Error) {
				throw result;
			}
			return result;
		},
	} as any;
}

test("formatSat groups digits", () => {
	assert.equal(formatSat(58_000), "58,000");
	assert.equal(formatSat(7), "7");
});

test("the paid hook runs once after a successful payment with the amount paid", async () => {
	const paid: number[] = [];
	const seen = new Promise<void>((resolve) => {
		const payer = new WalletInvoicePayer(
			fakeWallet({ preimageHex: "aa", amountPaidSat: 8000 }),
			({ amountPaidSat }) => {
				paid.push(amountPaidSat);
				resolve();
			},
		);
		payer.payInvoice(INPUT);
	});

	await seen;
	assert.deepEqual(paid, [8000]);
});

test("the paid hook does not run when the payment fails", async () => {
	let called = false;
	const payer = new WalletInvoicePayer(fakeWallet(new Error("no route")), () => {
		called = true;
	});

	await assert.rejects(() => payer.payInvoice(INPUT), /no route/);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(called, false);
});

test("a throwing or slow hook neither fails nor delays the payment", async () => {
	const throwing = new WalletInvoicePayer(fakeWallet({ preimageHex: "bb", amountPaidSat: 9 }), () => {
		throw new Error("ui is gone");
	});
	assert.deepEqual(await throwing.payInvoice(INPUT), { preimageHex: "bb", amountPaidSat: 9 });

	const slow = new WalletInvoicePayer(
		fakeWallet({ preimageHex: "cc", amountPaidSat: 9 }),
		() => new Promise<void>(() => {}),
	);
	const result = await Promise.race([
		slow.payInvoice(INPUT),
		new Promise((r) => setTimeout(() => r("timed out"), 500)),
	]);
	assert.deepEqual(result, { preimageHex: "cc", amountPaidSat: 9 });
});

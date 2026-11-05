import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWalletStatus, parseFundAmount } from "../src/commands.ts";

test("parseFundAmount reads a plain sat amount", () => {
	assert.equal(parseFundAmount("50000"), 50_000);
	assert.equal(parseFundAmount("  50000  "), 50_000);
	assert.equal(parseFundAmount("1"), 1);
});

test("parseFundAmount tolerates grouped digits", () => {
	assert.equal(parseFundAmount("50_000"), 50_000);
	assert.equal(parseFundAmount("50,000"), 50_000);
	assert.equal(parseFundAmount("1_000_000"), 1_000_000);
});

test("parseFundAmount rejects anything that is not a positive whole sat count", () => {
	// A missing argument is the common case: /fund with no amount.
	assert.equal(parseFundAmount(""), null);
	assert.equal(parseFundAmount("   "), null);

	// Rejecting these matters because the value is handed to a wallet: a
	// negative or fractional amount is a request the daemon cannot honour, and
	// silently coercing it would fund the wrong number.
	assert.equal(parseFundAmount("-5000"), null);
	assert.equal(parseFundAmount("0"), null);
	assert.equal(parseFundAmount("1.5"), null);
	assert.equal(parseFundAmount("5000 sats"), null);
	assert.equal(parseFundAmount("lots"), null);

	// Exponent and hex forms coerce under Number() but are not what anyone
	// means by a sat amount, so the digit check must reject them first.
	assert.equal(parseFundAmount("1e6"), null);
	assert.equal(parseFundAmount("0x10"), null);

	// Beyond the safe-integer range the value can no longer round-trip, so it
	// must not reach the wallet.
	assert.equal(parseFundAmount("9".repeat(20)), null);
});

const empty = {
	ready: true,
	network: "signet",
	spendableSat: 0,
	arrivingSat: 0,
	outgoingSat: 0,
	creditSat: 0,
};

test("formatWalletStatus shows an empty wallet and how to fund it", () => {
	const text = formatWalletStatus(empty);
	assert.match(text, /^pi-402 wallet \(signet\)\n {2}spendable {2}0 sat/);
	assert.match(text, /The wallet is empty\. Run \/fund <sats>/);
	assert.doesNotMatch(text, /arriving|outgoing|credit/);
});

test("formatWalletStatus never calls a wallet that is still syncing empty", () => {
	const text = formatWalletStatus({ ...empty, ready: false });
	assert.match(text, /still starting up or syncing/);
	assert.doesNotMatch(text, /The wallet is empty/);
});

test("formatWalletStatus shows a deposit that is still arriving", () => {
	const text = formatWalletStatus({ ...empty, arrivingSat: 50_000 });
	assert.match(text, / {2}arriving {3}50,000 sat/);
	assert.match(text, /Deposit on the way: spendable once it confirms/);
	assert.doesNotMatch(text, /The wallet is empty/);
});

test("formatWalletStatus shows a top-up arriving on a funded wallet", () => {
	const text = formatWalletStatus({ ...empty, spendableSat: 49_745, arrivingSat: 50_000 });
	assert.match(text, / {2}spendable {2}49,745 sat\n {2}arriving {3}50,000 sat/);
	assert.match(text, /Deposit on the way: spendable once it confirms/);
});

test("formatWalletStatus does not call a wallet with credit empty", () => {
	const text = formatWalletStatus({ ...empty, creditSat: 500 });
	assert.match(text, / {2}credit {5}500 sat/);
	assert.doesNotMatch(text, /The wallet is empty/);
});

test("formatWalletStatus shows a funded wallet without a hint", () => {
	const text = formatWalletStatus({
		...empty,
		network: "mainnet",
		spendableSat: 49_745,
		outgoingSat: 8_000,
		creditSat: 120,
	});
	assert.equal(
		text,
		["pi-402 wallet (mainnet)", "  spendable  49,745 sat", "  outgoing   8,000 sat", "  credit     120 sat"].join(
			"\n",
		),
	);
});

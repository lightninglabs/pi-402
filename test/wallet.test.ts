import assert from "node:assert/strict";
import { test } from "node:test";
import { WalletService } from "../src/wallet.ts";

// A wallet that was never started has neither backend wired, so any call that
// reaches one fails with "wallet not started". These tests lean on that: if
// the amount guard rejects first, the backend is never consulted, which is
// exactly the property worth pinning down for a funding amount.
test("receiveInvoice rejects a non-positive or fractional amount before touching the wallet", async () => {
	const wallet = new WalletService();

	for (const bad of [0, -1, -50_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await assert.rejects(
			() => wallet.receiveInvoice(bad),
			/funding amount must be a positive whole number of sats/,
			`expected ${bad} to be refused`,
		);
	}
});

test("receiveInvoice passes a valid amount through to the backend", async () => {
	const wallet = new WalletService();

	// A well-formed amount clears the guard and reaches the backend, which is
	// absent here. Seeing the "not started" error (and not the guard's) proves
	// the guard let it through rather than silently swallowing it.
	await assert.rejects(() => wallet.receiveInvoice(50_000), /wallet not started/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFundAmount, parseSendInvoice } from "../src/commands.ts";

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

// A real signet-shaped invoice body: the checksum is not verified here, only the
// shape, so this is just a long enough bech32 string with the right prefix.
const SAMPLE_BODY =
	"pp5c52kh56u268nk2872alv5r2ecktkglj8sdwncgqndfxdhp3as5kqdpzwp5j6dpsxgs8wctvd3jhggrxw4hxg6twvucqzpgxqrrss";

test("parseSendInvoice accepts a bolt11 invoice, with or without the lightning: scheme", () => {
	const invoice = `lnbc100u1${SAMPLE_BODY}`;
	assert.equal(parseSendInvoice(invoice), invoice);
	assert.equal(parseSendInvoice(`  ${invoice}\n`), invoice);
	assert.equal(parseSendInvoice(`lightning:${invoice}`), invoice);
	assert.equal(parseSendInvoice(invoice.toUpperCase()), invoice);
	assert.equal(parseSendInvoice(`lntbs1p${SAMPLE_BODY}`), `lntbs1p${SAMPLE_BODY}`);
});

test("parseSendInvoice rejects anything that is not an invoice", () => {
	for (const bad of ["", "   ", "50000", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "lnbc100u1short", "send me"]) {
		assert.equal(parseSendInvoice(bad), null, JSON.stringify(bad));
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { NdjsonFramer, preimageFromFrame } from "../src/wallet.ts";

test("NdjsonFramer reassembles a line split across chunks", () => {
	const framer = new NdjsonFramer();
	// The first chunk carries only part of the JSON object; no line yet.
	assert.deepEqual(framer.push('{"result":{"progr'), []);
	// The second chunk completes the object and its terminating newline.
	assert.deepEqual(framer.push('ess":{"payment_hash":"ab"}}}\n'), ['{"result":{"progress":{"payment_hash":"ab"}}}']);
});

test("NdjsonFramer emits multiple lines from one chunk and holds the tail", () => {
	const framer = new NdjsonFramer();
	const lines = framer.push('{"a":1}\n{"b":2}\n{"c":3');
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
	// The unterminated third object stays buffered until its newline arrives.
	assert.deepEqual(framer.push("}\n"), ['{"c":3}']);
});

test("NdjsonFramer drops blank lines", () => {
	const framer = new NdjsonFramer();
	assert.deepEqual(framer.push("\n\n"), []);
});

test("preimageFromFrame returns the preimage for the matching settled entry", () => {
	const frame = { result: { progress: { payment_hash: "hash1", preimage: "deadbeef" } } };
	assert.equal(preimageFromFrame(frame, "hash1"), "deadbeef");
});

test("preimageFromFrame ignores entries for other payment hashes", () => {
	const frame = { result: { progress: { payment_hash: "other", preimage: "deadbeef" } } };
	assert.equal(preimageFromFrame(frame, "hash1"), undefined);
});

test("preimageFromFrame returns undefined for a matching but not-yet-settled entry", () => {
	const frame = { result: { progress: { payment_hash: "hash1" } } };
	assert.equal(preimageFromFrame(frame, "hash1"), undefined);
});

test("preimageFromFrame throws on a failed send", () => {
	const frame = {
		result: { status: "ENTRY_STATUS_FAILED", failure_reason: "no route", progress: { payment_hash: "hash1" } },
	};
	assert.throws(() => preimageFromFrame(frame, "hash1"), /send failed: no route/);
});

test("preimageFromFrame throws on a gateway error frame", () => {
	assert.throws(() => preimageFromFrame({ error: { message: "boom" } }, "hash1"), /subscribe stream error: boom/);
});

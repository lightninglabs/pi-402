import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileReceiptLog, FileTokenStore, type ReceiptRecord } from "../src/store.ts";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi402-store-"));
}

function receipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
	return {
		paymentHash: "aa".repeat(32),
		amountSat: 4000,
		paidSat: 4004,
		invoice: "lnbcrt40u1fake",
		preimageHex: "bb".repeat(32),
		url: "http://localhost:8404/v1/chat/completions",
		timestamp: new Date().toISOString(),
		model: "zai-org/GLM-5.2",
		...overrides,
	};
}

test("FileTokenStore round-trips a token across instances", async () => {
	const path = join(await tempDir(), "tokens.json");
	const token = {
		macaroonB64: "AQIDBA==",
		preimageHex: "ab".repeat(32),
		expiresAt: "2099-01-01T00:00:00Z",
	};

	const first = new FileTokenStore(path);
	await first.put("http://localhost:8404|/v1/chat|POST", token);

	// A fresh instance simulates a process restart: the paid token must
	// still be there.
	const second = new FileTokenStore(path);
	assert.deepEqual(await second.get("http://localhost:8404|/v1/chat|POST"), token);
	assert.equal(await second.get("http://other:1|/v1/chat|POST"), null);
});

test("FileTokenStore drops expired tokens on read", async () => {
	const path = join(await tempDir(), "tokens.json");
	const store = new FileTokenStore(path);
	await store.put("key", {
		macaroonB64: "AQIDBA==",
		preimageHex: "ab".repeat(32),
		expiresAt: "2000-01-01T00:00:00Z",
	});

	assert.equal(await store.get("key"), null);
});

test("FileTokenStore sets a corrupt file aside and starts empty", async () => {
	const dir = await tempDir();
	const path = join(dir, "tokens.json");
	await writeFile(path, "not json{{{");

	const store = new FileTokenStore(path);
	assert.equal(await store.get("key"), null);

	// The corrupt file is preserved for postmortem under a timestamped
	// name, not deleted.
	const corruptName = (await readdir(dir)).find((name) => name.endsWith(".corrupt"));
	assert.ok(corruptName, "expected a .corrupt file to be set aside");
	assert.equal(await readFile(join(dir, corruptName), "utf8"), "not json{{{");

	// The store keeps working after recovery.
	const token = {
		macaroonB64: "AQIDBA==",
		preimageHex: "ab".repeat(32),
		expiresAt: "2099-01-01T00:00:00Z",
	};
	await store.put("key", token);
	assert.deepEqual(await new FileTokenStore(path).get("key"), token);
});

test("FileReceiptLog appends and reads records in order", async () => {
	const log = new FileReceiptLog(join(await tempDir(), "receipts.ndjson"));
	await log.store(receipt({ paymentHash: "11".repeat(32) }));
	await log.store(receipt({ paymentHash: "22".repeat(32) }));

	const records = await log.readAll();
	assert.equal(records.length, 2);
	assert.equal(records[0]?.paymentHash, "11".repeat(32));
	assert.equal(records[1]?.paymentHash, "22".repeat(32));
	assert.equal(records[0]?.model, "zai-org/GLM-5.2");
});

test("FileReceiptLog skips a trailing partial line", async () => {
	const path = join(await tempDir(), "receipts.ndjson");
	const log = new FileReceiptLog(path);
	await log.store(receipt());

	// Simulate a crash mid-append: a torn, unterminated record.
	await writeFile(path, `{"paymentHash":"torn`, { flag: "a" });

	const records = await log.readAll();
	assert.equal(records.length, 1);
});

test("FileReceiptLog reads an empty total from a missing file", async () => {
	const log = new FileReceiptLog(join(await tempDir(), "receipts.ndjson"));
	assert.deepEqual(await log.readAll(), []);
	assert.equal(await log.spentTodaySat(), 0);
});

test("FileTokenStore merges concurrent sessions' tokens on write", async () => {
	const path = join(await tempDir(), "tokens.json");
	const token = (preimage: string) => ({
		macaroonB64: "AQIDBA==",
		preimageHex: preimage.repeat(32),
		expiresAt: "2099-01-01T00:00:00Z",
	});

	// Two store instances simulate two concurrent pi sessions sharing the
	// file. Each pays for a different origin; both credentials must survive.
	const sessionA = new FileTokenStore(path);
	const sessionB = new FileTokenStore(path);
	await sessionA.put("http://localhost:8404|/v1/chat|POST", token("aa"));
	await sessionB.put("http://localhost:8402|/v1/chat|POST", token("bb"));

	const fresh = new FileTokenStore(path);
	assert.deepEqual(await fresh.get("http://localhost:8404|/v1/chat|POST"), token("aa"));
	assert.deepEqual(await fresh.get("http://localhost:8402|/v1/chat|POST"), token("bb"));
});

test("FileTokenStore treats a garbage expiry as expired", async () => {
	const path = join(await tempDir(), "tokens.json");
	const store = new FileTokenStore(path);
	await store.put("key", {
		macaroonB64: "AQIDBA==",
		preimageHex: "ab".repeat(32),
		expiresAt: "not-a-date",
	});

	// An unparseable expiry must not mint an immortal bearer credential.
	assert.equal(await store.get("key"), null);
});

test("FileReceiptLog skips lines that are not receipt-shaped objects", async () => {
	const path = join(await tempDir(), "receipts.ndjson");
	const log = new FileReceiptLog(path);
	await log.store(receipt());

	// Valid JSON that is not a receipt (null, a number, an object missing
	// paymentHash) must be skipped, not crash the read or zero the total.
	await writeFile(path, 'null\n42\n{"amountSat":9}\n', { flag: "a" });

	const records = await log.readAll();
	assert.equal(records.length, 1);
	assert.equal(await log.spentTodaySat(), 4004);
});

test("spentTodaySat sums only the current UTC day, preferring paidSat", async () => {
	const log = new FileReceiptLog(join(await tempDir(), "receipts.ndjson"));
	// A fixed clock keeps the test off the real UTC midnight boundary.
	const now = new Date("2026-07-10T12:00:00Z");
	await log.store(receipt({ paidSat: 4004, timestamp: "2026-07-10T01:00:00Z" }));
	await log.store(receipt({ paidSat: 2000, timestamp: "2026-07-10T11:59:00Z" }));
	// Yesterday's spend must not count against today's cap.
	await log.store(receipt({ paidSat: 9999, timestamp: "2026-07-09T23:59:59Z" }));

	assert.equal(await log.spentTodaySat(now), 6004);
});

test("a non-numeric paid amount cannot NaN-poison the day total", async () => {
	const path = join(await tempDir(), "receipts.ndjson");
	const log = new FileReceiptLog(path);
	const now = new Date("2026-07-10T12:00:00Z");
	await log.store(receipt({ paidSat: 4004, timestamp: "2026-07-10T01:00:00Z" }));

	// A foreign writer records garbage amounts. Summing naively would
	// concatenate strings, and the resulting NaN loses every cap
	// comparison, silently disabling the daily ceiling; a negative value
	// would subtract from the total, eroding the cap the same way. Numeric
	// strings coerce and count (conservative), garbage paidSat falls back
	// to the face value, and negatives count as zero.
	await writeFile(
		path,
		'{"paymentHash":"cc","paidSat":"5","timestamp":"2026-07-10T02:00:00Z"}\n' +
			'{"paymentHash":"dd","paidSat":"lots","timestamp":"2026-07-10T03:00:00Z"}\n' +
			'{"paymentHash":"ee","paidSat":"junk","amountSat":900,"timestamp":"2026-07-10T04:00:00Z"}\n' +
			'{"paymentHash":"ff","paidSat":-1000000,"timestamp":"2026-07-10T05:00:00Z"}\n',
		{ flag: "a" },
	);

	const total = await log.spentTodaySat(now);
	assert.equal(Number.isFinite(total), true);
	assert.equal(total, 4909);
});

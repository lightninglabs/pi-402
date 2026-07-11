import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

	// The corrupt file is preserved for postmortem, not deleted.
	const preserved = await readFile(`${path}.corrupt`, "utf8");
	assert.equal(preserved, "not json{{{");

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

test("spentTodaySat sums only the current UTC day, preferring paidSat", async () => {
	const log = new FileReceiptLog(join(await tempDir(), "receipts.ndjson"));
	await log.store(receipt({ paidSat: 4004 }));
	await log.store(receipt({ paidSat: 2000 }));
	// Yesterday's spend must not count against today's cap.
	await log.store(
		receipt({
			paidSat: 9999,
			timestamp: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
		}),
	);

	assert.equal(await log.spentTodaySat(), 6004);
});

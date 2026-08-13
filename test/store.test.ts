import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileCredentialStore, FileReceiptLog, FileTokenStore, type ReceiptRecord } from "../src/store.ts";

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

test("FileTokenStore's later put preserves an earlier session's token", async () => {
	const path = join(await tempDir(), "tokens.json");
	const token = (preimage: string) => ({
		macaroonB64: "AQIDBA==",
		preimageHex: preimage.repeat(32),
		expiresAt: "2099-01-01T00:00:00Z",
	});

	// Two store instances stand in for two pi sessions sharing the file.
	// The puts are sequential, so this pins merge-on-write rather than the
	// true interleave: the real race (both reading before either renames)
	// needs a seam to force, and its worst case is losing one token, which
	// costs one re-purchased bundle.
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

test("FileReceiptLog skips a record whose timestamp is not a string", async () => {
	const path = join(await tempDir(), "receipts.ndjson");
	const log = new FileReceiptLog(path);
	const now = new Date("2026-07-10T12:00:00Z");
	await log.store(receipt({ paidSat: 4004, timestamp: "2026-07-10T01:00:00Z" }));

	// A foreign writer records a numeric timestamp. Every reader slices the
	// timestamp to get the day, and optional chaining does not guard a
	// non-nullish non-string, so letting this line through would make
	// spentTodaySat throw. The budget policy catches that and falls back to
	// its in-memory counter, which a restart resets: one bad line would
	// silently cost the daily cap its memory for good.
	await writeFile(path, '{"paymentHash":"aa","paidSat":500,"timestamp":20260710}\n', { flag: "a" });

	const records = await log.readAll();
	assert.equal(records.length, 1);
	assert.equal(await log.spentTodaySat(now), 4004);
});

// chmod 000 does not stop root, so these two would read the file happily and
// pass for the wrong reason in a root container.
const skipAsRoot = { skip: process.getuid?.() === 0 ? "chmod cannot restrict root" : false };

test("FileTokenStore keeps working when the file cannot be read", skipAsRoot, async () => {
	const dir = await tempDir();
	const path = join(dir, "tokens.json");
	await writeFile(path, "{}");
	// Make the file unreadable. A read error must not escape from get: it
	// would fail the request before it was attempted, and a broken cache
	// must never block a payment.
	await chmod(path, 0o000);

	const store = new FileTokenStore(path);
	try {
		assert.equal(await store.get("key"), null);
	} finally {
		await chmod(path, 0o600);
	}
});

test("FileTokenStore refuses to rewrite the file it could not read", skipAsRoot, async () => {
	const dir = await tempDir();
	const path = join(dir, "tokens.json");
	const token = {
		macaroonB64: "AQIDBA==",
		preimageHex: "ab".repeat(32),
		expiresAt: "2099-01-01T00:00:00Z",
	};

	// Two sessions' paid tokens are already on disk.
	const seeded = new FileTokenStore(path);
	await seeded.put("origin-a|/v1/chat|POST", token);
	await seeded.put("origin-b|/v1/chat|POST", token);
	const before = await readFile(path, "utf8");

	// The merge read fails. put must give up rather than treat the file as
	// empty: rewriting it from an empty map would replace two paid
	// credentials with one, destroying value that is still spendable.
	await chmod(path, 0o000);
	try {
		await assert.rejects(() => new FileTokenStore(path).put("origin-c|/v1/chat|POST", token));
	} finally {
		await chmod(path, 0o600);
	}

	assert.equal(await readFile(path, "utf8"), before);
	const fresh = new FileTokenStore(path);
	assert.deepEqual(await fresh.get("origin-a|/v1/chat|POST"), token);
	assert.deepEqual(await fresh.get("origin-b|/v1/chat|POST"), token);
});

test("FileCredentialStore round-trips a credential across instances", async () => {
	const path = join(await tempDir(), "credentials.json");
	const credential = {
		authorization: "Payment eyJjaGFsbGVuZ2UiOnt9fQ",
		challengeId: "chal-abc123",
		expiresAt: "2099-01-01T00:00:00Z",
	};

	const first = new FileCredentialStore(path);
	await first.put("http://localhost:8404|/v1/chat|POST", credential);

	// A fresh instance stands in for a process restart. The point of the
	// store is that a retry which throws after the money moved does not turn
	// into a second payment.
	const second = new FileCredentialStore(path);
	assert.deepEqual(await second.get("http://localhost:8404|/v1/chat|POST"), credential);
});

test("FileCredentialStore writes the file owner-only", async () => {
	const path = join(await tempDir(), "credentials.json");
	const store = new FileCredentialStore(path);
	await store.put("k", { authorization: "Payment x", challengeId: "c" });

	const { mode } = await stat(path);
	assert.equal(mode & 0o777, 0o600);
});

test("FileCredentialStore drops an expired credential", async () => {
	const path = join(await tempDir(), "credentials.json");
	const store = new FileCredentialStore(path);

	await store.put("k", {
		authorization: "Payment x",
		challengeId: "c",
		expiresAt: "2000-01-01T00:00:00Z",
	});

	assert.equal(await store.get("k"), null);
});

test("FileCredentialStore treats an unparseable expiry as expired", async () => {
	// NaN loses every comparison, so a credential whose expiry does not parse
	// would otherwise be immortal, the wrong failure mode for a bearer value.
	const path = join(await tempDir(), "credentials.json");
	const store = new FileCredentialStore(path);

	await store.put("k", {
		authorization: "Payment x",
		challengeId: "c",
		expiresAt: "not a date",
	});

	assert.equal(await store.get("k"), null);
});

test("FileCredentialStore deletes a credential the server refused", async () => {
	const path = join(await tempDir(), "credentials.json");
	const store = new FileCredentialStore(path);

	await store.put("keep", { authorization: "Payment a", challengeId: "a" });
	await store.put("drop", { authorization: "Payment b", challengeId: "b" });
	await store.delete("drop");

	assert.equal(await store.get("drop"), null);
	assert.notEqual(await store.get("keep"), null);

	// The delete must survive a restart, not just this instance's view.
	const reopened = new FileCredentialStore(path);
	assert.equal(await reopened.get("drop"), null);
});

test("FileCredentialStore merges rather than clobbering a concurrent write", async () => {
	const path = join(await tempDir(), "credentials.json");
	const mine = new FileCredentialStore(path);
	const theirs = new FileCredentialStore(path);

	await mine.put("mine", { authorization: "Payment a", challengeId: "a" });
	await theirs.put("theirs", { authorization: "Payment b", challengeId: "b" });

	assert.notEqual(await mine.get("mine"), null);
	assert.notEqual(await mine.get("theirs"), null);
});

test("FileCredentialStore sets aside a corrupt file instead of failing", async () => {
	const dir = await tempDir();
	const path = join(dir, "credentials.json");
	await writeFile(path, "{ not json", { mode: 0o600 });

	const store = new FileCredentialStore(path);
	assert.equal(await store.get("k"), null);

	// A broken cache must never block a payment, and the old file is kept
	// for postmortem rather than deleted.
	await store.put("k", { authorization: "Payment x", challengeId: "c" });
	assert.notEqual(await store.get("k"), null);

	const entries = await readdir(dir);
	assert.ok(entries.some((name) => name.endsWith(".corrupt")));
});

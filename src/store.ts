// Durable local state for the extension: the paid L402 token cache and the
// payment receipt ledger. Both live under the pi-402 data directory
// (PI402_DATA_DIR, defaulting to ~/.pi402), so paid bundles survive process
// restarts instead of being re-purchased, and every settled payment leaves an
// auditable record. Both files are shared by concurrent pi sessions, so every
// operation reads fresh and writes without clobbering another session's
// state.

import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CachedCredential, CachedToken, ClientReceipt, CredentialStore, TokenStore } from "@aperture/client";

// dataDir resolves the directory durable state lives in. The directory is
// created lazily by the stores on first write.
export function dataDir(): string {
	return process.env.PI402_DATA_DIR ?? join(homedir(), ".pi402");
}

// tokenStoreState is the JSON serialization of the token store file.
interface TokenStoreState {
	version: 1;
	tokens: Record<string, CachedToken>;
}

// isExpired reports whether a cached token is past its expiry. An empty
// expiry means the challenge carried none, so the token does not expire; a
// non-empty expiry that fails to parse counts as expired, since an immortal
// bearer credential is the wrong failure mode for garbage input.
function isExpired(token: CachedToken): boolean {
	if (!token.expiresAt) {
		return false;
	}
	const expiresMs = new Date(token.expiresAt).getTime();
	return Number.isNaN(expiresMs) || Date.now() > expiresMs;
}

// FileTokenStore is a TokenStore backed by a JSON file. A cached token is a
// live bearer credential for the bundle's unspent balance (macaroon plus
// preimage), so the file is written with owner-only permissions and replaced
// atomically: a crash mid-write must not corrupt the previous state.
//
// The file is shared by concurrent sessions: reads are always fresh, and a
// write re-reads the file and merges before rewriting, so one session's paid
// token cannot be clobbered by another session persisting its own. The
// read-merge-write is not atomic across processes; two puts racing in the
// same instant can still lose one token, a window that is tiny and whose
// worst case is re-purchasing one bundle.
export class FileTokenStore implements TokenStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	// readState reads and parses the state file fresh, dropping expired
	// entries. A missing file is a fresh start. A corrupt file is set aside
	// for postmortem rather than deleted, and the read yields empty: a
	// broken cache must never block payments, the worst case is
	// re-purchasing a bundle.
	private async readState(): Promise<Map<string, CachedToken>> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return new Map();
			}
			// Any other read failure propagates. It is tempting to treat
			// this like corruption and yield empty, but the two are not
			// alike: a corrupt file has nothing left to lose, whereas an
			// intact file that merely failed to open still holds every
			// other session's paid tokens, and put() rewrites the file
			// from whatever this returns. Yielding empty here would let
			// one transient read error replace the whole file with a
			// single token. get() absorbs the throw instead, so a
			// failed read still cannot block a payment.
			throw err;
		}

		try {
			const state = JSON.parse(raw) as TokenStoreState;
			const tokens = new Map<string, CachedToken>();
			for (const [key, token] of Object.entries(state.tokens ?? {})) {
				if (token && typeof token === "object" && !isExpired(token)) {
					tokens.set(key, token);
				}
			}
			return tokens;
		} catch {
			// Quarantining a paid-token file is worth a loud line: the
			// bounded cost is re-purchasing whatever bundles it held.
			console.warn(`pi-402: token store ${this.path} is corrupt, setting it aside`);
			try {
				await rename(this.path, `${this.path}.${Date.now()}.corrupt`);
			} catch {
				// Another session already set it aside; losing that race
				// is fine.
			}
			return new Map();
		}
	}

	async get(key: string): Promise<CachedToken | null> {
		// A read that fails here means we cannot tell whether a paid token
		// exists, which is a reason to buy one, not a reason to fail the
		// request: a broken cache must never block a payment. The worst
		// case is re-purchasing a bundle.
		let tokens: Map<string, CachedToken>;
		try {
			tokens = await this.readState();
		} catch (err) {
			console.warn(`pi-402: token store ${this.path} is unreadable, continuing without it:`, err);
			return null;
		}

		return tokens.get(key) ?? null;
	}

	async put(key: string, token: CachedToken): Promise<void> {
		// Merge on write: re-read the file so tokens persisted by other
		// sessions since our last read survive this rewrite. Expired
		// entries fall out here, so the file cannot grow without bound.
		const tokens = await this.readState();
		tokens.set(key, token);

		const state: TokenStoreState = {
			version: 1,
			tokens: Object.fromEntries(tokens),
		};
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

		// The tmp name is unique per write, so concurrent sessions cannot
		// truncate each other's in-flight tmp file before the rename.
		const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(state, null, "\t"), { mode: 0o600 });
		await rename(tmpPath, this.path);
	}
}

// credentialStoreState is the JSON serialization of the credential store file.
interface CredentialStoreState {
	version: 1;
	credentials: Record<string, CachedCredential>;
}

// isCredentialExpired reports whether a cached credential is past its expiry.
// The rule matches the token store's: no expiry means the challenge carried
// none, and an expiry that fails to parse counts as expired rather than
// immortal.
function isCredentialExpired(credential: CachedCredential): boolean {
	if (!credential.expiresAt) {
		return false;
	}
	const expiresMs = Date.parse(credential.expiresAt);
	return Number.isNaN(expiresMs) || Date.now() > expiresMs;
}

// FileCredentialStore is a CredentialStore backed by a JSON file, the Payment
// scheme's counterpart to FileTokenStore.
//
// What it protects against is narrow but expensive: the paid retry throws
// after the money moved, the caller retries, and without the credential on
// disk the client fetches a fresh challenge and pays for the same thing a
// second time. A stored credential turns that into at worst one refused
// request. It holds an Authorization header for a settled payment, so the
// file gets the same owner-only permissions and atomic replacement the token
// store gets.
export class FileCredentialStore implements CredentialStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	// readState reads and parses the state file fresh, dropping expired
	// entries. The failure handling matches FileTokenStore for the same
	// reasons: a missing file is a fresh start, a corrupt file is set aside
	// rather than deleted, and any other read failure propagates so that one
	// transient error cannot rewrite the file down to a single entry.
	private async readState(): Promise<Map<string, CachedCredential>> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return new Map();
			}
			throw err;
		}

		try {
			const state = JSON.parse(raw) as CredentialStoreState;
			const credentials = new Map<string, CachedCredential>();
			for (const [key, credential] of Object.entries(state.credentials ?? {})) {
				if (
					credential &&
					typeof credential === "object" &&
					typeof credential.authorization === "string" &&
					!isCredentialExpired(credential)
				) {
					credentials.set(key, credential);
				}
			}
			return credentials;
		} catch {
			console.warn(`pi-402: credential store ${this.path} is corrupt, setting it aside`);
			try {
				await rename(this.path, `${this.path}.${Date.now()}.corrupt`);
			} catch {
				// Another session already set it aside; losing that race is
				// fine.
			}
			return new Map();
		}
	}

	// write replaces the file with the given entries, merging happening in the
	// callers so that put and delete share one atomic rewrite.
	private async write(credentials: Map<string, CachedCredential>): Promise<void> {
		const state: CredentialStoreState = {
			version: 1,
			credentials: Object.fromEntries(credentials),
		};
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

		const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(state, null, "\t"), { mode: 0o600 });
		await rename(tmpPath, this.path);
	}

	async get(key: string): Promise<CachedCredential | null> {
		// An unreadable store is a reason to buy, not a reason to fail: the
		// worst case is re-purchasing one credential, which is exactly where
		// the caller would be with no store at all.
		try {
			return (await this.readState()).get(key) ?? null;
		} catch (err) {
			console.warn(`pi-402: credential store ${this.path} is unreadable, continuing without it:`, err);
			return null;
		}
	}

	async put(key: string, credential: CachedCredential): Promise<void> {
		const credentials = await this.readState();
		credentials.set(key, credential);
		await this.write(credentials);
	}

	async delete(key: string): Promise<void> {
		// A delete means the server refused this credential, so dropping it
		// matters more than preserving it. An unreadable store leaves nothing
		// to delete from, and throwing here would fail a request whose
		// credential is already known bad.
		let credentials: Map<string, CachedCredential>;
		try {
			credentials = await this.readState();
		} catch (err) {
			console.warn(`pi-402: credential store ${this.path} is unreadable, cannot drop ${key}:`, err);
			return;
		}

		if (!credentials.delete(key)) {
			return;
		}
		await this.write(credentials);
	}
}

// ReceiptRecord is one line of the receipt ledger: the client receipt from the
// buyer loop, stamped with the model the payment bought inference for.
export interface ReceiptRecord extends ClientReceipt {
	model?: string;
}

// receiptPaidSat extracts the paid amount of a receipt: the payer-reported
// outflow (paidSat, fees included) when usable, the invoice face value as
// the fallback, zero otherwise. Only finite positive values count: one
// non-numeric string in a shared file would NaN-poison the day total (NaN
// loses every cap comparison, silently disabling the daily ceiling), and a
// negative value would subtract from it, eroding the cap the same way.
export function receiptPaidSat(receipt: ReceiptRecord): number {
	for (const value of [receipt.paidSat, receipt.amountSat]) {
		const paid = Number(value ?? Number.NaN);
		if (Number.isFinite(paid) && paid > 0) {
			return paid;
		}
	}
	return 0;
}

// FileReceiptLog is an append-only newline-delimited JSON ledger of settled
// payments. Appends are single writes of one line, so concurrent sessions
// interleave whole records rather than corrupting each other.
export class FileReceiptLog {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async store(receipt: ReceiptRecord): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await appendFile(this.path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

		// appendFile's mode only applies when it creates the file; receipts
		// hold preimages and invoices, so tighten a pre-existing file too.
		await chmod(this.path, 0o600);
	}

	// readAll returns every well-formed record in the ledger, oldest first. A
	// trailing partial line (a crash mid-append) and any line that parses to
	// something other than a receipt-shaped object are skipped rather than
	// poisoning the whole read; a spend total must never be derailed by one
	// bad line.
	async readAll(): Promise<ReceiptRecord[]> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw err;
		}

		const records: ReceiptRecord[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			try {
				const parsed = JSON.parse(line) as unknown;
				if (
					parsed !== null &&
					typeof parsed === "object" &&
					typeof (parsed as ReceiptRecord).paymentHash === "string" &&
					// The timestamp must be a string, not merely present.
					// Every reader slices it to get the day, and optional
					// chaining does not guard a non-nullish non-string:
					// (123)?.slice(0, 10) throws. One such line would make
					// spentTodaySat throw on every assertion, degrading the
					// daily cap to the in-memory counter for the rest of the
					// process.
					typeof (parsed as ReceiptRecord).timestamp === "string"
				) {
					records.push(parsed as ReceiptRecord);
				}
			} catch {
				// Skip unparseable lines; the ledger stays readable.
			}
		}
		return records;
	}

	// spentTodaySat sums the paid amounts of receipts recorded on the current
	// UTC calendar day. The budget policy reads this on every assertion, so
	// concurrent sessions see each other's settled spends.
	async spentTodaySat(now: Date = new Date()): Promise<number> {
		const day = now.toISOString().slice(0, 10);

		let total = 0;
		for (const receipt of await this.readAll()) {
			if (receipt.timestamp?.slice(0, 10) === day) {
				total += receiptPaidSat(receipt);
			}
		}
		return total;
	}
}

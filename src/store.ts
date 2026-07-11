// Durable local state for the extension: the paid L402 token cache and the
// payment receipt ledger. Both live under the pi-402 data directory
// (PI402_DATA_DIR, defaulting to ~/.pi402), so paid bundles survive process
// restarts instead of being re-purchased, and every settled payment leaves an
// auditable record.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CachedToken, ClientReceipt, TokenStore } from "@aperture/client";

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

// FileTokenStore is a TokenStore backed by a JSON file. A cached token is a
// live bearer credential for the bundle's unspent balance (macaroon plus
// preimage), so the file is written with owner-only permissions and replaced
// atomically: a crash mid-write must not corrupt the previous state.
export class FileTokenStore implements TokenStore {
	private readonly path: string;
	private tokens = new Map<string, CachedToken>();
	private loaded = false;

	constructor(path: string) {
		this.path = path;
	}

	// load reads the persisted state once. A missing file is a fresh start. A
	// corrupt file is set aside for postmortem rather than deleted, and the
	// store starts empty: a broken cache must never block payments, the worst
	// case is re-purchasing a bundle.
	private async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;

		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw err;
		}

		try {
			const state = JSON.parse(raw) as TokenStoreState;
			for (const [key, token] of Object.entries(state.tokens ?? {})) {
				this.tokens.set(key, token);
			}
		} catch {
			await rename(this.path, `${this.path}.corrupt`);
		}
	}

	// persist atomically replaces the state file with the current map.
	private async persist(): Promise<void> {
		const state: TokenStoreState = {
			version: 1,
			tokens: Object.fromEntries(this.tokens),
		};
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmpPath = `${this.path}.tmp`;
		await writeFile(tmpPath, JSON.stringify(state, null, "\t"), { mode: 0o600 });
		await rename(tmpPath, this.path);
	}

	async get(key: string): Promise<CachedToken | null> {
		await this.load();

		const token = this.tokens.get(key);
		if (!token) {
			return null;
		}

		// Expired tokens are dropped on read, mirroring the in-memory cache.
		// The deletion is persisted lazily by the next put.
		if (token.expiresAt && Date.now() > new Date(token.expiresAt).getTime()) {
			this.tokens.delete(key);
			return null;
		}

		return token;
	}

	async put(key: string, token: CachedToken): Promise<void> {
		await this.load();
		this.tokens.set(key, token);
		await this.persist();
	}
}

// ReceiptRecord is one line of the receipt ledger: the client receipt from the
// buyer loop, stamped with the model the payment bought inference for.
export interface ReceiptRecord extends ClientReceipt {
	model?: string;
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
	}

	// readAll returns every parseable record in the ledger, oldest first. A
	// trailing partial line (a crash mid-append) is skipped rather than
	// poisoning the whole read.
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
				records.push(JSON.parse(line) as ReceiptRecord);
			} catch {
				// Skip unparseable lines; the ledger stays readable.
			}
		}
		return records;
	}

	// spentTodaySat sums the paid amounts of receipts recorded on the current
	// UTC calendar day. Used to seed the daily budget cap on startup, so a
	// process restart cannot reset the day's spend to zero.
	async spentTodaySat(now: Date = new Date()): Promise<number> {
		const day = now.toISOString().slice(0, 10);

		let total = 0;
		for (const receipt of await this.readAll()) {
			if (receipt.timestamp?.slice(0, 10) === day) {
				// paidSat is the payer-reported outflow including fees; fall
				// back to the invoice face value for older records.
				total += receipt.paidSat ?? receipt.amountSat ?? 0;
			}
		}
		return total;
	}
}

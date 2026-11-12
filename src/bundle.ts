// The bundle bar: a client-side estimate of how much of the paid bundle is
// left. The 402 challenge does not carry the bundle's size or the seller's
// debit rates, so the seller publishes a static rate file at
// <origin>/pi402.json. The client debits each response's usage against the
// bundle with the same formula the seller meters with, and persists the
// estimate so a restart does not reset it to full.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// RATES_PATH is where a seller serves its rate file, relative to the origin
// of the proxy URL. RATES_TIMEOUT_MS bounds one fetch; the bar is a
// convenience, so a slow seller is given up on quickly.
export const RATES_PATH = "/pi402.json";
export const RATES_TIMEOUT_MS = 3_000;

const MS_PER_DAY = 86_400_000;

// ModelRate is one model's entry of the rate file, with the file's bundle
// lifetime folded in.
export interface ModelRate {
	bundleTokens: number;
	inputUsdPerMtok: number;
	outputUsdPerMtok: number;
	validDays: number;
}

// parseModelRate extracts one model's rates from a rate file body (schema
// version 1). Anything malformed, a missing model, or a non-positive number
// yields undefined, which means no bar.
export function parseModelRate(body: unknown, model: string): ModelRate | undefined {
	const file = body as { version?: unknown; bundleValidDays?: unknown; models?: Record<string, unknown> } | null;
	if (!file || typeof file !== "object" || file.version !== 1) {
		return undefined;
	}

	const entry = file.models?.[model] as Record<string, unknown> | undefined;
	if (!entry || typeof entry !== "object") {
		return undefined;
	}

	const bundleTokens = entry.bundleTokens;
	const inputUsdPerMtok = entry.inputUsdPerMtok;
	const outputUsdPerMtok = entry.outputUsdPerMtok;
	const validDays = file.bundleValidDays;
	for (const value of [bundleTokens, inputUsdPerMtok, outputUsdPerMtok, validDays]) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			return undefined;
		}
	}

	return {
		bundleTokens: bundleTokens as number,
		inputUsdPerMtok: inputUsdPerMtok as number,
		outputUsdPerMtok: outputUsdPerMtok as number,
		validDays: validDays as number,
	};
}

// debitTokens is the bundle tokens one response costs the seller's meter:
// ceil(2 * (prompt * inRate + completion * outRate) / (inRate + outRate)).
// Only the ratio of the two rates matters. Reasoning tokens are part of the
// completion count.
export function debitTokens(
	rate: Pick<ModelRate, "inputUsdPerMtok" | "outputUsdPerMtok">,
	promptTokens: number,
	completionTokens: number,
): number {
	const { inputUsdPerMtok: inRate, outputUsdPerMtok: outRate } = rate;
	return Math.ceil((2 * (promptTokens * inRate + completionTokens * outRate)) / (inRate + outRate));
}

// BundleState is the persisted estimate for one seller and model. It keeps
// the rates it debits with, so a restart can keep debiting without a fetch.
export interface BundleState {
	model: string;
	bundleTokens: number;
	remaining: number;
	startedAt: number;
	validDays: number;
	inputUsdPerMtok: number;
	outputUsdPerMtok: number;
}

// startBundle is the state of a freshly bought bundle: full, and started now.
export function startBundle(model: string, rate: ModelRate, now: number): BundleState {
	return {
		model,
		bundleTokens: rate.bundleTokens,
		remaining: rate.bundleTokens,
		startedAt: now,
		validDays: rate.validDays,
		inputUsdPerMtok: rate.inputUsdPerMtok,
		outputUsdPerMtok: rate.outputUsdPerMtok,
	};
}

// applyUsage debits one response from the estimate, never below zero.
export function applyUsage(state: BundleState, promptTokens: number, completionTokens: number): BundleState {
	const cost = debitTokens(state, promptTokens, completionTokens);
	return { ...state, remaining: Math.max(0, state.remaining - cost) };
}

// StreamEstimate is what an in-flight response is expected to cost so far:
// the prompt estimate, known before the first token, and a completion
// estimate that grows with the streamed text.
export interface StreamEstimate {
	model: string;
	prompt: number;
	completion: number;
}

// StreamProjection tracks the in-flight responses, so the bar can show the
// bundle as it will be once they settle. It is display state only and is never
// persisted: the real debit is applied when a response ends, and the entry is
// dropped after it. With several responses streaming at once, each one's debit
// is computed on its own and the debits are summed, which is how the seller
// meters them (one debit per request). An entry is dropped only after its
// debit has been persisted, so a finished response is never counted twice.
export class StreamProjection {
	private readonly streams = new Map<object, StreamEstimate>();

	update(stream: object, model: string, prompt: number, completion: number): void {
		this.streams.set(stream, { model, prompt, completion });
	}

	get(stream: object): StreamEstimate | undefined {
		return this.streams.get(stream);
	}

	drop(stream: object): void {
		this.streams.delete(stream);
	}

	// debit is the bundle tokens all in-flight responses for the model are
	// expected to cost.
	debit(rate: Pick<ModelRate, "inputUsdPerMtok" | "outputUsdPerMtok">, model: string): number {
		let total = 0;
		for (const stream of this.streams.values()) {
			if (stream.model === model) {
				total += debitTokens(rate, stream.prompt, stream.completion);
			}
		}
		return total;
	}

	// project is the estimate's remainder with the in-flight debits taken off,
	// never below zero.
	project(state: Pick<BundleState, "remaining" | "inputUsdPerMtok" | "outputUsdPerMtok">, model: string): number {
		return Math.max(0, state.remaining - this.debit(state, model));
	}
}

// estimateTokens is the token estimate for a count of characters or bytes: a
// quarter of it, rounded up. It mirrors how the seller settles a stream that
// ends without a usage block.
export function estimateTokens(units: number): number {
	return Math.ceil(units / 4);
}

// LIVE_REDRAW_MS is the shortest gap between two live footer redraws, about
// four a second.
export const LIVE_REDRAW_MS = 250;

// Throttle runs a function at most once per interval, coalescing the calls
// in between into one trailing run.
export interface Throttle {
	call(): void;
	cancel(): void;
}

// throttle wraps fn so it runs at most once per interval: immediately when
// the interval has passed, otherwise once at the end of it. The clock and
// timer are injectable for tests. A throw from fn is swallowed, because the
// footer must never affect the stream that drives it.
export function throttle(
	fn: () => void,
	intervalMs = LIVE_REDRAW_MS,
	now: () => number = Date.now,
	schedule: (cb: () => void, ms: number) => () => void = (cb, ms) => {
		const timer = setTimeout(cb, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
): Throttle {
	let last = Number.NEGATIVE_INFINITY;
	let cancelPending: (() => void) | undefined;

	const run = (): void => {
		last = now();
		try {
			fn();
		} catch {
			// The footer is a convenience.
		}
	};

	return {
		call() {
			if (cancelPending) {
				return;
			}
			const wait = intervalMs - (now() - last);
			if (wait <= 0) {
				run();
				return;
			}
			cancelPending = schedule(() => {
				cancelPending = undefined;
				run();
			}, wait);
		},
		cancel() {
			cancelPending?.();
			cancelPending = undefined;
		},
	};
}

// isBundleExpired reports whether the bundle is past its validity window.
export function isBundleExpired(state: BundleState, now: number): boolean {
	return now - state.startedAt >= state.validDays * MS_PER_DAY;
}

// Colorizer wraps text in a color for one of the three bar states.
export type Colorizer = (color: "success" | "warning" | "error", text: string) => string;

const BAR_CELLS = 5;

// formatTokens abbreviates a token count: "310k", "1.5M".
export function formatTokens(n: number): string {
	if (n >= 999_500) {
		return `${Number((n / 1_000_000).toFixed(1))}M`;
	}
	if (n >= 1_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return String(Math.max(0, Math.round(n)));
}

// formatBar renders the bundle as "▰▰▰▱▱ ~310k/500k tok". The bar is green
// with more than half left, yellow at or under half, and red under 20
// percent. The leading "~" marks the remainder as an estimate. A remainder
// outside the range is clamped for the bar.
export function formatBar(remaining: number, total: number, colorize?: Colorizer): string {
	const fraction = Math.min(1, Math.max(0, remaining / total));
	const filled = Math.round(fraction * BAR_CELLS);
	const bar = "▰".repeat(filled) + "▱".repeat(BAR_CELLS - filled);
	const text = `${bar} ~${formatTokens(remaining)}/${formatTokens(total)} tok`;

	const color = fraction > 0.5 ? "success" : fraction < 0.2 ? "error" : "warning";
	return colorize ? colorize(color, text) : text;
}

// BundleStore persists estimates by key.
export interface BundleStore {
	get(key: string): Promise<BundleState | undefined>;
	put(key: string, state: BundleState): Promise<void>;
	delete(key: string): Promise<void>;
}

// MemoryBundleStore keeps estimates in the process, for mock mode and tests.
export class MemoryBundleStore implements BundleStore {
	private readonly map = new Map<string, BundleState>();

	async get(key: string): Promise<BundleState | undefined> {
		return this.map.get(key);
	}

	async put(key: string, state: BundleState): Promise<void> {
		this.map.set(key, state);
	}

	async delete(key: string): Promise<void> {
		this.map.delete(key);
	}
}

// FileBundleStore persists estimates as JSON, next to the credential store.
// Reads are fresh and writes re-read and merge, replacing the file
// atomically. An unreadable or corrupt file reads as empty: the estimate is
// a convenience and must never fail a request.
export class FileBundleStore implements BundleStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private async read(): Promise<Record<string, BundleState>> {
		try {
			const state = JSON.parse(await readFile(this.path, "utf8")) as { bundles?: Record<string, BundleState> };
			return state.bundles && typeof state.bundles === "object" ? state.bundles : {};
		} catch {
			return {};
		}
	}

	private async write(bundles: Record<string, BundleState>): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify({ version: 1, bundles }, null, "\t"), { mode: 0o600 });
		await rename(tmpPath, this.path);
	}

	async get(key: string): Promise<BundleState | undefined> {
		return (await this.read())[key];
	}

	async put(key: string, state: BundleState): Promise<void> {
		await this.write({ ...(await this.read()), [key]: state });
	}

	async delete(key: string): Promise<void> {
		const bundles = await this.read();
		if (key in bundles) {
			delete bundles[key];
			await this.write(bundles);
		}
	}
}

// BundleTracker ties the pieces together for one seller origin. Rate files
// are fetched once per origin and cached on success; a failed fetch is
// retried on the next start. Every method swallows its failures, so none can
// reach a payment or a request.
export class BundleTracker {
	private readonly origin: string;
	private readonly store: BundleStore;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private rateFile?: unknown;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		origin: string,
		store: BundleStore,
		fetchFn: typeof fetch = fetch,
		now: () => number = Date.now,
		timeoutMs = RATES_TIMEOUT_MS,
	) {
		this.origin = origin;
		this.store = store;
		this.fetchFn = fetchFn;
		this.now = now;
		this.timeoutMs = timeoutMs;
	}

	private key(model: string): string {
		return `${this.origin}|${model}`;
	}

	// serialize runs operations one at a time, so concurrent responses cannot
	// lose each other's debits.
	private serialize<T>(op: () => Promise<T>): Promise<T | undefined> {
		const run = this.chain.then(op).catch(() => undefined);
		this.chain = run;
		return run;
	}

	private async fetchRates(): Promise<unknown> {
		if (this.rateFile !== undefined) {
			return this.rateFile;
		}
		try {
			const res = await this.fetchFn(`${this.origin}${RATES_PATH}`, { signal: AbortSignal.timeout(this.timeoutMs) });
			if (res.ok) {
				this.rateFile = await res.json();
			}
		} catch {
			// No rates, no bar.
		}
		return this.rateFile;
	}

	// start begins a new bundle for the model, replacing any earlier one. If
	// the seller's rates cannot be had, the earlier estimate is dropped
	// anyway: it describes a bundle that has been replaced.
	start(model: string): Promise<void> {
		return this.serialize(async () => {
			const rate = parseModelRate(await this.fetchRates(), model);
			if (rate) {
				await this.store.put(this.key(model), startBundle(model, rate, this.now()));
			} else {
				await this.store.delete(this.key(model));
			}
		}).then(() => undefined);
	}

	// debit subtracts one response's usage from the model's bundle, if one is
	// tracked and unexpired.
	debit(model: string, promptTokens: number, completionTokens: number): Promise<void> {
		return this.serialize(async () => {
			const state = await this.store.get(this.key(model));
			if (state && !isBundleExpired(state, this.now())) {
				await this.store.put(this.key(model), applyUsage(state, promptTokens, completionTokens));
			}
		}).then(() => undefined);
	}

	// current is the model's live estimate, or undefined when none is tracked
	// or it has expired.
	async current(model: string): Promise<BundleState | undefined> {
		try {
			const state = await this.store.get(this.key(model));
			return state && !isBundleExpired(state, this.now()) ? state : undefined;
		} catch {
			return undefined;
		}
	}
}

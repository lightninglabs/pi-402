import { formatSat } from "./format.ts";

// SPOT_URL is Coinbase's public BTC-USD spot endpoint. It needs no key, and
// the client fetches it directly so the seller never learns the wallet's
// balance or when it is looked at.
export const SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

// SPOT_TTL_MS is how long a fetched rate is reused, and SPOT_TIMEOUT_MS bounds
// one fetch. The dollar figure is a convenience, so a slow endpoint is given
// up on quickly.
export const SPOT_TTL_MS = 5 * 60_000;
export const SPOT_TIMEOUT_MS = 3_000;

const SATS_PER_BTC = 100_000_000;

// formatUsd renders the dollar value of a sat balance at the given BTC/USD
// rate ("$5.63"). A non-zero balance worth under a cent shows as "<$0.01"
// rather than a misleading "$0.00".
export function formatUsd(sat: number, btcUsd: number): string {
	const usd = (sat / SATS_PER_BTC) * btcUsd;
	if (sat > 0 && usd < 0.005) {
		return "<$0.01";
	}
	return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// formatFooter is the footer line: the sat balance, with the dollar value in
// parentheses when a rate is known and without it otherwise.
export function formatFooter(sat: number, btcUsd?: number): string {
	const base = `⚡ ${formatSat(sat)} sat`;
	return btcUsd === undefined ? base : `${base} (${formatUsd(sat, btcUsd)})`;
}

// parseSpot extracts the rate from Coinbase's response body, or undefined if
// it is not a positive finite number.
export function parseSpot(body: unknown): number | undefined {
	const amount = Number((body as { data?: { amount?: unknown } } | null)?.data?.amount);
	return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

// SpotRate caches the BTC/USD rate in memory. rate() never waits: it returns
// whatever is cached, and when the cache is empty or stale it starts one
// background fetch. A failed fetch leaves the previous value in place, so a
// stale rate is still shown until a fetch succeeds. onUpdate runs when a fetch
// lands a new rate, so the footer can redraw with it.
export class SpotRate {
	private value?: number;
	private fetchedAt = 0;
	private inflight = false;
	private readonly fetchFn: typeof fetch;
	private readonly onUpdate: () => void;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;

	constructor(
		fetchFn: typeof fetch = fetch,
		onUpdate: () => void = () => {},
		now: () => number = Date.now,
		ttlMs = SPOT_TTL_MS,
		timeoutMs = SPOT_TIMEOUT_MS,
	) {
		this.fetchFn = fetchFn;
		this.onUpdate = onUpdate;
		this.now = now;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}

	rate(): number | undefined {
		if (!this.inflight && (this.value === undefined || this.now() - this.fetchedAt >= this.ttlMs)) {
			void this.refresh();
		}
		return this.value;
	}

	// refresh fetches the rate once and resolves when it is done. It never
	// rejects.
	async refresh(): Promise<void> {
		this.inflight = true;
		try {
			const res = await this.fetchFn(SPOT_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
			if (!res.ok) {
				return;
			}
			const rate = parseSpot(await res.json());
			if (rate !== undefined) {
				this.value = rate;
				this.onUpdate();
			}
		} catch {
			// Keep the last rate, or none.
		} finally {
			// Stamp the attempt either way, so a failing endpoint is retried
			// once per TTL rather than on every footer redraw.
			this.fetchedAt = this.now();
			this.inflight = false;
		}
	}
}

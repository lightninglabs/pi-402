import type { BuyerPolicy } from "@aperture/core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// DEFAULT_MAX_SAT_PER_REQUEST caps a single L402 payment when
// PI402_MAX_SAT_PER_REQUEST is unset.
const DEFAULT_MAX_SAT_PER_REQUEST = 1_000;

// DEFAULT_DAILY_CAP_SAT caps cumulative daily spend when PI402_DAILY_CAP_SAT is
// unset.
const DEFAULT_DAILY_CAP_SAT = 100_000;

// readSatCeiling parses a positive-integer sat ceiling from an environment
// variable. A missing value yields the default. A present but non-numeric or
// non-positive value throws, so a typo like "1,000" fails loudly instead of
// silently disabling the cap (Number("1,000") is NaN, and every comparison with
// NaN is false, which would wave all spending through).
export function readSatCeiling(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
	}
	return value;
}

// maxSatPerRequest returns the per-request spend ceiling from the environment.
// The wallet payer reads the same ceiling to assert the quoted total outflow
// before dispatching a send.
export function maxSatPerRequest(): number {
	return readSatCeiling("PI402_MAX_SAT_PER_REQUEST", DEFAULT_MAX_SAT_PER_REQUEST);
}

// utcDayKey returns a stable key for the current UTC calendar day, used to reset
// the daily counter at the day boundary.
function utcDayKey(now: Date): string {
	return now.toISOString().slice(0, 10);
}

// buildBudgetPolicy constructs the buyer policy from environment ceilings. The
// policy is asserted before any wallet action, on the quoted total outflow
// (invoice principal plus swap fee), so a runaway session cannot drain the
// wallet.
export function buildBudgetPolicy(_pi: ExtensionAPI): BuyerPolicy {
	const perRequestCap = maxSatPerRequest();
	const dailyCapSat = readSatCeiling("PI402_DAILY_CAP_SAT", DEFAULT_DAILY_CAP_SAT);

	// spentToday tracks cumulative spend for the daily ceiling, reset at the UTC
	// day boundary. It is process local; a durable ledger keyed by wallet is
	// future work.
	let spentToday = 0;
	let currentDay = utcDayKey(new Date());

	return {
		async assertAllowed(ctx: { amountSat: number; host: string; url: string; routeId?: string }): Promise<void> {
			const day = utcDayKey(new Date());
			if (day !== currentDay) {
				currentDay = day;
				spentToday = 0;
			}

			if (ctx.amountSat > perRequestCap) {
				throw new Error(`payment ${ctx.amountSat} sat exceeds per-request cap ${perRequestCap} sat`);
			}
			if (spentToday + ctx.amountSat > dailyCapSat) {
				throw new Error(`payment would exceed daily cap ${dailyCapSat} sat`);
			}

			// NOTE: the counter is incremented here, before the wallet actually
			// pays. The paying fetch calls assertAllowed ahead of settlement and
			// exposes no post-payment callback, so a failed payment is not rolled
			// back off the daily counter. This errs conservative (a failed
			// payment still consumes budget), which is the safe direction for a
			// spend cap; a clean rollback needs a hook the library does not offer.
			spentToday += ctx.amountSat;
		},
	};
}

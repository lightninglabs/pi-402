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

// PaymentScheme selects which HTTP authentication schemes the buyer will
// answer a 402 with.
export type PaymentScheme = "auto" | "l402";

// paymentScheme reads the scheme preference from PI402_PAYMENT_SCHEME.
//
// The default is "auto": take a Payment (MPP) offer when the seller makes
// one, and fall back to L402 otherwise. Aperture with --enablempp offers both
// in a single merged WWW-Authenticate, so "auto" is what exercises MPP.
// Setting "l402" pins the buyer to the older scheme, which is the escape
// hatch if a seller's Payment offer turns out to be unsatisfiable.
//
// An unrecognized value throws rather than silently falling back. A typo in
// the scheme name should not quietly change which protocol the money moves
// over.
export function paymentScheme(): PaymentScheme {
	const raw = process.env.PI402_PAYMENT_SCHEME;
	if (raw === undefined || raw === "") {
		return "auto";
	}

	const value = raw.trim().toLowerCase();
	if (value === "auto" || value === "l402") {
		return value;
	}

	throw new Error(`PI402_PAYMENT_SCHEME must be "auto" or "l402", got ${JSON.stringify(raw)}`);
}

// mppIntents returns the Payment intents to accept, most wanted first.
//
// Under "l402" the list is empty, so no Payment offer matches and the buyer
// takes the L402 door. Otherwise the default is "charge" alone: a session
// holds a deposit the seller owes back, and reclaiming it needs a refund
// invoice the wallet must mint and a close the process must remember to
// send. Charge settles each request on its own and leaves nothing
// outstanding, which is the right default for a wallet running unattended
// inside an editor.
//
// PI402_MPP_INTENTS opts into more, as a comma-separated preference list
// drawn from "session" and "charge". Opting into sessions currently also
// requires PI402_MPP_ALLOW_REFUNDLESS_SESSION=1: the protocol reclaims a
// session's unspent deposit through an amountless return invoice minted at
// open, and the swap-backed embedded wallet cannot mint amountless invoices
// yet, so every session it opens forfeits whatever balance is left at close.
// That is an acceptable cost on a test network and a deliberate one anywhere
// else, which is exactly what an explicit opt-in encodes.
export function mppIntents(): readonly string[] {
	if (paymentScheme() === "l402") {
		return [];
	}

	const raw = process.env.PI402_MPP_INTENTS;
	if (raw === undefined || raw === "") {
		return ["charge"];
	}

	const intents = raw
		.split(",")
		.map((intent) => intent.trim().toLowerCase())
		.filter((intent) => intent !== "");

	for (const intent of intents) {
		if (intent !== "charge" && intent !== "session") {
			throw new Error(`PI402_MPP_INTENTS entries must be "charge" or "session", got ${JSON.stringify(intent)}`);
		}
	}
	if (intents.length === 0) {
		throw new Error("PI402_MPP_INTENTS must name at least one intent when set");
	}

	if (intents.includes("session") && !allowRefundlessSessions()) {
		throw new Error(
			"PI402_MPP_INTENTS includes sessions, but the embedded wallet cannot mint the amountless " +
				"refund invoice a session needs, so any unspent deposit is forfeited at close; set " +
				"PI402_MPP_ALLOW_REFUNDLESS_SESSION=1 to accept that",
		);
	}

	return intents;
}

// allowRefundlessSessions reports whether the operator has accepted that a
// session's unspent deposit is forfeited at close. See mppIntents for why
// this is currently a precondition of the session intent at all.
export function allowRefundlessSessions(): boolean {
	return process.env.PI402_MPP_ALLOW_REFUNDLESS_SESSION === "1";
}

// utcDayKey returns a stable key for the current UTC calendar day, used to reset
// the daily counter at the day boundary.
function utcDayKey(now: Date): string {
	return now.toISOString().slice(0, 10);
}

// SpentTodaySource supplies the sats already spent on the current UTC day,
// typically summed from the durable receipt ledger.
export interface SpentTodaySource {
	spentTodaySat(): Promise<number>;
}

// buildBudgetPolicy constructs the buyer policy from environment ceilings. The
// policy is asserted before any wallet action, on the quoted total outflow
// (invoice principal plus swap fee), so a runaway session cannot drain the
// wallet.
//
// With a spentToday source, the ledger is read fresh on every assertion and
// combined with the in-memory counter, so neither a restart nor a concurrent
// session can reset the day's spend to zero.
export function buildBudgetPolicy(_pi: ExtensionAPI, spentTodaySource?: SpentTodaySource): BuyerPolicy {
	const perRequestCap = maxSatPerRequest();
	const dailyCapSat = readSatCeiling("PI402_DAILY_CAP_SAT", DEFAULT_DAILY_CAP_SAT);

	// spentToday tracks cumulative spend for the daily ceiling, reset at the UTC
	// day boundary.
	let spentToday = 0;
	let currentDay = utcDayKey(new Date());

	return {
		async assertAllowed(ctx: { amountSat: number; host: string; url: string; routeId?: string }): Promise<void> {
			// Read the ledger fresh on every assertion: it is the shared
			// ground truth across restarts and concurrent sessions. Payments
			// are rare and the file is small, so the read is cheap. An
			// unreadable ledger degrades to the in-memory counter alone; the
			// degradation is logged because a spend cap silently losing its
			// memory should never be invisible.
			let ledgerToday = 0;
			if (spentTodaySource) {
				try {
					ledgerToday = await spentTodaySource.spentTodaySat();
				} catch (err) {
					console.warn("pi-402: receipt ledger unreadable, daily cap using in-memory spend only:", err);
				}
			}

			// Everything below is synchronous, so concurrent assertions in
			// this process cannot interleave between the check and the
			// counter update.
			const day = utcDayKey(new Date());
			if (day !== currentDay) {
				currentDay = day;
				spentToday = 0;
			}

			if (ctx.amountSat > perRequestCap) {
				throw new Error(`payment ${ctx.amountSat} sat exceeds per-request cap ${perRequestCap} sat`);
			}

			// The in-memory counter carries in-flight amounts the ledger
			// cannot see yet (and quotes for payments that later failed);
			// the ledger carries settled spends from other sessions this
			// counter never saw. Take the max: it is conservative under
			// either gap. Units differ slightly, quoted face value in the
			// counter vs fee-inclusive paidSat in the ledger, which also
			// errs on the conservative side.
			//
			// The residual overshoot bound across sessions is the sum of
			// all in-flight (asserted, not yet settled) amounts in OTHER
			// processes, each bounded by their per-request cap; unsettled
			// spends are invisible to this process until they reach the
			// ledger.
			const effectiveSpent = Math.max(spentToday, ledgerToday);
			if (effectiveSpent + ctx.amountSat > dailyCapSat) {
				throw new Error(`payment would exceed daily cap ${dailyCapSat} sat`);
			}

			// NOTE: the counter is incremented here, before the wallet actually
			// pays. The paying fetch calls assertAllowed ahead of settlement and
			// exposes no post-payment callback, so a failed payment is not rolled
			// back off the daily counter. This errs conservative (a failed
			// payment still consumes budget), which is the safe direction for a
			// spend cap; a clean rollback needs a hook the library does not offer.
			spentToday = effectiveSpent + ctx.amountSat;
		},
	};
}

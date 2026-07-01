import type { BuyerPolicy } from "@aperture/core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// buildBudgetPolicy constructs the buyer policy from environment ceilings. The
// policy is asserted before any wallet action, on the quoted total outflow
// (invoice principal plus swap fee), so a runaway session cannot drain the
// wallet.
export function buildBudgetPolicy(_pi: ExtensionAPI): BuyerPolicy {
	const maxSatPerRequest = Number(process.env.PI402_MAX_SAT_PER_REQUEST ?? 1_000);
	const dailyCapSat = Number(process.env.PI402_DAILY_CAP_SAT ?? 100_000);

	// spentToday tracks cumulative spend for the daily ceiling. It is process
	// local; a durable ledger keyed by wallet is future work.
	let spentToday = 0;

	return {
		async assertAllowed(ctx: { amountSat: number; host: string; url: string; routeId?: string }): Promise<void> {
			if (ctx.amountSat > maxSatPerRequest) {
				throw new Error(`payment ${ctx.amountSat} sat exceeds per-request cap ${maxSatPerRequest} sat`);
			}
			if (spentToday + ctx.amountSat > dailyCapSat) {
				throw new Error(`payment would exceed daily cap ${dailyCapSat} sat`);
			}
			spentToday += ctx.amountSat;
		},
	};
}

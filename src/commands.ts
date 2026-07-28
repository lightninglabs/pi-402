import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WalletService } from "./wallet.ts";

// registerWalletCommands wires the /wallet, /deposit, and /balance slash
// commands. They surface the wallet's funding state to the user, out of band
// from the inference path — the agent core never sees a boarding address.
export function registerWalletCommands(pi: ExtensionAPI, wallet: WalletService): void {
	pi.registerCommand("wallet", {
		description: "Show the pi-402 wallet status and balance",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const balance = await wallet.confirmedBalanceSat();
			ctx.ui.setStatus("pi-402", `⚡ ${balance} sat`);
			ctx.ui.notify(`pi-402 wallet: ${balance} sat confirmed`, "info");
		},
	});

	pi.registerCommand("deposit", {
		description: "Show an on-chain boarding address to fund the wallet",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const address = await wallet.depositAddress();
			ctx.ui.notify(`Fund your pi-402 wallet by sending on-chain funds to: ${address}`, "info");
		},
	});

	pi.registerCommand("fund", {
		description: "Show a Lightning invoice to fund the wallet (/fund <sats>)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// An on-chain deposit needs a confirmation plus an Ark round before
			// it is spendable; an invoice receive settles through a swap in
			// seconds, so this is the path worth reaching for when funding
			// interactively.
			const amountSat = parseFundAmount(args);
			if (amountSat === null) {
				ctx.ui.notify("Usage: /fund <sats>, for example /fund 50000", "error");
				return;
			}

			const invoice = await wallet.receiveInvoice(amountSat);
			ctx.ui.notify(`Pay this invoice to add ${amountSat} sat to your pi-402 wallet:\n\n${invoice}`, "info");
		},
	});

	pi.registerCommand("balance", {
		description: "Show the confirmed wallet balance",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const balance = await wallet.confirmedBalanceSat();
			ctx.ui.notify(`Confirmed balance: ${balance} sat`, "info");
		},
	});
}

// parseFundAmount reads the sat amount off a /fund invocation, returning null
// when it is missing or not a positive whole number. Underscores and commas are
// tolerated, since a funding amount is exactly the kind of number people group
// the digits of.
export function parseFundAmount(args: string): number | null {
	const raw = args.trim().replace(/[_,]/g, "");
	if (!/^\d+$/.test(raw)) {
		return null;
	}

	const amountSat = Number(raw);
	return Number.isSafeInteger(amountSat) && amountSat > 0 ? amountSat : null;
}

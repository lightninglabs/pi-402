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

	pi.registerCommand("balance", {
		description: "Show the confirmed wallet balance",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const balance = await wallet.confirmedBalanceSat();
			ctx.ui.notify(`Confirmed balance: ${balance} sat`, "info");
		},
	});
}

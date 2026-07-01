import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WalletService } from "./wallet.ts";

// registerWalletCommands wires the /wallet, /deposit, and /balance slash
// commands. They surface the wallet's funding state to the user, out of band
// from the inference path — the agent core never sees a boarding address.
export function registerWalletCommands(pi: ExtensionAPI, wallet: WalletService): void {
	pi.registerCommand("wallet", {
		description: "Show the pi-402 wallet status and balance",
		handler: async (ctx) => {
			const balance = await wallet.confirmedBalanceSat();
			ctx.ui.setStatus?.(`pi-402 wallet: ${balance} sat`);
		},
	});

	pi.registerCommand("deposit", {
		description: "Show an on-chain boarding address to fund the wallet",
		handler: async (ctx) => {
			const address = await wallet.depositAddress();
			ctx.sendMessage(`Fund your pi-402 wallet by sending on-chain funds to:\n\n${address}`);
		},
	});

	pi.registerCommand("balance", {
		description: "Show the confirmed wallet balance",
		handler: async (ctx) => {
			const balance = await wallet.confirmedBalanceSat();
			ctx.sendMessage(`Confirmed balance: ${balance} sat`);
		},
	});
}

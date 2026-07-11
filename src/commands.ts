import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FileReceiptLog } from "./store.ts";
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

// registerReceiptCommands wires the /receipts slash command over the durable
// payment ledger: today's spend, the all-time total, and the most recent
// payments with their proof-of-payment hashes.
export function registerReceiptCommands(pi: ExtensionAPI, receiptLog: FileReceiptLog): void {
	pi.registerCommand("receipts", {
		description: "Show L402 payment receipts and spend totals",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const receipts = await receiptLog.readAll();
			if (receipts.length === 0) {
				ctx.ui.notify("No payments recorded yet.", "info");
				return;
			}

			const totalSat = receipts.reduce((sum, r) => sum + (r.paidSat ?? r.amountSat ?? 0), 0);
			const todaySat = await receiptLog.spentTodaySat();

			const recent = receipts
				.slice(-10)
				.reverse()
				.map((r) => {
					const model = r.model ?? "unknown-model";
					const paid = r.paidSat ?? r.amountSat ?? 0;
					const when = r.timestamp?.replace("T", " ").slice(0, 19) ?? "unknown-time";
					return `${when}  ${paid} sat  ${model}  ${r.paymentHash.slice(0, 12)}…`;
				})
				.join("\n");

			ctx.ui.notify(
				`pi-402 receipts: ${receipts.length} payment(s), ${totalSat} sat all-time, ${todaySat} sat today\n${recent}`,
				"info",
			);
		},
	});
}

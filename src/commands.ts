import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatSat } from "./format.ts";
import { type FileReceiptLog, receiptPaidSat } from "./store.ts";
import { formatFooter } from "./usd.ts";
import { SendDeclinedError, type WalletService, type WalletStatus } from "./wallet.ts";

// registerWalletCommands wires the /wallet, /deposit, /fund, /send and /balance
// slash commands. They surface the wallet's funding state to the user, out of band
// from the inference path — the agent core never sees a boarding address.
export function registerWalletCommands(pi: ExtensionAPI, wallet: WalletService): void {
	pi.registerCommand("wallet", {
		description: "Show the pi-402 wallet: network, spendable, arriving and outgoing sats",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const status = await wallet.status();
			ctx.ui.setStatus(
				"pi-402",
				formatFooter(status.spendableSat, undefined, { outSat: status.outgoingSat, inSat: status.arrivingSat }),
			);
			ctx.ui.notify(formatWalletStatus(status), "info");
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

	pi.registerCommand("send", {
		description: "Pay a Lightning invoice from the wallet (/send <bolt11>)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// This is a command for the person at the keyboard, not a tool the
			// agent can call. It quotes first, refuses anything over the
			// per-send cap (PI402_MAX_SAT_PER_SEND), and asks for an explicit yes
			// on the quoted total, fee included, before any sats move.
			const invoice = parseSendInvoice(args);
			if (invoice === null) {
				ctx.ui.notify("Usage: /send <lightning invoice>, for example /send lnbc10u1p...", "error");
				return;
			}

			try {
				const result = await wallet.sendInvoice(invoice, (outflowSat) =>
					ctx.ui.confirm("Send payment?", `Pay ${outflowSat} sat (including fees) from your pi-402 wallet?`),
				);
				const balance = await wallet.confirmedBalanceSat();
				ctx.ui.setStatus("pi-402", `⚡ ${balance} sat`);
				ctx.ui.notify(
					`Sent ${result.amountPaidSat} sat (${balance} sat left). Preimage: ${result.preimageHex.slice(0, 16)}…`,
					"info",
				);
			} catch (err) {
				if (err instanceof SendDeclinedError) {
					ctx.ui.notify("Send cancelled. Nothing was paid.", "info");
					return;
				}
				ctx.ui.notify(`Send failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
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

// formatWalletStatus renders the /wallet report, ending with a next step when
// the wallet is syncing, empty, or has a deposit arriving.
export function formatWalletStatus(status: WalletStatus): string {
	const network = status.network ? ` (${status.network})` : "";
	const lines = [`pi-402 wallet${network}`, `  spendable  ${formatSat(status.spendableSat)} sat`];
	if (status.arrivingSat > 0) {
		lines.push(`  arriving   ${formatSat(status.arrivingSat)} sat`);
	}
	if (status.outgoingSat > 0) {
		lines.push(`  outgoing   ${formatSat(status.outgoingSat)} sat`);
	}
	if (status.creditSat > 0) {
		lines.push(`  credit     ${formatSat(status.creditSat)} sat`);
	}

	// A wallet that is not ready can read zero for money it has.
	if (!status.ready) {
		lines.push(
			"",
			"The wallet is still starting up or syncing, so these numbers may be low. Run /wallet again in a moment.",
		);
	} else if (status.arrivingSat > 0) {
		lines.push("", "Deposit on the way: spendable once it confirms and joins the next Ark round (about 30 min).");
	} else if (status.spendableSat === 0 && status.creditSat === 0) {
		lines.push(
			"",
			"The wallet is empty. Run /fund <sats> to pay in over Lightning (seconds), or /deposit for an on-chain address (a confirmation plus an Ark round).",
		);
	}
	return lines.join("\n");
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

// parseSendInvoice reads a BOLT11 invoice off a /send invocation, returning null
// when it does not look like one. A leading "lightning:" URI scheme is dropped,
// since that is how wallets and QR codes usually hand an invoice over. This is
// only a shape check: the wallet's quote is what actually validates the invoice
// and its network.
export function parseSendInvoice(args: string): string | null {
	const raw = args
		.trim()
		.replace(/^lightning:/i, "")
		.toLowerCase();
	return /^ln(bc|tb|tbs|bcrt)[0-9]*[munp]?1[02-9ac-hj-np-z]{50,}$/.test(raw) ? raw : null;
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

			// One read serves all three views; the day total filters the
			// records already in hand.
			const day = new Date().toISOString().slice(0, 10);
			const totalSat = receipts.reduce((sum, r) => sum + receiptPaidSat(r), 0);
			const todaySat = receipts
				.filter((r) => r.timestamp?.slice(0, 10) === day)
				.reduce((sum, r) => sum + receiptPaidSat(r), 0);

			const recent = receipts
				.slice(-10)
				.reverse()
				.map((r) => {
					const model = r.model ?? "unknown-model";
					const when = r.timestamp?.replace("T", " ").slice(0, 19) ?? "unknown-time";
					return `${when}  ${receiptPaidSat(r)} sat  ${model}  ${r.paymentHash.slice(0, 12)}…`;
				})
				.join("\n");

			ctx.ui.notify(
				`pi-402 receipts: ${receipts.length} payment(s), ${totalSat} sat all-time, ${todaySat} sat today\n${recent}`,
				"info",
			);
		},
	});
}

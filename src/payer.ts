import type { InvoicePayer } from "@lightninglabs/aperture-core";
import type { WalletService } from "./wallet.ts";

// PayInvoiceInput is the L402 buyer loop's request to pay a challenge invoice.
interface PayInvoiceInput {
	invoice: string;
	amountSat: number;
	challengeId: string;
}

// MockInvoicePayer returns a fixed preimage without paying anything. It exists
// so the buyer loop can be exercised end to end with no wallet and no
// Lightning at all.
export class MockInvoicePayer implements InvoicePayer {
	async payInvoice(input: PayInvoiceInput): Promise<{ preimageHex: string; amountPaidSat: number }> {
		return { preimageHex: "00".repeat(32), amountPaidSat: input.amountSat };
	}
}

// WalletInvoicePayer pays an L402 invoice through the embedded walletdk wallet.
// walletdk hides the Ark↔Lightning swap: prepareSend quotes it (surfacing the
// swap fee for the budget check), sendPrepared dispatches it, and the preimage
// is read off the settled activity entry once the swap completes.
export class WalletInvoicePayer implements InvoicePayer {
	private readonly wallet: WalletService;

	constructor(wallet: WalletService) {
		this.wallet = wallet;
	}

	async payInvoice(input: PayInvoiceInput): Promise<{ preimageHex: string; amountPaidSat: number }> {
		return this.wallet.payInvoice(input.invoice, input.amountSat);
	}
}

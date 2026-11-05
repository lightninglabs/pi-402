import type { InvoicePayer } from "@lightninglabs/aperture-core";
import type { WalletService } from "./wallet.ts";

// PayInvoiceInput is the L402 buyer loop's request to pay a challenge invoice.
interface PayInvoiceInput {
	invoice: string;
	amountSat: number;
	challengeId: string;
}

// PaidHook is told about each payment the wallet settles.
export type PaidHook = (paid: { amountPaidSat: number }) => void | Promise<void>;

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
	private readonly onPaid?: PaidHook;

	// onPaid runs after each successful payment, for display only: it is not
	// awaited and a failure in it is swallowed, so it can never delay a
	// payment's preimage or turn a settled payment into an error.
	constructor(wallet: WalletService, onPaid?: PaidHook) {
		this.wallet = wallet;
		this.onPaid = onPaid;
	}

	async payInvoice(input: PayInvoiceInput): Promise<{ preimageHex: string; amountPaidSat: number }> {
		const result = await this.wallet.payInvoice(input.invoice, input.amountSat);

		if (this.onPaid) {
			const hook = this.onPaid;
			void Promise.resolve()
				.then(() => hook({ amountPaidSat: result.amountPaidSat }))
				.catch(() => {});
		}

		return result;
	}
}

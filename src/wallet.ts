// The global installed by the walletdk-wasm bridge once the runtime is loaded.
// See darepo-client cmd/walletdk-wasm/main.go; it dispatches a method name plus
// a request object and resolves the verb's JSON response.
declare const walletdkCall: (method: string, req?: unknown) => Promise<any>;

export interface PayResult {
	preimageHex: string;
	amountPaidSat: number;
}

// WalletService wraps the embedded walletdk WASM instance. It loads and unlocks
// the wallet, and exposes the operations the extension needs: paying an L402
// invoice, reading the balance, and producing a boarding address for deposits.
export class WalletService {
	private ready = false;

	// startAndUnlock loads the walletdk WASM runtime and unlocks the wallet. It
	// is bootstrapped once per session from the session_start hook.
	async startAndUnlock(): Promise<void> {
		if (this.ready) {
			return;
		}
		// TODO(milestone-3): load walletdk.wasm + the wasm_exec glue, then start
		// and unlock the wallet:
		//   await walletdkCall("start", this.config());
		//   await walletdkCall("unlockWallet", { ... });
		this.ready = true;
	}

	// payInvoice pays a BOLT11 invoice via a two-phase walletdk send. prepareSend
	// quotes the payment (including the swap fee), sendPrepared dispatches it, and
	// the preimage is read from the settled entry once the swap completes.
	async payInvoice(invoice: string, amountSat: number): Promise<PayResult> {
		const quote = await walletdkCall("prepareSend", { invoice });
		await walletdkCall("sendPrepared", { send_intent_id: quote.send_intent_id });
		const preimageHex = await this.awaitPreimage(quote.payment_hash);
		return { preimageHex, amountPaidSat: quote.amount_sat ?? amountSat };
	}

	// confirmedBalanceSat returns the spendable wallet balance in sats.
	async confirmedBalanceSat(): Promise<number> {
		return walletdkCall("confirmedBalanceSat");
	}

	// depositAddress returns an on-chain boarding address to fund the wallet.
	async depositAddress(): Promise<string> {
		const res = await walletdkCall("deposit");
		return res.address;
	}

	// awaitPreimage watches the wallet activity stream until the send for the
	// given payment hash settles, then returns its preimage.
	//
	// This depends on darepo-client#835: the preimage rides WalletEntryProgress
	// on the settled entry, delivered over the existing subscribe stream. Until
	// that lands, the extension runs against the mock payer instead.
	private async awaitPreimage(paymentHash: string): Promise<string> {
		// TODO(darepo-client#835): subscribe → COMPLETE → entry.progress.preimage.
		throw new Error(`awaitPreimage not yet implemented for ${paymentHash} (needs darepo-client#835)`);
	}
}

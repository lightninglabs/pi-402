import { readFileSync } from "node:fs";
import { join } from "node:path";

// The walletdk WASM bridge (darepo-client cmd/walletdk-wasm) installs a global
// walletdkCall(method, request) dispatcher once the Go runtime is up. Requests
// take proto-style snake_case fields; responses are the SDK's Go structs and
// marshal with PascalCase fields (SendIntentID, PaymentHash, Entry.Progress).
type WalletdkCall = (method: string, req?: unknown) => Promise<any>;

// SubscriptionHandle is what walletdkCall("subscribe") resolves to: a pull
// stream of wallet entries.
interface SubscriptionHandle {
	next(): Promise<any | null>;
	close(): void;
}

export interface PayResult {
	preimageHex: string;
	amountPaidSat: number;
}

// PREIMAGE_TIMEOUT_MS bounds how long a send may take to settle before the
// payer gives up. Ark↔Lightning swaps take seconds; minutes means stuck.
const PREIMAGE_TIMEOUT_MS = 120_000;

// WalletService wraps the embedded walletdk WASM instance. It loads and
// unlocks the wallet, and exposes the operations the extension needs: paying
// an L402 invoice, reading the balance, and producing a boarding address for
// deposits.
export class WalletService {
	private ready = false;
	private call: WalletdkCall | undefined;

	// startAndUnlock loads the walletdk WASM runtime and unlocks the wallet. It
	// is bootstrapped once per session from the session_start hook.
	async startAndUnlock(): Promise<void> {
		if (this.ready) {
			return;
		}

		this.call = await loadWalletdk();

		await this.call("start", startConfigFromEnv());

		// Unlock an existing wallet, creating one on the first run.
		const password = process.env.PI402_WALLET_PASSWORD ?? "pi402-dev";
		try {
			await this.call("unlockWallet", { wallet_password: password });
		} catch {
			await this.call("createWallet", { wallet_password: password });
		}

		this.ready = true;
	}

	// payInvoice pays a BOLT11 invoice via a two-phase walletdk send.
	// prepareSend quotes the payment (including the swap fee), sendPrepared
	// dispatches it, and the preimage is read from the settled entry once the
	// swap completes (darepo-client#835).
	async payInvoice(invoice: string, amountSat: number): Promise<PayResult> {
		const call = this.requireCall();

		const quote = await call("prepareSend", { invoice });
		await call("sendPrepared", { send_intent_id: quote.SendIntentID });

		const preimageHex = await this.awaitPreimage(quote.PaymentHash);

		return {
			preimageHex,
			amountPaidSat: quote.AmountSat || amountSat,
		};
	}

	// confirmedBalanceSat returns the spendable wallet balance in sats.
	async confirmedBalanceSat(): Promise<number> {
		return this.requireCall()("confirmedBalanceSat");
	}

	// depositAddress returns an on-chain boarding address to fund the wallet.
	async depositAddress(): Promise<string> {
		const res = await this.requireCall()("deposit", {});
		return res.Address ?? res.address;
	}

	// awaitPreimage watches the wallet activity stream until the send for the
	// given payment hash settles, then returns its preimage. The preimage rides
	// Entry.Progress.Preimage on the COMPLETE entry (darepo-client#835).
	private async awaitPreimage(paymentHash: string): Promise<string> {
		const call = this.requireCall();
		const handle: SubscriptionHandle = await call("subscribe", {
			include_existing: true,
		});

		const timeout = setTimeout(() => handle.close(), PREIMAGE_TIMEOUT_MS);
		try {
			for (;;) {
				const entry = await handle.next();
				if (entry === null) {
					throw new Error(`timed out waiting for preimage of ${paymentHash}`);
				}
				if (entry.Progress?.PaymentHash !== paymentHash) {
					continue;
				}
				if (entry.Status === "failed") {
					throw new Error(`send failed: ${entry.FailureReason ?? "unknown"}`);
				}
				if (entry.Progress?.Preimage) {
					return entry.Progress.Preimage;
				}
			}
		} finally {
			clearTimeout(timeout);
			handle.close();
		}
	}

	private requireCall(): WalletdkCall {
		if (!this.call) {
			throw new Error("wallet not started; run startAndUnlock first");
		}
		return this.call;
	}
}

// startConfigFromEnv builds the walletdk start config. Defaults target the
// local regtest harness; production deployments override via env.
function startConfigFromEnv(): Record<string, unknown> {
	return {
		network: process.env.PI402_NETWORK ?? "regtest",
		data_dir: process.env.PI402_WALLET_DIR ?? "/darepo",
		server_address: process.env.PI402_ARK_SERVER ?? "127.0.0.1:10009",
		server_insecure: true,
		swap_server_address: process.env.PI402_SWAP_SERVER ?? "127.0.0.1:8082",
		swap_server_insecure: true,
		wallet_esplora_url: process.env.PI402_ESPLORA_URL ?? "http://127.0.0.1:3002",
		allow_mainnet: (process.env.PI402_NETWORK ?? "regtest") === "mainnet",
	};
}

// loadWalletdk instantiates the walletdk WASM binary under Node and resolves
// the walletdkCall global. The artifact directory (walletdk.wasm plus Go's
// wasm_exec.js glue, built with `make wasm-wallet` in darepo-client) is
// located via PI402_WASM_DIR or a bundled ./wasm directory.
//
// NOTE: the WASM's SQLite persistence targets browser OPFS; running under
// Node is exercised by the e2e tiers and may need an in-memory data_dir.
async function loadWalletdk(): Promise<WalletdkCall> {
	const existing = (globalThis as any).walletdkCall;
	if (typeof existing === "function") {
		return existing as WalletdkCall;
	}

	const wasmDir = process.env.PI402_WASM_DIR ?? join(import.meta.dirname, "..", "wasm");

	// Evaluate Go's wasm_exec.js glue, which defines globalThis.Go.
	const glue = readFileSync(join(wasmDir, "wasm_exec.js"), "utf8");
	// eslint-disable-next-line no-new-func
	new Function(glue)();

	const GoRuntime = (globalThis as any).Go;
	if (!GoRuntime) {
		throw new Error("wasm_exec.js did not define the Go runtime");
	}

	const go = new GoRuntime();
	const wasmBytes = readFileSync(join(wasmDir, "walletdk.wasm"));
	const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);

	// The Go program runs for the lifetime of the process; do not await it.
	void go.run(instance);

	// The bridge installs walletdkCall and fires walletdk-ready when up.
	await waitForGlobal("walletdkCall", 30_000);

	return (globalThis as any).walletdkCall as WalletdkCall;
}

// waitForGlobal polls for a global symbol installed by the WASM bridge.
async function waitForGlobal(name: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (typeof (globalThis as any)[name] !== "function") {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`walletdk WASM did not install ${name} within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

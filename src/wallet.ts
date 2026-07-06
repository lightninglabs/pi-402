import { readFileSync } from "node:fs";
import { join } from "node:path";

// WalletService runs against one of two walletdk backends:
//
// - **Sidecar** (PI402_WALLETD_GATEWAY set): a native darepod built with the
//   walletdkrpc tag, driven over its HTTP/JSON gateway (default
//   localhost:10031). This is the path for Node hosts like Pi, where the
//   WASM's OPFS-backed SQLite is unavailable.
// - **Embedded WASM**: the walletdk-wasm bridge in-process, for browser-like
//   hosts with OPFS. The bridge installs a global walletdkCall dispatcher;
//   requests take proto-style snake_case fields while responses marshal the
//   SDK's Go structs with PascalCase fields.
type WalletdkCall = (method: string, req?: unknown) => Promise<any>;

// SubscriptionHandle is what the WASM bridge's subscribe resolves to: a pull
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

// WalletService exposes the operations the extension needs: paying an L402
// invoice, reading the balance, and producing a boarding address for
// deposits.
export class WalletService {
	private ready = false;
	private gateway: string | undefined;
	private call: WalletdkCall | undefined;

	// startAndUnlock brings up the selected backend and unlocks the wallet,
	// creating it on the first run. It is bootstrapped once per session from
	// the session_start hook.
	async startAndUnlock(): Promise<void> {
		if (this.ready) {
			return;
		}

		const password = process.env.PI402_WALLET_PASSWORD ?? "pi402-dev-password";

		this.gateway = process.env.PI402_WALLETD_GATEWAY;
		if (this.gateway) {
			// Sidecar mode: the daemon is already running; just unlock.
			const passwordB64 = Buffer.from(password).toString("base64");
			try {
				await this.rest("/v1/wallet/unlock", { wallet_password: passwordB64 });
			} catch {
				await this.rest("/v1/wallet/create", { wallet_password: passwordB64 });
			}
			this.ready = true;
			return;
		}

		this.call = await loadWalletdk();
		await this.call("start", startConfigFromEnv());
		try {
			await this.call("unlockWallet", { wallet_password: password });
		} catch {
			await this.call("createWallet", { wallet_password: password });
		}
		this.ready = true;
	}

	// payInvoice pays a BOLT11 invoice via a two-phase walletdk send.
	// prepareSend quotes the payment (including the swap fee), send
	// dispatches it, and the preimage is read from the settled entry once
	// the swap completes (darepo-client#835).
	async payInvoice(invoice: string, amountSat: number): Promise<PayResult> {
		if (this.gateway) {
			const quote = await this.rest("/v1/wallet/prepare-send", { invoice });
			await this.rest("/v1/wallet/send", { send_intent_id: quote.send_intent_id });
			const preimageHex = await this.awaitPreimageRest(quote.payment_hash);
			return {
				preimageHex,
				amountPaidSat: Number(quote.amount_sat) || amountSat,
			};
		}

		const call = this.requireCall();
		const quote = await call("prepareSend", { invoice });
		await call("sendPrepared", { send_intent_id: quote.SendIntentID });
		const preimageHex = await this.awaitPreimageWasm(quote.PaymentHash);
		return {
			preimageHex,
			amountPaidSat: quote.AmountSat || amountSat,
		};
	}

	// confirmedBalanceSat returns the spendable wallet balance in sats.
	async confirmedBalanceSat(): Promise<number> {
		if (this.gateway) {
			const res = await this.rest("/v1/wallet/balance", {});
			return Number(res.confirmed_sat);
		}
		return this.requireCall()("confirmedBalanceSat");
	}

	// depositAddress returns an on-chain boarding address to fund the wallet.
	async depositAddress(): Promise<string> {
		if (this.gateway) {
			const res = await this.rest("/v1/wallet/deposit", {});
			return res.onchain_address;
		}
		const res = await this.requireCall()("deposit", {});
		return res.Address ?? res.address;
	}

	// awaitPreimageRest watches the gateway's SubscribeWallet NDJSON stream
	// until the send for the given payment hash settles, then returns the
	// preimage riding entry.progress.preimage (darepo-client#835).
	private async awaitPreimageRest(paymentHash: string): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), PREIMAGE_TIMEOUT_MS);

		try {
			const res = await fetch(`${this.gateway}/v1/wallet/subscribe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ include_existing: true }),
				signal: controller.signal,
			});
			if (!res.ok || !res.body) {
				throw new Error(`subscribe failed: ${res.status}`);
			}

			// The gateway frames server-streamed responses as
			// newline-delimited JSON objects: {"result": <WalletEntry>}.
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					throw new Error(`subscribe stream ended before preimage of ${paymentHash}`);
				}
				buffer += decoder.decode(value, { stream: true });

				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (!line) {
						continue;
					}

					const frame = JSON.parse(line);
					const entry = frame.result ?? frame;
					const progress = entry.progress;
					if (progress?.payment_hash !== paymentHash) {
						continue;
					}
					if (entry.status === "ENTRY_STATUS_FAILED") {
						throw new Error(`send failed: ${entry.failure_reason ?? "unknown"}`);
					}
					if (progress?.preimage) {
						return progress.preimage;
					}
				}
			}
		} finally {
			clearTimeout(timeout);
			controller.abort();
		}
	}

	// awaitPreimageWasm watches the WASM bridge's activity stream until the
	// send for the given payment hash settles.
	private async awaitPreimageWasm(paymentHash: string): Promise<string> {
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

	// rest issues a unary call against the sidecar's HTTP/JSON gateway. The
	// gateway marshals with proto names, so requests and responses both use
	// snake_case fields; proto bytes fields ride as base64 strings.
	private async rest(path: string, body: unknown): Promise<any> {
		const res = await fetch(`${this.gateway}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(`walletd ${path} failed (${res.status}): ${payload.message ?? ""}`);
		}
		return payload;
	}

	private requireCall(): WalletdkCall {
		if (!this.call) {
			throw new Error("wallet not started; run startAndUnlock first");
		}
		return this.call;
	}
}

// startConfigFromEnv builds the embedded WASM start config. Defaults target
// the local regtest harness; production deployments override via env.
function startConfigFromEnv(): Record<string, unknown> {
	return {
		network: process.env.PI402_NETWORK ?? "regtest",
		data_dir: process.env.PI402_WALLET_DIR ?? "/darepo",
		server_address: process.env.PI402_ARK_SERVER ?? "127.0.0.1:7070",
		server_insecure: true,
		swap_server_address: process.env.PI402_SWAP_SERVER ?? "127.0.0.1:8082",
		swap_server_insecure: true,
		wallet_esplora_url: process.env.PI402_ESPLORA_URL ?? "http://127.0.0.1:3002",
		allow_mainnet: (process.env.PI402_NETWORK ?? "regtest") === "mainnet",
	};
}

// loadWalletdk instantiates the walletdk WASM binary and resolves the
// walletdkCall global. The artifact directory (walletdk.wasm plus Go's
// wasm_exec.js glue, built with `make wasm-wallet` in darepo-client) is
// located via PI402_WASM_DIR or a bundled ./wasm directory.
//
// NOTE: the WASM's SQLite persistence rides sqlite-bridge.js, which needs a
// Web Worker and OPFS; under plain Node the daemon fails at the database
// open. Node hosts should use the sidecar backend (PI402_WALLETD_GATEWAY)
// until the bridge grows a Node story.
async function loadWalletdk(): Promise<WalletdkCall> {
	const existing = (globalThis as any).walletdkCall;
	if (typeof existing === "function") {
		return existing as WalletdkCall;
	}

	// The bridge dispatches lifecycle CustomEvents on globalThis, which is
	// not an EventTarget under Node; back those methods with one.
	const g = globalThis as any;
	if (typeof g.dispatchEvent !== "function") {
		const events = new EventTarget();
		g.addEventListener = events.addEventListener.bind(events);
		g.removeEventListener = events.removeEventListener.bind(events);
		g.dispatchEvent = events.dispatchEvent.bind(events);
	}

	const wasmDir = process.env.PI402_WASM_DIR ?? join(import.meta.dirname, "..", "wasm");

	// Evaluate Go's wasm_exec.js glue, which defines globalThis.Go.
	const glue = readFileSync(join(wasmDir, "wasm_exec.js"), "utf8");
	// eslint-disable-next-line no-new-func
	new Function(glue)();

	const GoRuntime = g.Go;
	if (!GoRuntime) {
		throw new Error("wasm_exec.js did not define the Go runtime");
	}

	const go = new GoRuntime();
	const wasmBytes = readFileSync(join(wasmDir, "walletdk.wasm"));
	const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);

	// The Go program runs for the lifetime of the process; do not await it.
	void go.run(instance);

	// The bridge installs walletdkCall once the runtime is up. It also
	// fires a walletdk-ready event, but that can race the listener, so
	// poll for the global instead.
	await waitForGlobal("walletdkCall", 30_000);

	return g.walletdkCall as WalletdkCall;
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { maxSatPerRequest } from "./policy.ts";

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

// RestWalletStream is an open NDJSON SubscribeWallet stream against the sidecar
// gateway: a reader plus a close hook that aborts the underlying request.
interface RestWalletStream {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	close(): void;
}

// WalletdError is a gateway error carrying the machine-readable cause the
// daemon sent alongside the human-readable message.
interface WalletdError extends Error {
	rpcCode?: number;
	reason?: string;
}

// WALLET_NOT_READY_REASON is the ErrorInfo reason waved returns while no
// wallet has been created yet. It is the signal the bootstrap branches on to
// tell "create one" apart from a daemon that is genuinely broken.
const WALLET_NOT_READY_REASON = "WALLET_NOT_READY";

// errorInfoReason digs the ErrorInfo reason out of a gateway error payload.
// The gateway sends details as a list of typed Any messages, of which the
// ErrorInfo entry is the one carrying a stable reason string.
function errorInfoReason(payload: any): string | undefined {
	if (!Array.isArray(payload?.details)) {
		return undefined;
	}
	for (const detail of payload.details) {
		if (typeof detail?.reason === "string" && detail.reason) {
			return detail.reason;
		}
	}
	return undefined;
}

// DEFAULT_WALLET_PASSWORD is the throwaway password used on non-mainnet dev
// networks. Mainnet refuses to start with it (resolveWalletPassword).
const DEFAULT_WALLET_PASSWORD = "pi402-dev-password";

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

		const password = resolveWalletPassword();

		this.gateway = process.env.PI402_WALLETD_GATEWAY;
		if (this.gateway) {
			// Sidecar mode: the daemon is already running. Only unlock (or
			// create, on the very first run) when the wallet is not already
			// usable; unlocking an unlocked wallet is an error. The status
			// probe genuinely may fail if the daemon is down, so surface that
			// rather than treating it as "not unlocked".
			//
			// One failure is not a fault though: waved answers the probe with
			// FailedPrecondition/WALLET_NOT_READY when no wallet has been
			// created yet, rather than reporting an un-created wallet in the
			// response. That is precisely the state the create path exists to
			// resolve, so it must not abort the bootstrap the way a genuinely
			// unreachable daemon does.
			let unlocked = false;
			try {
				const status = await this.rest("/v1/wallet/status", {});
				unlocked = Boolean(status.unlocked);
			} catch (err) {
				if (!isWalletMissingError(err)) {
					throw err;
				}
			}

			if (!unlocked) {
				const passwordB64 = Buffer.from(password).toString("base64");
				try {
					await this.rest("/v1/wallet/unlock", { wallet_password: passwordB64 });
				} catch (err) {
					// Only create when unlock failed because no wallet exists
					// yet. A wrong password or an unreachable daemon must not
					// fall through to blindly creating a fresh wallet.
					if (!isWalletMissingError(err)) {
						throw err;
					}
					await this.rest("/v1/wallet/create", { wallet_password: passwordB64 });
				}
			}
			this.ready = true;
			return;
		}

		this.call = await loadWalletdk();
		await this.call("start", startConfigFromEnv());
		try {
			await this.call("unlockWallet", { wallet_password: password });
		} catch (err) {
			// As with the sidecar path, only create when the failure genuinely
			// means the wallet does not exist yet; otherwise rethrow so a wrong
			// password or a daemon fault is not masked by a fresh create.
			if (!isWalletMissingError(err)) {
				throw err;
			}
			await this.call("createWallet", { wallet_password: password });
		}
		this.ready = true;
	}

	// payInvoice pays a BOLT11 invoice via a two-phase walletdk send.
	// prepareSend quotes the payment (including the swap fee), send
	// dispatches it, and the preimage is read from the settled entry once
	// the swap completes (darepo-client#835).
	//
	// The budget cap is re-asserted here, after the quote, on the QUOTED TOTAL
	// OUTFLOW (invoice principal plus swap fee) rather than the counterparty's
	// stated amount. The buyer policy runs earlier on the proxy's stated
	// amountSat, but only the quote reveals the invoice's real encoded amount
	// plus the swap fee the wallet will actually pay. We refuse before
	// dispatching send if that total exceeds the per-request ceiling.
	async payInvoice(invoice: string, _amountSat: number): Promise<PayResult> {
		const ceiling = maxSatPerRequest();

		if (this.gateway) {
			const quote = await this.rest("/v1/wallet/prepare-send", { invoice });
			const outflow = quotedOutflowSat(quote);
			assertWithinCeiling(outflow, ceiling);

			// Open the settle stream BEFORE dispatching the send. Subscribing
			// after send relies on include_existing to replay the settle, and a
			// missed settle would spin to the timeout and (with SDK retries
			// disabled upstream) surface as a hard error rather than a second
			// payment. Opening first closes that race.
			const stream = await this.openWalletStreamRest();
			try {
				await this.rest("/v1/wallet/send", { send_intent_id: quote.send_intent_id });
				const preimageHex = await this.readPreimageRest(stream, String(quote.payment_hash));
				return {
					preimageHex,
					amountPaidSat: outflow,
				};
			} finally {
				stream.close();
			}
		}

		const call = this.requireCall();
		const quote = await call("prepareSend", { invoice });
		const outflow = quotedOutflowSat(quote);
		assertWithinCeiling(outflow, ceiling);

		// Same ordering as the sidecar path: subscribe before sendPrepared so a
		// fast settle cannot be missed.
		const handle: SubscriptionHandle = await call("subscribe", { include_existing: true });
		try {
			await call("sendPrepared", { send_intent_id: quote.SendIntentID });
			const preimageHex = await this.readPreimageWasm(handle, String(quote.PaymentHash));
			return {
				preimageHex,
				amountPaidSat: outflow,
			};
		} finally {
			handle.close();
		}
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

	// receiveInvoice returns a BOLT11 invoice for the given amount that any
	// Lightning wallet can pay to fund this one. The daemon sets up the
	// inbound receive through its swap subsystem, so the funds arrive as
	// spendable balance in seconds.
	//
	// This is the fast counterpart to depositAddress: an on-chain boarding
	// deposit costs a confirmation plus an Ark round before it can be spent,
	// which is minutes at best.
	async receiveInvoice(amountSat: number, memo = "pi-402 wallet funding"): Promise<string> {
		if (!Number.isInteger(amountSat) || amountSat <= 0) {
			throw new Error(`funding amount must be a positive whole number of sats, got ${amountSat}`);
		}

		if (this.gateway) {
			const res = await this.rest("/v1/wallet/recv", {
				amt_sat: amountSat,
				memo,
			});
			return res.invoice;
		}

		// The WASM bridge marshals the Go request struct, so its field names
		// are PascalCase; the gateway's JSON gateway uses snake_case. Read the
		// response tolerantly for the same reason.
		const res = await this.requireCall()("receive", {
			AmountSat: amountSat,
			Memo: memo,
		});
		return res.Invoice ?? res.invoice;
	}

	// openWalletStreamRest opens the gateway's SubscribeWallet NDJSON stream. It
	// is opened before the send is dispatched so the settle cannot be missed;
	// the caller reads it via readPreimageRest and must close it.
	private async openWalletStreamRest(): Promise<RestWalletStream> {
		const controller = new AbortController();
		const res = await fetch(`${this.gateway}/v1/wallet/subscribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ include_existing: true }),
			signal: controller.signal,
		});
		if (!res.ok || !res.body) {
			controller.abort();
			throw new Error(`subscribe failed: ${res.status}`);
		}
		return {
			reader: res.body.getReader(),
			close: () => controller.abort(),
		};
	}

	// readPreimageRest reads the gateway's NDJSON WalletEntry stream until the
	// send for the given payment hash settles, then returns the preimage riding
	// entry.progress.preimage (darepo-client#835).
	private async readPreimageRest(stream: RestWalletStream, paymentHash: string): Promise<string> {
		// timedOut distinguishes our own deadline abort from any other read
		// rejection, so the timeout surfaces as a descriptive error rather than
		// a bare AbortError.
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			stream.close();
		}, PREIMAGE_TIMEOUT_MS);

		const { reader } = stream;
		const decoder = new TextDecoder();
		const framer = new NdjsonFramer();
		try {
			for (;;) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch (err) {
					if (timedOut) {
						throw new Error(`timed out waiting for preimage of ${paymentHash}`);
					}
					throw err;
				}
				const { done, value } = chunk;
				if (done) {
					throw new Error(`subscribe stream ended before preimage of ${paymentHash}`);
				}

				for (const line of framer.push(decoder.decode(value, { stream: true }))) {
					const preimage = preimageFromFrame(JSON.parse(line), paymentHash);
					if (preimage !== undefined) {
						return preimage;
					}
				}
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	// readPreimageWasm reads the WASM bridge's activity stream until the send
	// for the given payment hash settles. The handle is opened by the caller
	// before the send is dispatched, and closed by the caller.
	private async readPreimageWasm(handle: SubscriptionHandle, paymentHash: string): Promise<string> {
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			handle.close();
		}, PREIMAGE_TIMEOUT_MS);
		try {
			for (;;) {
				const entry = await handle.next();
				if (entry === null) {
					if (timedOut) {
						throw new Error(`timed out waiting for preimage of ${paymentHash}`);
					}
					throw new Error(`subscribe stream ended before preimage of ${paymentHash}`);
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
			const err = new Error(`walletd ${path} failed (${res.status}): ${payload.message ?? ""}`) as WalletdError;
			// The gateway reports the machine-readable cause in an ErrorInfo
			// detail. Carry the code and reason onto the error so callers can
			// branch on them instead of matching prose, which changes between
			// daemon releases in a way the wire contract does not.
			err.rpcCode = typeof payload.code === "number" ? payload.code : undefined;
			err.reason = errorInfoReason(payload);
			throw err;
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
	const network = process.env.PI402_NETWORK ?? "regtest";
	const isMainnet = network === "mainnet";

	// Insecure transport is a dev-harness affordance for the local regtest/
	// testnet stack. On mainnet it would send funds over an unauthenticated,
	// unencrypted channel, so gate it to non-mainnet networks only.
	const insecure = !isMainnet;

	return {
		network,
		data_dir: process.env.PI402_WALLET_DIR ?? "/darepo",
		server_address: process.env.PI402_ARK_SERVER ?? "127.0.0.1:7070",
		server_insecure: insecure,
		swap_server_address: process.env.PI402_SWAP_SERVER ?? "127.0.0.1:8082",
		swap_server_insecure: insecure,
		wallet_esplora_url: process.env.PI402_ESPLORA_URL ?? "http://127.0.0.1:3002",
		allow_mainnet: isMainnet,
	};
}

// resolveWalletPassword returns the wallet password from the environment. On
// mainnet it refuses the built-in dev default: a real-money wallet fronted by an
// unauthenticated local gateway must not ship with a public, hardcoded password.
function resolveWalletPassword(): string {
	const password = process.env.PI402_WALLET_PASSWORD ?? DEFAULT_WALLET_PASSWORD;
	const isMainnet = (process.env.PI402_NETWORK ?? "regtest") === "mainnet";
	if (isMainnet && password === DEFAULT_WALLET_PASSWORD) {
		throw new Error(
			"refusing to start a mainnet wallet with the default password; set PI402_WALLET_PASSWORD to a strong secret",
		);
	}
	return password;
}

// quotedOutflowSat extracts the total sats the wallet will actually pay from a
// prepare-send quote: the invoice principal plus any swap fee. The sidecar
// gateway marshals proto JSON as snake_case; the WASM bridge marshals Go structs
// as PascalCase. We accept either casing and prefer an explicit total-outflow
// field when the backend provides one, falling back to principal plus fee.
function quotedOutflowSat(quote: any): number {
	const pick = (...keys: string[]): number => {
		for (const key of keys) {
			const value = Number(quote?.[key]);
			if (Number.isFinite(value)) {
				return value;
			}
		}
		return 0;
	};

	const total = pick("expected_total_outflow_sat", "ExpectedTotalOutflowSat", "total_outflow_sat", "TotalOutflowSat");
	if (total > 0) {
		return total;
	}

	const principal = pick("amount_sat", "AmountSat");
	const fee = pick("fee_sat", "FeeSat", "swap_fee_sat", "SwapFeeSat", "total_fee_sat", "TotalFeeSat");
	return principal + fee;
}

// assertWithinCeiling refuses a quoted outflow that exceeds the per-request
// spend ceiling. This honors the documented invariant that the budget is
// asserted on the quoted total outflow, not the invoice face value.
function assertWithinCeiling(outflowSat: number, ceilingSat: number): void {
	if (!Number.isFinite(outflowSat) || outflowSat <= 0) {
		throw new Error(`prepare-send returned an unusable quote (outflow ${outflowSat} sat)`);
	}
	if (outflowSat > ceilingSat) {
		throw new Error(`quoted outflow ${outflowSat} sat exceeds per-request cap ${ceilingSat} sat`);
	}
}

// NdjsonFramer reassembles newline-delimited JSON lines from a stream of text
// chunks. A chunk may split a line mid-object, so partial content is held in the
// buffer until its terminating newline arrives. Blank lines are dropped.
export class NdjsonFramer {
	private buffer = "";

	// push feeds a decoded text chunk and returns the complete lines it
	// completed. Any trailing partial line is retained for the next push.
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (line) {
				lines.push(line);
			}
		}
		return lines;
	}
}

// preimageFromFrame classifies one decoded SubscribeWallet frame (sidecar
// proto-JSON, snake_case). It returns the preimage once the entry for the given
// payment hash settles, undefined for frames that are not yet terminal, and
// throws on a gateway error frame, a gap signal, or a failed send.
export function preimageFromFrame(frame: any, paymentHash: string): string | undefined {
	// A gateway-level error frame (e.g. {"error": {...}}) means the stream
	// itself failed; fail fast instead of spinning to the timeout.
	if (frame?.error) {
		const detail = frame.error.message ?? JSON.stringify(frame.error);
		throw new Error(`subscribe stream error: ${detail}`);
	}
	const update = frame?.result ?? frame;

	// The resumable SubscribeWallet protocol wraps each item in a
	// {cursor, entry|gap} envelope. A gap means the daemon dropped events we
	// may have needed (the settle could be among them), so fail fast rather
	// than spin to the timeout on a stream that can no longer deliver it.
	if (update?.gap) {
		const reason = update.gap.reason || "subscriber fell behind";
		throw new Error(`subscribe stream gapped: ${reason}`);
	}

	// Unwrap the envelope, tolerating the older bare WalletEntry shape from
	// pre-envelope daemons.
	const entry = update?.entry ?? update;
	const progress = entry?.progress;
	if (progress?.payment_hash !== paymentHash) {
		return undefined;
	}
	if (entry.status === "ENTRY_STATUS_FAILED") {
		throw new Error(`send failed: ${entry.failure_reason ?? "unknown"}`);
	}
	if (progress?.preimage) {
		return progress.preimage;
	}
	return undefined;
}

// isWalletMissingError reports whether an unlock/status error means the wallet
// simply does not exist yet (so creating one is the right recovery), as opposed
// to a wrong password or an unreachable daemon, which must propagate. The
// sidecar returns a gRPC-ish code/message; the WASM path an error string.
function isWalletMissingError(err: unknown): boolean {
	// The structured reason is the reliable signal when the gateway sends
	// one, so check it before falling back to matching prose.
	if ((err as WalletdError)?.reason === WALLET_NOT_READY_REASON) {
		return true;
	}

	const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
	// gRPC NotFound is code 5; the message wording covers both backends.
	return (
		message.includes("not found") ||
		message.includes("no wallet") ||
		message.includes("does not exist") ||
		message.includes("wallet not initialized") ||
		message.includes("wallet does not exist") ||
		message.includes("wallet is not ready") ||
		// Unlock on a never-created wallet reports that it is not locked.
		// Match the state rather than that phrase alone: the same wording
		// with any other state means the wallet exists and is already
		// usable, which must not fall through to creating a fresh one.
		message.includes("state=none") ||
		/\bcode\W*5\b/.test(message)
	);
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

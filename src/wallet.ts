import nodeFs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { formatSat } from "./format.ts";
import { maxSatPerRequest, maxSatPerSend, perPaymentLimitMessage } from "./policy.ts";
import { dataDir } from "./store.ts";

// WalletService runs against one of two wavewalletdk backends:
//
// - **Embedded WASM** (the default): the wavewalletdk-wasm bridge in-process,
//   with no separate daemon to run. SQLite persists through OPFS in a browser
//   and through the nodefs VFS under Node, so this is the path for a Node
//   host like Pi as much as for a page. The bridge installs a global
//   wavewalletdkCall dispatcher.
//
//   Its verbs, apart from start, marshal the SDK's own Go structs in both
//   directions, so requests use the same PascalCase field names the responses
//   come back with, and a []byte field is base64. Only start is different: it
//   is handed through to the daemon's config parser, which reads the
//   snake_case keys a waved config file uses. Getting this backwards is quiet
//   rather than loud, because encoding/json ignores a field it cannot match,
//   so a misspelled request arrives as the zero value.
// - **Sidecar** (PI402_WALLETD_GATEWAY set): a native waved, driven over its
//   HTTP/JSON gateway (default localhost:10031). This is for pointing at a
//   wallet that is already running, or one shared with something else.
type WavewalletdkCall = (method: string, req?: unknown) => Promise<any>;

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

// WalletStatus is what /wallet shows. arrivingSat counts on-chain deposits
// only, since the daemon fills pending_in from boarding outputs.
export interface WalletStatus {
	ready: boolean;
	network: string;
	spendableSat: number;
	arrivingSat: number;
	outgoingSat: number;
	creditSat: number;
}

// parseWalletStatus reads either backend's status: PascalCase numbers from
// the WASM bridge, snake_case strings from the gateway. A missing ready flag
// counts as ready.
export function parseWalletStatus(raw: any): WalletStatus {
	const balance = raw?.Balance ?? raw?.balance ?? {};
	const sat = (pascal: string, snake: string): number => {
		// A negative or unparseable amount shows as zero.
		const value = Number(balance[pascal] ?? balance[snake] ?? 0);
		return Number.isFinite(value) && value > 0 ? value : 0;
	};
	return {
		ready: (raw?.Ready ?? raw?.ready ?? true) !== false,
		network: String(raw?.Network ?? raw?.network ?? ""),
		spendableSat: sat("ConfirmedSat", "confirmed_sat"),
		arrivingSat: sat("PendingInSat", "pending_in_sat"),
		outgoingSat: sat("PendingOutSat", "pending_out_sat"),
		creditSat: sat("CreditAvailableSat", "credit_available_sat"),
	};
}

// PREIMAGE_TIMEOUT_MS bounds how long a send may take to settle before the
// payer gives up. Ark↔Lightning swaps take seconds; minutes means stuck.
const PREIMAGE_TIMEOUT_MS = 120_000;

// WALLET_READY_TIMEOUT_MS bounds the wait for the embedded daemon to finish
// bringing up the actors behind an unlocked wallet, and WALLET_READY_POLL_MS
// is how often it is asked. This takes a second or two against a healthy
// operator; a minute means something upstream is not answering.
const WALLET_READY_TIMEOUT_MS = 60_000;
const WALLET_READY_POLL_MS = 200;

// WALLET_RECOVERY_WINDOW is how many unused addresses a restore scans past
// before deciding it has found the end of the wallet's history. This is the
// usual gap limit, and it only applies when a seed is restored: a wallet this
// extension generated has no history to look for.
const WALLET_RECOVERY_WINDOW = 100;

// WalletService exposes the operations the extension needs: paying an L402
// invoice, reading the balance, and producing a boarding address for
// deposits.
export class WalletService {
	private ready = false;
	private gateway: string | undefined;
	private call: WavewalletdkCall | undefined;

	// runtimeExited flips when the embedded Go runtime stops running. The
	// dispatcher global it installed may still exist, but nothing answers it
	// any more, so calls have to fail fast rather than hang against it.
	private runtimeExited = false;

	// stopped records that stop() has run, so a second call does nothing.
	private stopped = false;

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

		this.call = await loadWavewalletdk((err) => this.noteRuntimeExit(err));
		await this.call("start", startConfigFromEnv());

		// WalletPassword is a []byte on the SDK struct, and encoding/json
		// reads a []byte from base64. The name has to be the struct's, not
		// the gateway's wallet_password: Go matches field names
		// case-insensitively but an underscore is not a case difference, so
		// that spelling matches nothing, decodes to an empty password, and
		// comes back as "wallet password must be at least 8 bytes". The
		// password is not weak, it never arrived.
		const passwordB64 = Buffer.from(password).toString("base64");
		try {
			await this.call("unlockWallet", { WalletPassword: passwordB64 });
		} catch (err) {
			// As with the sidecar path, only create when the failure genuinely
			// means the wallet does not exist yet; otherwise rethrow so a wrong
			// password or a daemon fault is not masked by a fresh create.
			if (!isWalletMissingError(err)) {
				throw err;
			}
			await this.createEmbeddedWallet(passwordB64);
		}

		// Unlocking returns before the daemon has finished standing up the
		// actors behind it, so the wallet is not usable the instant this
		// resolves. Waiting here rather than letting the caller find out
		// keeps the race out of every call site: the alternative is that
		// whatever runs first after the session_start bootstrap fails with
		// "wallet actor not initialized", which reads like a broken wallet
		// rather than one that was asked too early.
		await this.awaitWalletReady();

		this.ready = true;
	}

	// createEmbeddedWallet makes the wallet on first run, restoring a seed the
	// operator supplied or generating one and writing it down.
	//
	// Generating a seed and discarding it is the one outcome not on offer.
	// The wallet's database is the only record of a generated key, so losing
	// the data directory would take the funds with it, and nothing would have
	// warned anyone that was possible.
	private async createEmbeddedWallet(passwordB64: string): Promise<void> {
		const call = this.requireCall();
		const mnemonic = restoreMnemonic();

		const req: Record<string, unknown> = { WalletPassword: passwordB64 };
		if (mnemonic.length > 0) {
			req.Mnemonic = mnemonic;

			// A restored seed has history the local database knows nothing
			// about, so ask the daemon to go and find it. Without this the
			// wallet comes back correct but empty until something else
			// triggers a scan.
			req.RecoverState = true;
			req.RecoveryWindow = WALLET_RECOVERY_WINDOW;
		} else {
			assertSeedIsSafeToGenerate();
			assertNoStaleSeedFile();
		}

		const created = await call("createWallet", req);

		// A restored wallet's seed is already in the operator's hands, so
		// writing a second copy would add an exposure and no safety.
		if (mnemonic.length === 0) {
			try {
				writeSeedFile(created?.Mnemonic);
			} catch (err) {
				// The wallet now exists in the daemon's database with a seed
				// that was never recorded, and the next start would unlock it
				// without noticing anything wrong. Name that state exactly and
				// say how to leave it, because the recovery is only safe at
				// this instant: the wallet is still empty, so deleting it
				// loses nothing, whereas once it is funded the directory is
				// the only key to the funds.
				const detail = err instanceof Error ? err.message : String(err);
				throw new Error(
					"the wallet was just created but its seed backup could " +
						`not be written (${detail}); the new wallet has no ` +
						"seed backup, so delete the wallet directory at " +
						`${walletDataDir()} and start again. Deleting it is ` +
						"only safe right now, while the wallet is still empty.",
					{ cause: err },
				);
			}
		}
	}

	// awaitWalletReady polls until the embedded daemon reports its wallet
	// usable, or gives up with an error naming the wait.
	//
	// The signal is Status.Ready rather than the walletReady verb. The latter
	// reports GetInfo's view, which flips as soon as the wallet is unlocked
	// and while the actors that actually serve requests are still starting.
	// Trusting it leaves a window of a few hundred milliseconds in which a
	// boarding address or a send fails with "wallet actor not initialized",
	// which is the sort of race that passes locally and breaks under load.
	private async awaitWalletReady(): Promise<void> {
		const call = this.requireCall();
		const deadline = Date.now() + WALLET_READY_TIMEOUT_MS;

		for (;;) {
			const status = await call("status");
			if (status?.Ready) {
				return;
			}

			if (Date.now() > deadline) {
				throw new Error(
					`the embedded wallet did not become ready within ${WALLET_READY_TIMEOUT_MS / 1000}s of unlocking`,
				);
			}

			await new Promise((resolve) => setTimeout(resolve, WALLET_READY_POLL_MS));
		}
	}

	// Credit caps: small payments (under about 1,000 sat) go over the swap
	// server's credit rail, and the wallet only authorizes that rail when the
	// caller sets an explicit cap. With no cap the quote is refused ("below
	// the 1000 sat minimum for pay swaps"), which is how a 20 sat session
	// deposit fails. We pass the per-request ceiling for both caps, so the
	// wallet never reserves or tops up more credit than a single request may
	// spend.
	//
	// payInvoice pays a BOLT11 invoice via a two-phase wavewalletdk send.
	// prepareSend quotes the payment (including the swap fee), send
	// dispatches it, and the preimage is read from the settled entry once
	// the swap completes.
	//
	// The budget cap is re-asserted here, after the quote, on the QUOTED TOTAL
	// OUTFLOW (invoice principal plus swap fee) rather than the counterparty's
	// stated amount. The buyer policy runs earlier on the proxy's stated
	// amountSat, but only the quote reveals the invoice's real encoded amount
	// plus the swap fee the wallet will actually pay. We refuse before
	// dispatching send if that total exceeds the per-request ceiling.
	async payInvoice(invoice: string, _amountSat: number): Promise<PayResult> {
		return this.payWithCeiling(invoice, maxSatPerRequest(), "PI402_MAX_SAT_PER_REQUEST");
	}

	// sendInvoice pays a BOLT11 invoice on a person's behalf, for the /send
	// command. It runs the same quote, ceiling check and dispatch as an L402
	// payment, against the per-send ceiling, and calls confirm with the quoted
	// total outflow before anything is dispatched. A confirm that resolves false
	// stops the payment with a SendDeclinedError and nothing is spent.
	async sendInvoice(invoice: string, confirm: (outflowSat: number) => Promise<boolean>): Promise<PayResult> {
		return this.payWithCeiling(invoice, maxSatPerSend(), "PI402_MAX_SAT_PER_SEND", confirm);
	}

	// payWithCeiling is the shared two-phase send behind payInvoice and
	// sendInvoice. ceilingEnv names the setting that raises the ceiling, for the
	// refusal message.
	private async payWithCeiling(
		invoice: string,
		ceiling: number,
		ceilingEnv: string,
		confirm?: (outflowSat: number) => Promise<boolean>,
	): Promise<PayResult> {
		if (this.gateway) {
			const quote = await this.rest("/v1/wallet/prepare-send", {
				invoice,
				max_credit_sat: ceiling,
				max_credit_topup_sat: ceiling,
			});
			const outflow = quotedOutflowSat(quote);
			assertWithinCeiling(outflow, ceiling, ceilingEnv);
			assertCanAfford(fundsFrom(await this.rest("/v1/wallet/balance", {})), outflow);
			if (confirm && !(await confirm(outflow))) {
				throw new SendDeclinedError();
			}

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
		const quote = await call("prepareSend", {
			Invoice: invoice,
			MaxCreditSat: ceiling,
			MaxCreditTopupSat: ceiling,
		});
		const outflow = quotedOutflowSat(quote);
		assertWithinCeiling(outflow, ceiling, ceilingEnv);
		assertCanAfford(fundsFrom(await call("balance")), outflow);
		if (confirm && !(await confirm(outflow))) {
			throw new SendDeclinedError();
		}

		// Same ordering as the sidecar path: subscribe before sendPrepared so a
		// fast settle cannot be missed.
		const handle: SubscriptionHandle = await call("subscribe", { IncludeExisting: true });
		try {
			await call("sendPrepared", { SendIntentID: quote.SendIntentID });
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
			return Number(res.confirmed_sat ?? 0);
		}
		return this.requireCall()("confirmedBalanceSat");
	}

	// status returns the wallet's readiness, network and balance.
	async status(): Promise<WalletStatus> {
		if (this.gateway) {
			return parseWalletStatus(await this.rest("/v1/wallet/status", {}));
		}
		return parseWalletStatus(await this.requireCall()("status"));
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
	// entry.progress.preimage.
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

	// stop shuts the embedded wallet down so the process can exit. The Go
	// runtime parks on a channel and the SQLite bridge owns a worker thread;
	// a worker thread is a live handle, so until both are released Node never
	// drains its event loop and a non-interactive `pi -p` hangs after the
	// reply is printed.
	//
	// It is idempotent, a no-op when the embedded runtime never started (mock
	// mode, sidecar mode, or a failed bootstrap), and never throws: it runs on
	// Pi's shutdown path, where an error would only mask the exit. Each step
	// is bounded by timeoutMs so a wedged wallet cannot hang the exit it is
	// meant to enable.
	async stop(timeoutMs = 5_000): Promise<void> {
		const call = this.call;
		if (!call || this.stopped) {
			return;
		}
		this.stopped = true;

		// Once stopping begins nothing may use the wallet again.
		this.ready = false;

		const bounded = async (what: string, work: () => Promise<unknown>) => {
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					work(),
					new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
					}),
				]);
			} catch (err) {
				console.error(`[pi-402] embedded wallet ${what} failed:`, err);
			} finally {
				clearTimeout(timer);
			}
		};

		// If the runtime already died on its own there is nothing to stop,
		// but the worker thread may still be holding the process open.
		if (!this.runtimeExited) {
			await bounded("stop", () => call("stop"));
		}

		// The bridge's shutdown terminates the SQLite worker. It runs even
		// when stop failed, since a leaked worker is what blocks the exit.
		const bridge = (globalThis as any).sqliteBridge;
		if (typeof bridge?.shutdown === "function") {
			await bounded("sqlite shutdown", () => bridge.shutdown());
		}
	}

	// noteRuntimeExit records that the embedded Go runtime is gone. The
	// program is supposed to run for the lifetime of the process, so any exit
	// is the wallet dying, and the only useful things to do are say so once,
	// with the error when there is one, and make every later call fail fast
	// with that story instead of a timeout or a hang.
	private noteRuntimeExit(err: unknown): void {
		this.runtimeExited = true;
		this.ready = false;

		if (err === undefined) {
			console.error("[pi-402] embedded wallet runtime exited");
		} else {
			console.error("[pi-402] embedded wallet runtime exited:", err);
		}
	}

	private requireCall(): WavewalletdkCall {
		if (this.runtimeExited) {
			throw new Error("the embedded wallet runtime exited; restart the session to bring the wallet back up");
		}
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

	// Only regtest gets endpoints from here. Every other network has hosted
	// operator, swap and chain endpoints that the embedded daemon resolves
	// from the network name, so naming them would mean shipping a second copy
	// of that list to drift against the first. Regtest is the exception
	// because there is nothing hosted to resolve: the endpoints are whatever
	// the local compose stack published.
	const isLocal = network === "regtest";

	// Insecure transport belongs to a local endpoint, not to a network.
	// Deriving it from "not mainnet" was wrong the moment this stopped being
	// regtest-only: the signet operator and swap server are reached over TLS
	// on 443, and asking for plaintext there fails to connect rather than
	// falling back.
	const insecure = envFlag("PI402_SERVER_INSECURE") ?? isLocal;

	// A Node host has a real filesystem, so the wasm entry point refuses the
	// browser default of /wavelength rather than trying to create it: that is
	// a path at the filesystem root, and os.MkdirAll there fails with EROFS or
	// EACCES. It wants an explicit directory, and the natural one is beside
	// the token cache and receipt ledger under the pi-402 data directory.
	// REST rather than gRPC, always. This is a property of the host and not
	// of the network: the wasm build has no gRPC transport at all, because
	// gRPC needs a socket and js/wasm has none, so connecting that way fails
	// with "wavewalletdk gRPC transport is unavailable". The operator and
	// swap server publish a grpc-gateway REST endpoint for exactly this, and
	// the daemon resolves the right one per network once it is told which
	// transport to want.
	const config: Record<string, unknown> = {
		network,
		data_dir: walletDataDir(),
		allow_mainnet: isMainnet,
		server_transport: "rest",
		swap_server_transport: "rest",
	};

	// The embedded daemon logs through this process, and under Pi that means
	// straight over the TUI, so it defaults to errors only. A stuck swap says
	// almost nothing even at info level, so when debugging one, raise it with
	// PI402_DEBUG_LEVEL=debug (or trace), or per subsystem as in
	// "info,ROND=debug". Any level btclog accepts works: trace, debug, info,
	// warn, error, critical, or off.
	config.debug_level = process.env.PI402_DEBUG_LEVEL || "error";

	const arkServer = process.env.PI402_ARK_SERVER ?? (isLocal ? "127.0.0.1:7070" : "");
	if (arkServer) {
		config.server_address = arkServer;
		config.server_insecure = insecure;
	}

	const swapServer = process.env.PI402_SWAP_SERVER ?? (isLocal ? "127.0.0.1:8082" : "");
	if (swapServer) {
		config.swap_server_address = swapServer;
		config.swap_server_insecure = insecure;
	}

	const esplora = process.env.PI402_ESPLORA_URL ?? (isLocal ? "http://127.0.0.1:3002" : "");
	if (esplora) {
		config.wallet_esplora_url = esplora;
	}

	return config;
}

// walletDataDir is where the embedded daemon keeps its databases, and beside
// them the seed of a wallet this extension generated.
function walletDataDir(): string {
	return process.env.PI402_WALLET_DIR ?? join(dataDir(), "wallet");
}

// SEED_FILE is the name the generated mnemonic is written under.
const SEED_FILE = "seed.txt";

// restoreMnemonic reads a seed the operator wants restored, as the words
// separated by whitespace. Empty means generate a fresh one.
function restoreMnemonic(): string[] {
	const raw = (process.env.PI402_WALLET_MNEMONIC ?? "").trim();
	if (raw === "") {
		return [];
	}

	return raw.split(/\s+/);
}

// assertSeedIsSafeToGenerate refuses to generate a mainnet seed that would be
// written to disk in the clear.
//
// On a test network the seed file is the difference between a recoverable
// wallet and a disposable one, and the funds it protects are worth nothing.
// On mainnet the same file is a key to real money sitting next to the database
// it unlocks, readable by anything running as this user. That is a decision
// for whoever is deploying, not a default this extension should pick for them,
// so mainnet either restores a seed the operator already holds or says plainly
// what it is being asked to do.
//
// Exported for tests.
export function assertSeedIsSafeToGenerate(): void {
	const isMainnet = (process.env.PI402_NETWORK ?? "regtest") === "mainnet";
	if (!isMainnet || envFlag("PI402_ALLOW_PLAINTEXT_SEED") === true) {
		return;
	}

	throw new Error(
		"refusing to generate a mainnet wallet seed, which would be " +
			"written to disk in the clear: either restore a seed you " +
			"already hold with PI402_WALLET_MNEMONIC, or set " +
			"PI402_ALLOW_PLAINTEXT_SEED=1 to accept a plaintext seed " +
			`file at ${join(walletDataDir(), SEED_FILE)}`,
	);
}

// assertNoStaleSeedFile refuses to create a fresh wallet while a seed file
// from an earlier wallet is still sitting in the data directory.
//
// Reaching the create path with a seed file already present means the wallet
// database is gone but the seed of the wallet it belonged to is not. Creating
// a new wallet anyway would be quietly destructive twice over: writeSeedFile
// must not clobber the old words, so the new wallet's seed would have nowhere
// to go, and the stale file would sit beside the new database masquerading as
// its backup. Whoever restored from it later would recover the wrong wallet.
function assertNoStaleSeedFile(): void {
	const path = join(walletDataDir(), SEED_FILE);
	if (!existsSync(path)) {
		return;
	}

	throw new Error(
		`refusing to create a new wallet: a seed file already exists at ` +
			`${path} but the wallet it belongs to does not. To restore that ` +
			"wallet, set PI402_WALLET_MNEMONIC to its words; to start " +
			"fresh, move the seed file somewhere safe first.",
	);
}

// writeSeedFile records a freshly generated mnemonic beside the wallet.
//
// It is written once, and never over an existing file: a second write would
// mean the wallet was recreated, and clobbering the previous words would
// destroy the only copy of a key that may still hold funds.
//
// Exported for tests.
export function writeSeedFile(mnemonic: unknown): void {
	if (!Array.isArray(mnemonic) || mnemonic.length === 0) {
		throw new Error(
			"the wallet was created but returned no seed words, so there " +
				"is nothing to back it up with; refusing to continue with " +
				"an unrecoverable wallet",
		);
	}

	const dir = walletDataDir();
	const path = join(dir, SEED_FILE);

	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(path, `${mnemonic.join(" ")}\n`, { mode: 0o600, flag: "wx" });

	console.error(
		`[pi-402] created a new wallet; its seed is at ${path}. Back it up: ` +
			"it is the only copy, and the wallet cannot be recovered without it.",
	);
}

// envFlag reads a boolean environment override, returning undefined when the
// variable is unset so a caller can tell "not configured" from "configured
// false".
function envFlag(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") {
		return undefined;
	}

	return raw === "1" || raw.toLowerCase() === "true";
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
function assertWithinCeiling(outflowSat: number, ceilingSat: number, envName = "PI402_MAX_SAT_PER_REQUEST"): void {
	if (!Number.isFinite(outflowSat) || outflowSat <= 0) {
		throw new Error(`prepare-send returned an unusable quote (outflow ${outflowSat} sat)`);
	}
	if (outflowSat > ceilingSat) {
		throw new Error(perPaymentLimitMessage(outflowSat, ceilingSat, true, envName));
	}
}

// SendDeclinedError is thrown by sendInvoice when the confirm callback refuses
// the quoted payment, so the caller can tell a cancel from a failure.
export class SendDeclinedError extends Error {
	constructor() {
		super("send cancelled");
		this.name = "SendDeclinedError";
	}
}

// fundsFrom reads the confirmed balance and the sats still arriving from a
// balance response in either casing. Credit is left out: the quoted outflow
// already includes any credit top-up, and both are paid from confirmed funds.
export function fundsFrom(balance: any): { confirmedSat: number; arrivingSat: number } {
	const sat = (pascal: string, snake: string): number => {
		const value = Number(balance?.[pascal] ?? balance?.[snake] ?? 0);
		return Number.isFinite(value) && value > 0 ? value : 0;
	};
	return {
		confirmedSat: sat("ConfirmedSat", "confirmed_sat"),
		arrivingSat: sat("PendingInSat", "pending_in_sat"),
	};
}

// assertCanAfford refuses a payment the wallet cannot cover before it is
// dispatched. Sent anyway, it fails inside the swap and surfaces only as a
// preimage timeout, which Pi retries. "available balance" is a phrase Pi
// never retries.
export function assertCanAfford(funds: { confirmedSat: number; arrivingSat: number }, outflowSat: number): void {
	if (funds.confirmedSat >= outflowSat) {
		return;
	}
	const next =
		funds.arrivingSat > 0
			? `${formatSat(funds.arrivingSat)} sat is still arriving; send the prompt again once it lands, or run /fund <sats>.`
			: "Run /fund <sats> to add funds, then send the prompt again.";
	throw new Error(
		`pi-402: the wallet's available balance is ${formatSat(funds.confirmedSat)} sat, but this payment needs ${formatSat(outflowSat)} sat. ${next}`,
	);
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

// WASM_GLOBAL is the dispatcher the wasm bridge installs once its Go runtime
// is up, and WASM_BINARY is the artifact that installs it. Both names come
// from cmd/wavewalletdk-wasm in wavelength and have to match it exactly.
const WASM_GLOBAL = "wavewalletdkCall";
const WASM_BINARY = "wavewalletdk.wasm";

// loadWavewalletdk instantiates the wavewalletdk WASM binary and resolves its
// call dispatcher. The artifact directory holds that binary, Go's wasm_exec.js
// glue, and the SQLite runtime assets, all produced by `make wasm-wallet` in
// wavelength. It is located via PI402_WASM_DIR or a bundled ./wasm directory.
//
// Two globals have to be in place before the module is instantiated, and both
// are what make this work under Node rather than only in a browser:
//
//   - globalThis.fs. Go's wasm_exec.js installs a stub filesystem whose every
//     call fails with ENOSYS, but only when the host has not already provided
//     one. Handing it node:fs is what lets the daemon create its data
//     directory and lets the nodefs SQLite VFS reach the disk.
//   - globalThis.sqliteBridgeAssetDir. The bridge spawns its SQLite worker
//     from this directory and loads sqlite3.js, sqlite-worker.js and
//     sqlite-node-vfs.js out of it. Without it the worker resolves those
//     relative to a page URL that does not exist here.
// The onExit callback fires once if the Go program ever stops running, with
// the error that killed it when there is one.
async function loadWavewalletdk(onExit: (err: unknown) => void): Promise<WavewalletdkCall> {
	const g = globalThis as any;

	// An existing dispatcher means an earlier load in this process owns the
	// runtime, and that load's own exit watcher is the one wired to it.
	const existing = g[WASM_GLOBAL];
	if (typeof existing === "function") {
		return existing as WavewalletdkCall;
	}

	// The bridge dispatches lifecycle CustomEvents on globalThis, which is
	// not an EventTarget under Node; back those methods with one.
	if (typeof g.dispatchEvent !== "function") {
		const events = new EventTarget();
		g.addEventListener = events.addEventListener.bind(events);
		g.removeEventListener = events.removeEventListener.bind(events);
		g.dispatchEvent = events.dispatchEvent.bind(events);
	}

	const wasmDir = process.env.PI402_WASM_DIR ?? join(import.meta.dirname, "..", "wasm");

	// Fail here, naming the file, rather than letting the wallet come up
	// against a bundle missing the pieces its database needs and discover it
	// as an unexplained open failure much later.
	requireWasmAssets(wasmDir);
	assertWasmDirIsCommonJs(wasmDir);

	// Both of these are read during instantiation, so they have to be set
	// before it rather than after.
	g.fs ??= nodeFs;
	g.sqliteBridgeAssetDir = wasmDir;

	loadSqliteBridge(wasmDir);

	// Evaluate Go's wasm_exec.js glue, which defines globalThis.Go.
	const glue = readFileSync(join(wasmDir, "wasm_exec.js"), "utf8");
	// eslint-disable-next-line no-new-func
	new Function(glue)();

	const GoRuntime = g.Go;
	if (!GoRuntime) {
		throw new Error("wasm_exec.js did not define the Go runtime");
	}

	const go = new GoRuntime();
	const wasmBytes = readFileSync(join(wasmDir, WASM_BINARY));
	const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);

	// The Go program runs for the lifetime of the process, so its run promise
	// is not awaited. It is watched, though: discarding it outright would
	// make a runtime death invisible, leaving every later call to fail as an
	// unexplained timeout or hang, with the root cause logged nowhere.
	let running: Promise<unknown> | undefined;
	withFetchEnabled(() => {
		running = go.run(instance) as Promise<unknown>;
	});
	running?.then(
		() => onExit(undefined),
		(err: unknown) => onExit(err),
	);

	// The bridge installs the dispatcher once the runtime is up. It also
	// fires a ready event, but that can race the listener, so poll for the
	// global instead.
	await waitForGlobal(WASM_GLOBAL, 30_000);

	return g[WASM_GLOBAL] as WavewalletdkCall;
}

// withFetchEnabled runs the Go program's start-up with a process object whose
// argv0 does not name Node, so the wallet can reach the network.
//
// Go's js/wasm net/http turns the Fetch API off when it sees a Node host, and
// decides that with a literal prefix test on process.argv0 (roundtrip_js.go,
// go.dev/issue/57613). What it falls back to is the js/wasm fake network,
// which has no sockets, so every request the daemon makes dies in the resolver
// with "write udp 127.0.0.1:8". A browser never sees this because there the
// test is false and fetch is used. The wasm build talks to the operator, the
// swap server and esplora over REST, all of which fetch serves perfectly well,
// so this is only about clearing a check aimed at an older Node.
//
// argv0 on the real process object is neither writable nor configurable, so
// the stand-in is an object that inherits from it and shadows that one
// property. A Proxy cannot do this: reporting a value other than the target's
// for a non-configurable, non-writable data property violates an invariant the
// engine enforces, and it throws. Inheritance has no such rule, and every
// other property still resolves through the prototype to the real process.
//
// The window is as small as it can be. The flag is a package-level variable,
// so it is read during Go's package initialization, which runs in the
// synchronous part of go.run before it yields, and the real object is back in
// place before any other code observes the swap.
//
// Exported for tests.
export function withFetchEnabled(run: () => void): void {
	const real = globalThis.process;
	if (typeof real?.argv0 !== "string" || !real.argv0.startsWith("node")) {
		run();

		return;
	}

	const shim = Object.create(real);
	Object.defineProperty(shim, "argv0", {
		value: "pi402-embedded-wallet",
		enumerable: true,
	});

	const install = (value: unknown) =>
		Object.defineProperty(globalThis, "process", {
			value,
			writable: true,
			configurable: true,
			enumerable: false,
		});

	install(shim);
	try {
		run();
	} finally {
		install(real);
	}
}

// loadSqliteBridge evaluates sqlite-bridge.js, which installs the
// globalThis.sqliteBridge the driver looks for. A browser gets this from a
// script tag; there is no equivalent here, and without it the wallet's first
// database open fails with "sqlite bridge not loaded".
//
// The file is an IIFE that reaches for require() to pull in node:path and
// node:worker_threads. This module is ESM, where require is not a global, so
// one is built for it and passed in as a parameter of the wrapping function.
// Evaluating the source rather than importing the path also sidesteps the
// question of how a ".js" file inside a "type": "module" package would be
// interpreted, which is the same reason the bridge evaluates its own worker.
function loadSqliteBridge(wasmDir: string): void {
	if ((globalThis as any).sqliteBridge) {
		return;
	}

	const source = readFileSync(join(wasmDir, "sqlite-bridge.js"), "utf8");
	// eslint-disable-next-line no-new-func
	new Function("require", source)(createRequire(import.meta.url));

	if (!(globalThis as any).sqliteBridge) {
		throw new Error("sqlite-bridge.js did not install globalThis.sqliteBridge");
	}
}

// WASM_ASSETS is every file the bundle has to carry. sqlite-node-vfs.js is the
// one that is easy to miss: it ships in the same asset set but is loaded only
// by a Node host, so a bundle staged before that file existed looks complete
// and fails at the first database open.
const WASM_ASSETS = [
	"wasm_exec.js",
	WASM_BINARY,
	"sqlite3.js",
	"sqlite3.wasm",
	"sqlite-bridge.js",
	"sqlite-worker.js",
	"sqlite-node-vfs.js",
];

// requireWasmAssets checks the bundle is complete before anything is loaded.
function requireWasmAssets(wasmDir: string): void {
	const missing = WASM_ASSETS.filter((name) => !existsSync(join(wasmDir, name)));
	if (missing.length === 0) {
		return;
	}

	throw new Error(
		`wasm bundle at ${wasmDir} is missing ${missing.join(", ")}; ` +
			"rebuild it with `make wasm-wallet` in wavelength and point " +
			"PI402_WASM_DIR at the resulting bin/wasm",
	);
}

// assertWasmDirIsCommonJs refuses a bundle that Node would load as ES modules.
//
// The bundle's .js files are CommonJS, and the SQLite worker require()s two of
// them. Node picks the module system for a .js file from the nearest
// package.json at or above it, and pi-402 itself declares "type": "module". A
// bundle placed inside the package with no package.json of its own therefore
// inherits that, and the worker's require() fails. The bridge reports it as
// "sqlite worker initialization failed: <object>", which names nothing, so we
// look for the cause ourselves and say what to do about it.
// scripts/stage-wasm.sh writes the package.json that prevents this.
//
// Exported for tests.
export function assertWasmDirIsCommonJs(wasmDir: string): void {
	for (let dir = wasmDir; ; dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			// A manifest Node cannot parse fails the worker the same opaque
			// way, so name it here rather than passing it through.
			let type: unknown;
			try {
				type = JSON.parse(readFileSync(manifest, "utf8")).type;
			} catch (err) {
				throw new Error(`unable to parse ${manifest}, which scopes the wasm bundle at ${wasmDir}`, {
					cause: err,
				});
			}

			if (type === "module") {
				throw new Error(
					`wasm bundle at ${wasmDir} would load as ES modules, because ` +
						`${manifest} declares "type": "module"; the bundle is ` +
						'CommonJS. Add a package.json containing {"type":"commonjs"} ' +
						"to the bundle directory (in a checkout, scripts/stage-wasm.sh writes it)",
				);
			}

			return;
		}

		if (dirname(dir) === dir) {
			return;
		}
	}
}

// waitForGlobal polls for a global symbol installed by the WASM bridge.
async function waitForGlobal(name: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (typeof (globalThis as any)[name] !== "function") {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`wavewalletdk WASM did not install ${name} within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

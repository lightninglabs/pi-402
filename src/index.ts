import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { BundleTracker, type Colorizer, FileBundleStore, formatBar, MemoryBundleStore } from "./bundle.ts";
import { registerReceiptCommands, registerWalletCommands } from "./commands.ts";
import { refreshWhileEmpty } from "./footer.ts";
import { formatSat } from "./format.ts";
import { MockInvoicePayer, WalletInvoicePayer } from "./payer.ts";
import { buildBudgetPolicy } from "./policy.ts";
import { makeStreamSimple, wireModelId } from "./provider.ts";
import { dataDir, FileCredentialStore, FileReceiptLog, FileTokenStore } from "./store.ts";
import { formatFooter, type Pending, SpotRate } from "./usd.ts";
import { sharedWalletService } from "./wallet.ts";

// PROVIDER_ID is the model provider this extension registers. Users select it
// with `/model pi402/<model>`.
const PROVIDER_ID = "pi402";

// DEFAULT_PROXY_URL is the local L402 proxy used when L402_PROXY_URL is unset.
const DEFAULT_PROXY_URL = "http://localhost:8402";

// The extension entry point. Pi calls this with the ExtensionAPI when the
// extension is loaded. Everything the extension does is registered here; Pi core
// is never modified.
export default function (pi: ExtensionAPI): void {
	const proxyUrl = process.env.L402_PROXY_URL ?? DEFAULT_PROXY_URL;

	// The wallet holds the embedded walletdk instance. Pi runs this factory
	// again whenever it replaces the session, and the runtime is process-wide,
	// so every run shares one service instead of starting a second runtime.
	const wallet = sharedWalletService();

	// The footer status shows the wallet balance, and a one-line notice marks
	// each payment, so an agent that spends on its own never does it silently.
	// The UI handle arrives with session_start; it is a convenience only, so a
	// failure here (no UI, a stale session, a balance read that errors) is
	// swallowed and never reaches a payment.
	let ui: ExtensionUIContext | undefined;

	// The footer also shows the balance's dollar value. The rate is fetched in
	// the background and cached, so it never delays startup or a payment; the
	// footer redraws with the last balance when a rate first arrives.
	let lastBalance: number | undefined;
	let pending: Pending = { outSat: 0, inSat: 0 };
	const drawBalance = (sat: number): void => {
		lastBalance = sat;
		ui?.setStatus("pi-402", formatFooter(sat, spot.rate(), pending, bundleBar()));
	};

	// The bundle bar is drawn from the tracker's last estimate. Colors come
	// from Pi's theme when the UI has one, and the bar is plain text
	// otherwise.
	let bundle: { remaining: number; total: number } | undefined;
	const bundleBar = (): string | undefined => {
		if (!bundle) {
			return undefined;
		}
		let colorize: Colorizer | undefined;
		try {
			const theme = ui?.theme;
			if (theme) {
				colorize = (color, text) => theme.fg(color, text);
			}
		} catch {
			// A stale session's theme is not worth failing the draw.
		}
		return formatBar(bundle.remaining, bundle.total, colorize);
	};

	// refreshBundle re-reads the estimate for the model in use and redraws.
	let currentModel: string | undefined;
	const refreshBundle = async (): Promise<void> => {
		if (!tracker || !currentModel) {
			return;
		}
		const state = await tracker.current(currentModel);
		bundle = state && { remaining: state.remaining, total: state.bundleTokens };
		if (lastBalance !== undefined) {
			drawBalance(lastBalance);
		}
	};

	// readBalance reads the spendable balance and remembers what is pending,
	// so a draw shows the in-flight amounts beside it.
	const readBalance = async (): Promise<number> => {
		const status = await wallet.status();
		pending = { outSat: status.outgoingSat, inSat: status.arrivingSat };
		return status.spendableSat;
	};
	const spot = new SpotRate(fetch, () => {
		if (lastBalance !== undefined) {
			drawBalance(lastBalance);
		}
	});
	const showBalance = async (paidSat?: number): Promise<number | undefined> => {
		const target = ui;
		if (!target) {
			return undefined;
		}

		try {
			const balance = await readBalance();
			drawBalance(balance);
			if (paidSat !== undefined) {
				target.notify(`pi-402 paid ${formatSat(paidSat)} sat (${formatSat(balance)} sat left)`, "info");
			}
			return balance;
		} catch {
			// Leave the last status in place.
			return undefined;
		}
	};

	// The mock payer exercises the buyer loop end to end against a mock proxy
	// with no Lightning at all; the real payer settles through walletdk.
	const mockMode = process.env.PI402_MOCK_PAYER === "1";
	const payer = mockMode
		? new MockInvoicePayer()
		: new WalletInvoicePayer(wallet, async ({ amountPaidSat }) => {
				await showBalance(amountPaidSat);

				// A payment bought a new bundle for the model in use. This
				// runs detached: the rate fetch must never hold up the
				// paid retry.
				const model = currentModel;
				if (tracker && model) {
					void tracker.start(model).then(refreshBundle, () => {});
				}
			});

	// Durable state: paid tokens and the receipt ledger live under the data
	// dir, so a paid bundle survives a restart instead of being re-purchased
	// and every spend leaves an auditable record. Mock mode stays in-memory,
	// keeping fake spends out of the real ledger.
	const stateDir = dataDir();
	const tokenStore = mockMode ? undefined : new FileTokenStore(join(stateDir, "tokens.json"));
	const credentialStore = mockMode ? undefined : new FileCredentialStore(join(stateDir, "credentials.json"));
	const receiptLog = mockMode ? undefined : new FileReceiptLog(join(stateDir, "receipts.ndjson"));

	// The bundle tracker keeps the estimate of what is left of the paid
	// bundle, per seller origin and model. An unparseable proxy URL just
	// means no bar.
	let tracker: BundleTracker | undefined;
	try {
		tracker = new BundleTracker(
			new URL(proxyUrl).origin,
			mockMode ? new MemoryBundleStore() : new FileBundleStore(join(stateDir, "bundles.json")),
		);
	} catch {
		// No bar.
	}

	// The daily cap is seeded from the ledger, so a restart mid-day cannot
	// reset the day's spend to zero.
	const policy = buildBudgetPolicy(pi, receiptLog);

	// Bootstrap the wallet once per session. In mock mode there is no wallet
	// to load, so the session starts without touching the WASM at all.
	if (!mockMode) {
		pi.on("session_start", async (_event, ctx) => {
			await wallet.startAndUnlock();
			ui = ctx.ui;

			// Show the persisted bundle estimate for the selected model, so
			// a restart does not blank the bar until the first request.
			if (ctx.model?.provider === PROVIDER_ID) {
				currentModel = wireModelId(ctx.model.id);
			}
			await refreshBundle();
			const balance = await showBalance();

			// The wallet reports ready before its first sync completes, so a
			// zero here may be a read that beat the sync. Keep refreshing the
			// footer for a bounded time rather than leave it stale until the
			// first payment. This runs detached so startup is not delayed.
			if (!balance) {
				void refreshWhileEmpty(readBalance, drawBalance);
			}
		});

		pi.on("model_select", async (event) => {
			currentModel = event.model.provider === PROVIDER_ID ? wireModelId(event.model.id) : undefined;
			await refreshBundle();
		});

		// Release the wallet when Pi tears the extension down. Without this
		// the WASM runtime and its SQLite worker thread keep Node's event
		// loop alive, and a non-interactive `pi -p` never exits.
		//
		// Only a quit stops it. Pi also emits session_shutdown when it replaces
		// the session (reload, new, resume, fork) and keeps running, and the
		// next session needs the wallet the SQLite bridge belongs to.
		pi.on("session_shutdown", async (event) => {
			if (event.reason === "quit") {
				await wallet.stop();
			}
		});
	}

	// Register the paid model provider. Its streamSimple owns the request path,
	// so the paying fetch is injected without any change to Pi core.
	pi.registerProvider(PROVIDER_ID, {
		api: "l402-openai",
		baseUrl: proxyUrl,
		// The proxy holds the real model credential; Pi sends no API key.
		apiKey: "unused",
		models: [
			{
				// Sent as-is: this is Venice's own id, for a seller whose
				// upstream is Venice (api.venice.ai/api/v1) rather than
				// Baseten. Point L402_PROXY_URL at the seller's /api/v1.
				id: "deepseek-v4-1-flash",
				name: "DeepSeek V4.1 Flash (L402)",
				input: ["text", "image"],
				reasoning: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_768,
			},
			{
				// Maps to deepseek-ai/DeepSeek-V4-Flash-0731 on the wire.
				// The budget option: its bundle quotes at roughly half a
				// GLM-4.7 bundle, so it is also the cheapest way to
				// exercise the paid path end to end.
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash (L402)",
				input: ["text"],
				reasoning: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_768,
			},
			{
				// The Pi-facing id is slash-free; the provider maps it to
				// the Baseten Model APIs slug (zai-org/GLM-4.7) on the wire.
				id: "glm-4.7",
				name: "GLM 4.7 (L402)",
				input: ["text"],
				reasoning: true,
				// Cost is metered in sats at the proxy, not billed per token here.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
			{
				// Maps to zai-org/GLM-5.2 on the wire.
				id: "glm-5.2",
				name: "GLM 5.2 (L402)",
				input: ["text"],
				reasoning: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
			{
				// Maps to moonshotai/Kimi-K3 on the wire. Natively
				// multimodal with a 1M-token context.
				id: "kimi-k3",
				name: "Kimi K3 (L402)",
				input: ["text", "image"],
				reasoning: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 32_768,
			},
			{
				// Maps to moonshotai/Kimi-K3.1-Pro on the wire. 1M-token
				// context, priced below Kimi K3 upstream.
				id: "kimi-k3.1-pro",
				name: "Kimi K3.1 Pro (L402)",
				input: ["text"],
				reasoning: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_768,
			},
		],
		streamSimple: makeStreamSimple({
			payer,
			policy,
			tokenStore,
			credentialStore,
			receiptLog,
			onRequest: (model) => {
				const first = currentModel === undefined;
				currentModel = model;
				if (first) {
					void refreshBundle();
				}
			},
			onUsage: (model, promptTokens, completionTokens) => {
				void tracker?.debit(model, promptTokens, completionTokens).then(refreshBundle, () => {});
			},
		}),
	});

	registerWalletCommands(pi, wallet);
	if (receiptLog) {
		registerReceiptCommands(pi, receiptLog);
	}
}

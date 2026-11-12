import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { registerReceiptCommands, registerWalletCommands } from "./commands.ts";
import { refreshWhileEmpty } from "./footer.ts";
import { formatSat } from "./format.ts";
import { MockInvoicePayer, WalletInvoicePayer } from "./payer.ts";
import { buildBudgetPolicy } from "./policy.ts";
import { makeStreamSimple } from "./provider.ts";
import { dataDir, FileCredentialStore, FileReceiptLog, FileTokenStore } from "./store.ts";
import { formatFooter, SpotRate } from "./usd.ts";
import { WalletService } from "./wallet.ts";

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

	// The wallet holds the embedded walletdk instance for the whole session.
	const wallet = new WalletService();

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
	const drawBalance = (sat: number): void => {
		lastBalance = sat;
		ui?.setStatus("pi-402", formatFooter(sat, spot.rate()));
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
			const balance = await wallet.confirmedBalanceSat();
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
			});

	// Durable state: paid tokens and the receipt ledger live under the data
	// dir, so a paid bundle survives a restart instead of being re-purchased
	// and every spend leaves an auditable record. Mock mode stays in-memory,
	// keeping fake spends out of the real ledger.
	const stateDir = dataDir();
	const tokenStore = mockMode ? undefined : new FileTokenStore(join(stateDir, "tokens.json"));
	const credentialStore = mockMode ? undefined : new FileCredentialStore(join(stateDir, "credentials.json"));
	const receiptLog = mockMode ? undefined : new FileReceiptLog(join(stateDir, "receipts.ndjson"));

	// The daily cap is seeded from the ledger, so a restart mid-day cannot
	// reset the day's spend to zero.
	const policy = buildBudgetPolicy(pi, receiptLog);

	// Bootstrap the wallet once per session. In mock mode there is no wallet
	// to load, so the session starts without touching the WASM at all.
	if (!mockMode) {
		pi.on("session_start", async (_event, ctx) => {
			await wallet.startAndUnlock();
			ui = ctx.ui;
			const balance = await showBalance();

			// The wallet reports ready before its first sync completes, so a
			// zero here may be a read that beat the sync. Keep refreshing the
			// footer for a bounded time rather than leave it stale until the
			// first payment. This runs detached so startup is not delayed.
			if (!balance) {
				void refreshWhileEmpty(() => wallet.confirmedBalanceSat(), drawBalance);
			}
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
		streamSimple: makeStreamSimple({ payer, policy, tokenStore, credentialStore, receiptLog }),
	});

	registerWalletCommands(pi, wallet);
	if (receiptLog) {
		registerReceiptCommands(pi, receiptLog);
	}
}

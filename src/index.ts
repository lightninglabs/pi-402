import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWalletCommands } from "./commands.ts";
import { MockInvoicePayer, WalletInvoicePayer } from "./payer.ts";
import { buildBudgetPolicy } from "./policy.ts";
import { makeStreamSimple } from "./provider.ts";
import { WalletService } from "./wallet.ts";

// PROVIDER_ID is the model provider this extension registers. Users select it
// with `/model l402-baseten/<model>`.
const PROVIDER_ID = "l402-baseten";

// DEFAULT_PROXY_URL is the local L402 proxy used when L402_PROXY_URL is unset.
const DEFAULT_PROXY_URL = "http://localhost:8402";

// The extension entry point. Pi calls this with the ExtensionAPI when the
// extension is loaded. Everything the extension does is registered here; Pi core
// is never modified.
export default function (pi: ExtensionAPI): void {
	const proxyUrl = process.env.L402_PROXY_URL ?? DEFAULT_PROXY_URL;

	// The wallet holds the embedded walletdk instance for the whole session.
	const wallet = new WalletService();

	// Until darepo-client#835 lands (preimage on the settled send entry), fall
	// back to the mock payer so the buyer loop is exercisable end to end against
	// a mock proxy.
	const payer = process.env.PI402_MOCK_PAYER ? new MockInvoicePayer() : new WalletInvoicePayer(wallet);

	const policy = buildBudgetPolicy(pi);

	// Bootstrap the wallet once per session.
	pi.on("session_start", async () => {
		await wallet.startAndUnlock();
	});

	// Register the paid model provider. Its streamSimple owns the request path,
	// so the paying fetch is injected without any change to Pi core.
	pi.registerProvider(PROVIDER_ID, {
		api: "l402-openai",
		baseUrl: proxyUrl,
		// The proxy holds the real model credential; Pi sends no API key.
		apiKey: "unused",
		models: [
			{
				id: "glm-4.5",
				name: "GLM 4.5 (L402)",
				input: ["text"],
				reasoning: true,
				// Cost is metered in sats at the proxy, not billed per token here.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
		streamSimple: makeStreamSimple({ payer, policy }),
	});

	registerWalletCommands(pi, wallet);
}

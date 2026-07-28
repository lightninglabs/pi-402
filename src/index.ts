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

	// The mock payer exercises the buyer loop end to end against a mock proxy
	// with no Lightning at all; the real payer settles through walletdk.
	const mockMode = process.env.PI402_MOCK_PAYER === "1";
	const payer = mockMode ? new MockInvoicePayer() : new WalletInvoicePayer(wallet);

	const policy = buildBudgetPolicy(pi);

	// Bootstrap the wallet once per session. In mock mode there is no wallet
	// to load, so the session starts without touching the WASM at all.
	if (!mockMode) {
		pi.on("session_start", async () => {
			await wallet.startAndUnlock();
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
		],
		streamSimple: makeStreamSimple({ payer, policy }),
	});

	registerWalletCommands(pi, wallet);
}

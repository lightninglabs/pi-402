// Real paid inference, end to end, through pi-402's own buyer loop.
//
// Nothing here is a stand-in. The wallet is the embedded one, the payer is the
// WalletInvoicePayer the extension registers, the budget policy is the same
// one, the durable stores are the same ones, and the fetch is
// @lightninglabs/aperture-client's createPayingFetch. The only thing this file adds is a
// main() where Pi would otherwise be driving.
//
// It runs a list of scenarios in a single process, because it has to: the
// wallet's nodefs VFS takes a pid lock on its databases, so two processes
// cannot both be holding the wallet open. Proving L402 and MPP and the cache
// therefore means one process doing all three in sequence.
//
//   PI402_E2E_SCENARIOS   comma-separated, from: l402, mpp, cached
//                         (default "l402,cached")
//   L402_PROXY_URL        the L402 aperture
//   MPP_PROXY_URL         the --enablempp aperture (defaults to L402_PROXY_URL)
//
// It stays running afterwards so the wallet keeps its Ark state live and the
// control channel remains available.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPayingFetch } from "@lightninglabs/aperture-client";
import OpenAI from "openai";

import { WalletInvoicePayer } from "../src/payer.ts";
import { buildBudgetPolicy } from "../src/policy.ts";
import { dataDir, FileCredentialStore, FileReceiptLog, FileTokenStore } from "../src/store.ts";
import { WalletService } from "../src/wallet.ts";

const l402ProxyUrl = process.env.L402_PROXY_URL ?? "http://127.0.0.1:8504";
const mppProxyUrl = process.env.MPP_PROXY_URL ?? l402ProxyUrl;
const model = process.env.PI402_TEST_MODEL ?? "zai-org/GLM-4.7";
// The control channel executes arbitrary wallet verbs from files in this
// directory, so it defaults under the pi-402 data directory rather than a
// world-writable /tmp, where anyone on the machine could pre-create it and
// feed the wallet a send.
const ctrlDir = process.env.PI402_CTRL_DIR ?? join(dataDir(), "ctrl");
const scenarios = (process.env.PI402_E2E_SCENARIOS ?? "l402,cached").split(",").map((s) => s.trim());

function line(msg: string) {
	console.log(`\n\x1b[1m>>> ${msg}\x1b[0m`);
}

function abbreviate(value: string, keep = 72): string {
	return value.length <= keep ? value : `${value.slice(0, keep)}...(${value.length} bytes)`;
}

// installWireTap replaces the global fetch with one that narrates the parts of
// the exchange this harness exists to demonstrate: the challenge the seller
// sends back with its 402, the credential the buyer answers with, and the
// receipt that comes back on success. The buyer loop calls the global fetch
// internally, so wrapping it here is what makes the wire visible without
// reaching into the library.
function installWireTap(): () => void {
	const real = globalThis.fetch;

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init);
		const authorization = request.headers.get("authorization");
		if (authorization) {
			const [scheme] = authorization.split(" ");
			console.log(`    --> Authorization: ${scheme} ${abbreviate(authorization.slice((scheme?.length ?? 0) + 1))}`);
		}

		const response = await real(request);

		if (response.status === 402) {
			const challenge = response.headers.get("www-authenticate") ?? "(none)";
			console.log(`    <-- 402 WWW-Authenticate: ${challenge}`);
		}
		const receipt = response.headers.get("payment-receipt");
		if (receipt) {
			let decoded = "";
			try {
				decoded = ` = ${Buffer.from(receipt, "base64url").toString("utf8")}`;
			} catch {
				// A receipt we cannot decode is still worth showing raw.
			}
			console.log(`    <-- Payment-Receipt: ${abbreviate(receipt)}${decoded}`);
		}

		return response;
	}) as typeof fetch;

	return () => {
		globalThis.fetch = real;
	};
}

async function main() {
	// The per-request ceiling is the one thing standing between an unattended
	// buyer loop and the whole wallet, so this harness refuses to run without
	// it rather than falling back to a default the operator did not choose.
	if (!process.env.PI402_MAX_SAT_PER_REQUEST) {
		throw new Error("PI402_MAX_SAT_PER_REQUEST must be set before running a paid scenario");
	}

	line("1. bringing up the embedded wallet");
	const wallet = new WalletService();
	await wallet.startAndUnlock();

	const opening = await wallet.confirmedBalanceSat();
	console.log(`    balance: ${opening} sat`);
	console.log(`    cap:     ${process.env.PI402_MAX_SAT_PER_REQUEST} sat/request`);

	line("2. wiring pi-402's buyer loop");
	const stateDir = dataDir();
	const payer = new WalletInvoicePayer(wallet);
	const receiptLog = new FileReceiptLog(join(stateDir, "receipts.ndjson"));

	// Pass the durable stores straight through. FileTokenStore is itself a
	// TokenStore, so wrapping it in a TokenCache would hand the buyer loop an
	// in-memory map that quietly drops the file on the floor, and every
	// request would re-purchase a bundle it had already paid for.
	const tokenStore = new FileTokenStore(join(stateDir, "tokens.json"));
	const credentialStore = new FileCredentialStore(join(stateDir, "credentials.json"));
	const policy = buildBudgetPolicy({} as never, receiptLog);

	console.log(`    tokens:      ${join(stateDir, "tokens.json")}`);
	console.log(`    credentials: ${join(stateDir, "credentials.json")}`);
	console.log(`    scenarios:   ${scenarios.join(", ")}`);

	const restoreFetch = installWireTap();

	// ask runs one paid request and reports what it cost.
	async function ask(label: string, proxyUrl: string, scheme: "auto" | "l402", prompt: string) {
		line(`${label}  (${scheme} against ${proxyUrl})`);

		// The scheme is read per call by mppIntents(), so setting it here is
		// what steers the buyer between the Payment and L402 doors.
		process.env.PI402_PAYMENT_SCHEME = scheme;
		const { mppIntents } = await import("../src/policy.ts");

		const payingFetch = createPayingFetch({
			payer,
			buyerPolicy: policy,
			tokenCache: tokenStore,
			receiptCache: {
				store: async (receipt: unknown) => {
					await receiptLog.store({ ...(receipt as never), model } as never);
				},
			},
			mpp: {
				intents: mppIntents(),
				credentialCache: credentialStore,
			},
		});

		const client = new OpenAI({
			baseURL: proxyUrl,
			apiKey: "unused",
			fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
				payingFetch(input, { ...init, routeId: model } as never)) as typeof fetch,
		});

		const before = await wallet.confirmedBalanceSat();
		const started = Date.now();
		const completion = await client.chat.completions.create({
			model,
			messages: [{ role: "user", content: prompt }],
			max_tokens: 80,
		});
		const after = await wallet.confirmedBalanceSat();

		console.log(`    took ${((Date.now() - started) / 1000).toFixed(1)}s`);
		console.log(`    model replied: ${completion.choices[0]?.message?.content}`);
		console.log(`    balance ${before} -> ${after} sat (spent ${before - after})`);

		return { before, after, spent: before - after };
	}

	// runSessionScenario proves the session intent end to end: one deposit
	// opens a session, later requests ride it as bearers without touching
	// the wallet, and close reports what came back. The refund invoice is
	// minted from the demo stack's lnd, since a session's open must carry an
	// amountless invoice and the embedded wallet cannot produce one.
	async function runSessionScenario(proxyUrl: string) {
		line(`MPP session lifecycle  (against ${proxyUrl})`);

		process.env.PI402_PAYMENT_SCHEME = "auto";
		process.env.PI402_MPP_INTENTS = "session,charge";
		const { mppIntents } = await import("../src/policy.ts");
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);

		const lndContainer = process.env.PI402_REFUND_LND_CONTAINER ?? "ark-lnd-server";
		const minter = {
			async mintAmountlessInvoice(input: { origin: string; realm: string; memo?: string }) {
				const { stdout } = await exec("docker", [
					"exec",
					lndContainer,
					"lncli",
					"--network=regtest",
					"addinvoice",
					"--memo",
					input.memo ?? `pi-402 session refund (${input.realm})`,
				]);
				const parsed = JSON.parse(stdout) as { payment_request?: string };
				if (!parsed.payment_request) {
					throw new Error("lncli addinvoice returned no payment_request");
				}
				console.log(`    refund invoice minted from ${lndContainer}: ${abbreviate(parsed.payment_request, 40)}`);
				return { invoice: parsed.payment_request };
			},
		};

		const payingFetch = createPayingFetch({
			payer,
			buyerPolicy: policy,
			tokenCache: tokenStore,
			receiptCache: {
				store: async (receipt: unknown) => {
					await receiptLog.store({ ...(receipt as never), model } as never);
				},
			},
			mpp: {
				intents: mppIntents({ hasReturnInvoiceMinter: true }),
				credentialCache: credentialStore,
				returnInvoiceMinter: minter,
			},
		});

		const client = new OpenAI({
			baseURL: proxyUrl,
			apiKey: "unused",
			fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
				payingFetch(input, { ...init, routeId: model } as never)) as typeof fetch,
		});

		const askOnce = async (label: string, prompt: string) => {
			const before = await wallet.confirmedBalanceSat();
			// The fake upstream only speaks SSE, so ask for a stream and
			// accumulate the chunks into one reply.
			const stream = await client.chat.completions.create({
				model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 80,
				stream: true,
			});
			let reply = "";
			for await (const chunk of stream) {
				reply += chunk.choices[0]?.delta?.content ?? "";
			}
			const after = await wallet.confirmedBalanceSat();
			console.log(`    ${label}: spent ${before - after} sat, reply: ${reply.slice(0, 60)}`);
			return before - after;
		};

		// The first request pays the deposit and opens the session; the ones
		// after it must ride the session without touching the wallet.
		const depositSpend = await askOnce("open (pays the deposit)", "Say hi in three words.");
		const bearerSpend1 = await askOnce("bearer 1 (expect 0 spend)", "Say hello in three words.");
		const bearerSpend2 = await askOnce("bearer 2 (expect 0 spend)", "Say hey in three words.");

		if (bearerSpend1 !== 0 || bearerSpend2 !== 0) {
			console.log("    \x1b[31mSESSION LEAK: a bearer request touched the wallet\x1b[0m");
		} else {
			console.log(`    \x1b[32msession held: one deposit (${depositSpend} sat), bearers rode free\x1b[0m`);
		}

		line("closing the session");
		const outcomes = await payingFetch.closeSessions();
		for (const outcome of outcomes) {
			console.log(`    close: ${JSON.stringify(outcome)}`);
		}
	}

	for (const scenario of scenarios) {
		switch (scenario) {
			case "session":
				await runSessionScenario(process.env.SESSION_PROXY_URL ?? "http://127.0.0.1:8406/v1");
				break;

			case "l402":
				await ask(
					"L402 paid inference",
					l402ProxyUrl,
					"l402",
					"In one short sentence: what is the Lightning Network?",
				);
				break;

			case "mpp":
				await ask("MPP paid inference", mppProxyUrl, "auto", "In one short sentence: what is a payment channel?");
				break;

			case "cached": {
				// The same question again. A working cache means the stored
				// credential is presented up front, the seller never issues a
				// 402, and the balance does not move.
				const repeat = await ask(
					"repeat request (expect cache hit, no spend)",
					l402ProxyUrl,
					"l402",
					"In one short sentence: what is the Lightning Network?",
				);
				if (repeat.spent !== 0) {
					console.log(`    \x1b[31mCACHE MISS: the repeat request spent ${repeat.spent} sat\x1b[0m`);
				} else {
					console.log("    \x1b[32mcache hit: no payment on the repeat\x1b[0m");
				}
				break;
			}

			default:
				console.log(`    (skipping unknown scenario ${JSON.stringify(scenario)})`);
		}
	}

	restoreFetch();

	line("durable state on disk");
	for (const file of ["tokens.json", "credentials.json"]) {
		const path = join(stateDir, file);
		if (!existsSync(path)) {
			console.log(`    ${file}: (absent)`);
			continue;
		}
		console.log(`    ${file}:`);
		console.log(
			readFileSync(path, "utf8")
				.split("\n")
				.map((l) => `      ${l}`)
				.join("\n"),
		);
	}

	const closing = await wallet.confirmedBalanceSat();
	console.log(`\n    balance at start: ${opening} sat`);
	console.log(`    balance at end:   ${closing} sat`);
	console.log(`    total spent:      ${opening - closing} sat`);

	line("PAID INFERENCE OK");

	// Keep the wallet alive and answering, exactly as the daemon did.
	//
	// Anything that can drop a file in ctrlDir can drive the wallet, so the
	// directory has to be ours alone before a single command is served.
	// mkdir with a mode does not tighten a directory that already exists, so
	// the stat check is what actually decides: not owned by this uid, or
	// readable by anyone else, means someone else may write commands, and
	// the channel stays off.
	mkdirSync(ctrlDir, { recursive: true, mode: 0o700 });
	const ctrlStat = statSync(ctrlDir);
	const uid = process.getuid?.();
	const ctrlPrivate = (uid === undefined || ctrlStat.uid === uid) && (ctrlStat.mode & 0o777) === 0o700;
	if (!ctrlPrivate) {
		console.error(
			`\ncontrol channel disabled: ${ctrlDir} must be owned by uid ${uid} with mode 0700 ` +
				`(found uid ${ctrlStat.uid}, mode ${(ctrlStat.mode & 0o777).toString(8)})`,
		);
		console.log("\n(wallet staying up; control channel OFF)");
		// Stay alive all the same, so refusing the channel does not drop the
		// wallet and its lock.
		setInterval(() => {}, 1 << 30);
		return;
	}

	const cmdPath = join(ctrlDir, "cmd.json");
	const replyPath = join(ctrlDir, "reply.json");
	const call = (globalThis as { wavewalletdkCall?: (verb: string, req?: unknown) => Promise<unknown> })
		.wavewalletdkCall;

	setInterval(async () => {
		if (!existsSync(cmdPath) || !call) return;
		let cmd: { verb: string; req?: unknown };
		try {
			cmd = JSON.parse(readFileSync(cmdPath, "utf8"));
		} catch {
			unlinkSync(cmdPath);
			return;
		}
		unlinkSync(cmdPath);
		try {
			const result = await call(cmd.verb, cmd.req);
			writeFileSync(replyPath, JSON.stringify({ ok: true, result }, null, 1));
		} catch (err) {
			writeFileSync(replyPath, JSON.stringify({ ok: false, error: (err as Error).message }, null, 1));
		}
	}, 500);

	console.log("\n(wallet staying up; control channel live)");
}

main().catch((err) => {
	console.error(`\n\x1b[31mFAILED: ${err?.stack ?? err}\x1b[0m`);
	// Stay up regardless, so a failure does not drop the wallet and its lock.
	setInterval(() => {}, 1 << 30);
});

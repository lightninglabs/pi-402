import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertSeedIsSafeToGenerate,
	assertWasmDirIsCommonJs,
	WalletService,
	withFetchEnabled,
	writeSeedFile,
} from "../src/wallet.ts";

// A wallet that was never started has neither backend wired, so any call that
// reaches one fails with "wallet not started". These tests lean on that: if
// the amount guard rejects first, the backend is never consulted, which is
// exactly the property worth pinning down for a funding amount.
test("receiveInvoice rejects a non-positive or fractional amount before touching the wallet", async () => {
	const wallet = new WalletService();

	for (const bad of [0, -1, -50_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await assert.rejects(
			() => wallet.receiveInvoice(bad),
			/funding amount must be a positive whole number of sats/,
			`expected ${bad} to be refused`,
		);
	}
});

test("receiveInvoice passes a valid amount through to the backend", async () => {
	const wallet = new WalletService();

	// A well-formed amount clears the guard and reaches the backend, which is
	// absent here. Seeing the "not started" error (and not the guard's) proves
	// the guard let it through rather than silently swallowing it.
	await assert.rejects(() => wallet.receiveInvoice(50_000), /wallet not started/);
});

// gatewayStub stands in for the sidecar's HTTP/JSON gateway, recording the
// paths called so a bootstrap can be checked by the route it took.
function gatewayStub(routes: Record<string, () => { status: number; body: unknown }>) {
	const calls: string[] = [];
	const original = globalThis.fetch;

	globalThis.fetch = (async (url: string | URL | Request) => {
		const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
		calls.push(path);
		const handler = routes[path];
		if (!handler) {
			throw new Error(`unexpected call to ${path}`);
		}
		const { status, body } = handler();
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

// WALLET_NOT_READY is what waved answers the status probe with while no wallet
// has been created yet: a FailedPrecondition, not a description of an
// un-created wallet.
const notReady = () => ({
	status: 400,
	body: {
		code: 9,
		message: "get balance: rpc error: code = FailedPrecondition desc = wallet is not ready (create first)",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "WALLET_NOT_READY",
				domain: "wavelength/wallet",
			},
		],
	},
});

test("startAndUnlock creates the wallet when the status probe reports none exists", async () => {
	// The first run of a fresh sidecar fails the status probe outright rather
	// than answering "not created". Treating that as fatal aborts the whole
	// session before the create path is ever reached, which is exactly the
	// state create exists to resolve.
	const stub = gatewayStub({
		"/v1/wallet/status": notReady,
		"/v1/wallet/unlock": () => ({
			status: 400,
			body: {
				code: 9,
				message: "unlock wallet: rpc error: code = FailedPrecondition desc = wallet is not locked (state=none)",
			},
		}),
		"/v1/wallet/create": () => ({ status: 200, body: { identity_pubkey: "02aa" } }),
	});

	process.env.PI402_WALLETD_GATEWAY = "http://localhost:10041";
	try {
		await new WalletService().startAndUnlock();
		assert.deepEqual(stub.calls, ["/v1/wallet/status", "/v1/wallet/unlock", "/v1/wallet/create"]);
	} finally {
		stub.restore();
		delete process.env.PI402_WALLETD_GATEWAY;
	}
});

test("startAndUnlock surfaces a daemon fault instead of creating a wallet over it", async () => {
	// A probe that fails for any other reason means we cannot tell what state
	// the wallet is in. Creating one anyway would be the wrong move: a
	// reachable-but-faulty daemon may already hold a funded wallet.
	const stub = gatewayStub({
		"/v1/wallet/status": () => ({ status: 500, body: { code: 13, message: "internal error" } }),
	});

	process.env.PI402_WALLETD_GATEWAY = "http://localhost:10041";
	try {
		await assert.rejects(() => new WalletService().startAndUnlock(), /internal error/);
		assert.deepEqual(stub.calls, ["/v1/wallet/status"], "must not have tried to create a wallet");
	} finally {
		stub.restore();
		delete process.env.PI402_WALLETD_GATEWAY;
	}
});

test("startAndUnlock only unlocks when a wallet already exists but is locked", async () => {
	const stub = gatewayStub({
		"/v1/wallet/status": () => ({ status: 200, body: { unlocked: false } }),
		"/v1/wallet/unlock": () => ({ status: 200, body: {} }),
	});

	process.env.PI402_WALLETD_GATEWAY = "http://localhost:10041";
	try {
		await new WalletService().startAndUnlock();
		assert.deepEqual(stub.calls, ["/v1/wallet/status", "/v1/wallet/unlock"]);
	} finally {
		stub.restore();
		delete process.env.PI402_WALLETD_GATEWAY;
	}
});

// embeddedStub installs a fake wavewalletdkCall dispatcher, the global the
// WASM bridge would install. loadWavewalletdk returns an existing dispatcher
// rather than instantiating the module, so this is the seam that lets the
// embedded bootstrap run without any WASM at all. Calls are recorded so a
// test can assert on the route a bootstrap took.
function embeddedStub(handlers: Record<string, (req: any) => unknown>) {
	const calls: Array<{ method: string; req: any }> = [];
	(globalThis as any).wavewalletdkCall = async (method: string, req?: unknown) => {
		calls.push({ method, req });
		const handler = handlers[method];
		if (!handler) {
			throw new Error(`unexpected call to ${method}`);
		}
		return handler(req);
	};
	return {
		calls,
		methods: () => calls.map((call) => call.method),
		restore: () => {
			delete (globalThis as any).wavewalletdkCall;
		},
	};
}

// walletDirEnv points the embedded wallet at a throwaway directory and cleans
// the override up afterwards. Tests must never touch a real ~/.pi402/wallet.
async function walletDirEnv(): Promise<{ dir: string; restore: () => void }> {
	const dir = await mkdtemp(join(tmpdir(), "pi402-wallet-"));
	process.env.PI402_WALLET_DIR = dir;
	return {
		dir,
		restore: () => {
			delete process.env.PI402_WALLET_DIR;
		},
	};
}

test("startAndUnlock refuses to create a wallet over a stale seed file", async () => {
	const env = await walletDirEnv();
	await writeFile(join(env.dir, "seed.txt"), "old words from an earlier wallet\n", { mode: 0o600 });

	const stub = embeddedStub({
		start: () => ({}),
		unlockWallet: () => {
			throw new Error("wallet does not exist");
		},
		createWallet: () => ({ Mnemonic: ["new", "words"] }),
		status: () => ({ Ready: true }),
	});

	try {
		// The refusal must land before createWallet: once the daemon has
		// created a wallet, the stale file and the new database disagree
		// about which wallet the backup belongs to.
		await assert.rejects(() => new WalletService().startAndUnlock(), /seed file already exists/);
		assert.ok(!stub.methods().includes("createWallet"), "must not have created a wallet over the stale seed");
	} finally {
		stub.restore();
		env.restore();
	}
});

test("a create that returns no seed words says the wallet must be deleted", async () => {
	const env = await walletDirEnv();

	const stub = embeddedStub({
		start: () => ({}),
		unlockWallet: () => {
			throw new Error("wallet does not exist");
		},
		// The daemon created the wallet but handed back nothing to back it
		// up with.
		createWallet: () => ({}),
		status: () => ({ Ready: true }),
	});

	try {
		await assert.rejects(
			() => new WalletService().startAndUnlock(),
			(err: Error) => {
				// The wallet exists in the daemon's database at this point,
				// so the error has to say the created wallet has no backup
				// and that deleting the wallet directory now, while it is
				// still empty, is the recovery.
				assert.match(err.message, /no seed backup/);
				assert.ok(err.message.includes(env.dir), "the error must name the wallet directory to delete");
				assert.match(err.message, /delete the wallet directory/);
				assert.match(err.message, /still empty/);
				return true;
			},
		);
		assert.ok(!existsSync(join(env.dir, "seed.txt")), "no seed file must be left behind");
	} finally {
		stub.restore();
		env.restore();
	}
});

test("startAndUnlock leaves an already-unlocked wallet alone", async () => {
	// Unlocking an unlocked wallet is an error, so a usable wallet must be
	// left untouched.
	const stub = gatewayStub({ "/v1/wallet/status": () => ({ status: 200, body: { unlocked: true } }) });

	process.env.PI402_WALLETD_GATEWAY = "http://localhost:10041";
	try {
		await new WalletService().startAndUnlock();
		assert.deepEqual(stub.calls, ["/v1/wallet/status"]);
	} finally {
		stub.restore();
		delete process.env.PI402_WALLETD_GATEWAY;
	}
});

test("startAndUnlock writes the generated seed beside the wallet", async () => {
	const env = await walletDirEnv();
	const words = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract"];

	const stub = embeddedStub({
		start: () => ({}),
		unlockWallet: () => {
			throw new Error("wallet does not exist");
		},
		createWallet: (req) => {
			// Generating must not carry restore fields: a fresh wallet has no
			// history for the daemon to go and scan for.
			assert.equal(req.Mnemonic, undefined);
			assert.equal(req.RecoverState, undefined);
			assert.equal(req.RecoveryWindow, undefined);
			return { Mnemonic: words };
		},
		status: () => ({ Ready: true }),
	});

	try {
		await new WalletService().startAndUnlock();

		const seedPath = join(env.dir, "seed.txt");
		assert.equal(await readFile(seedPath, "utf8"), `${words.join(" ")}\n`);
		assert.equal((await stat(seedPath)).mode & 0o777, 0o600, "the seed file must be owner-only");
	} finally {
		stub.restore();
		env.restore();
	}
});

test("startAndUnlock restores a supplied mnemonic and writes no seed file", async () => {
	const env = await walletDirEnv();
	process.env.PI402_WALLET_MNEMONIC = "  alpha   beta\tgamma\ndelta ";

	const stub = embeddedStub({
		start: () => ({}),
		unlockWallet: () => {
			throw new Error("wallet does not exist");
		},
		createWallet: (req) => {
			// The words arrive split on any whitespace, and a restore asks
			// the daemon to scan for the wallet's history, since the local
			// database knows nothing about it.
			assert.deepEqual(req.Mnemonic, ["alpha", "beta", "gamma", "delta"]);
			assert.equal(req.RecoverState, true);
			assert.equal(req.RecoveryWindow, 100);
			return {};
		},
		status: () => ({ Ready: true }),
	});

	try {
		await new WalletService().startAndUnlock();

		// The restored seed is already in the operator's hands; a second
		// copy on disk would add an exposure and no safety.
		assert.ok(!existsSync(join(env.dir, "seed.txt")), "a restore must not write a seed file");
	} finally {
		stub.restore();
		env.restore();
		delete process.env.PI402_WALLET_MNEMONIC;
	}
});

test("writeSeedFile never overwrites an existing seed file", async () => {
	const env = await walletDirEnv();

	try {
		writeSeedFile(["first", "words"]);
		// The exclusive flag is what protects the words of a wallet that may
		// still hold money from a later create clobbering them.
		assert.throws(() => writeSeedFile(["second", "words"]), /EEXIST/);
		assert.equal(await readFile(join(env.dir, "seed.txt"), "utf8"), "first words\n");
	} finally {
		env.restore();
	}
});

test("writeSeedFile refuses a create that returned no seed words", async () => {
	const env = await walletDirEnv();

	try {
		for (const bad of [undefined, null, [], "not an array"]) {
			assert.throws(() => writeSeedFile(bad), /returned no seed words/);
		}
		assert.ok(!existsSync(join(env.dir, "seed.txt")));
	} finally {
		env.restore();
	}
});

test("assertSeedIsSafeToGenerate gates a plaintext mainnet seed", () => {
	const savedNetwork = process.env.PI402_NETWORK;
	const savedAllow = process.env.PI402_ALLOW_PLAINTEXT_SEED;

	try {
		// On a test network the seed file is plain recoverability, so the
		// gate stays out of the way.
		process.env.PI402_NETWORK = "regtest";
		delete process.env.PI402_ALLOW_PLAINTEXT_SEED;
		assertSeedIsSafeToGenerate();

		// On mainnet the same file is a key to real money in the clear, so
		// generating one is refused until the operator opts in explicitly.
		process.env.PI402_NETWORK = "mainnet";
		assert.throws(() => assertSeedIsSafeToGenerate(), /refusing to generate a mainnet wallet seed/);

		process.env.PI402_ALLOW_PLAINTEXT_SEED = "1";
		assertSeedIsSafeToGenerate();
	} finally {
		if (savedNetwork === undefined) {
			delete process.env.PI402_NETWORK;
		} else {
			process.env.PI402_NETWORK = savedNetwork;
		}
		if (savedAllow === undefined) {
			delete process.env.PI402_ALLOW_PLAINTEXT_SEED;
		} else {
			process.env.PI402_ALLOW_PLAINTEXT_SEED = savedAllow;
		}
	}
});

// setGlobalProcess swaps globalThis.process the same way withFetchEnabled
// does, so the tests can stand in a "real" process whose argv0 they control
// no matter how the test runner itself was invoked.
function setGlobalProcess(value: unknown): void {
	Object.defineProperty(globalThis, "process", {
		value,
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

test("withFetchEnabled shadows argv0 for the run and restores on a throw", () => {
	const actual = globalThis.process;
	const fakeReal = Object.create(actual, { argv0: { value: "node", enumerable: true } });
	setGlobalProcess(fakeReal);

	let observed: NodeJS.Process | undefined;
	try {
		assert.throws(
			() =>
				withFetchEnabled(() => {
					observed = globalThis.process;
					throw new Error("boom");
				}),
			/boom/,
		);

		// The shim was in place during the run: argv0 no longer names node,
		// while everything else still resolves through the prototype to the
		// real process, environment included.
		assert.notEqual(observed, fakeReal);
		assert.equal(observed?.argv0, "pi402-embedded-wallet");
		assert.equal(observed?.pid, actual.pid);
		assert.deepEqual(observed?.env, actual.env);

		// A throw inside the run must still put the real object back.
		assert.equal(globalThis.process, fakeReal, "the real process must be restored after a throw");
	} finally {
		setGlobalProcess(actual);
	}
});

test("withFetchEnabled leaves a non-node host alone", () => {
	const actual = globalThis.process;
	const fakeReal = Object.create(actual, { argv0: { value: "bun", enumerable: true } });
	setGlobalProcess(fakeReal);

	try {
		let observed: NodeJS.Process | undefined;
		withFetchEnabled(() => {
			observed = globalThis.process;
		});

		// Go only disables fetch when argv0 names node, so any other host
		// needs no shim, and the run must see the untouched object.
		assert.equal(observed, fakeReal);
	} finally {
		setGlobalProcess(actual);
	}
});

test("awaitWalletReady gives up once its deadline passes", async () => {
	const wallet = new WalletService();
	// The daemon answers, but never becomes ready.
	(wallet as any).call = async () => ({ Ready: false });

	// Jump the clock 61 seconds per reading, so the first poll is already
	// past the 60 second deadline and the test never sleeps for real.
	const realNow = Date.now;
	let clock = 0;
	Date.now = () => {
		clock += 61_000;
		return clock;
	};

	try {
		await assert.rejects(() => (wallet as any).awaitWalletReady(), /did not become ready/);
	} finally {
		Date.now = realNow;
	}
});

test("readPreimageWasm surfaces a failed send instead of waiting out the clock", async () => {
	const wallet = new WalletService();

	// An entry for another payment first, so the hash filter is exercised,
	// then the failure for ours.
	const entries: unknown[] = [
		{ Progress: { PaymentHash: "feed" }, Status: "confirmed" },
		{ Progress: { PaymentHash: "abcd" }, Status: "failed", FailureReason: "no route" },
	];
	const handle = {
		next: async () => entries.shift() ?? null,
		close: () => {},
	};

	await assert.rejects(() => (wallet as any).readPreimageWasm(handle, "abcd"), /send failed: no route/);
});

test("readPreimageWasm times out when the settle never arrives", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });

	// A stream that never delivers: next() stays pending until close(),
	// which is exactly what the timeout handler calls.
	let releaseNext: ((entry: null) => void) | undefined;
	const handle = {
		next: () =>
			new Promise<null>((resolve) => {
				releaseNext = resolve;
			}),
		close: () => releaseNext?.(null),
	};

	const wallet = new WalletService();
	const pending = assert.rejects(
		() => (wallet as any).readPreimageWasm(handle, "abcd"),
		/timed out waiting for preimage of abcd/,
	);

	t.mock.timers.tick(120_000);
	await pending;
});

// The ESM trap: a bundle inside a "type": "module" package loads its CommonJS
// files as ES modules unless it carries a package.json of its own.
test("assertWasmDirIsCommonJs refuses a bundle under a type:module package", async () => {
	const pkg = await mkdtemp(join(tmpdir(), "pi402-wasm-esm-"));
	const wasmDir = join(pkg, "wasm");
	await mkdir(wasmDir);
	await writeFile(join(pkg, "package.json"), JSON.stringify({ type: "module" }));

	assert.throws(() => assertWasmDirIsCommonJs(wasmDir), /would load as ES modules.*stage-wasm\.sh/s);
});

test("assertWasmDirIsCommonJs accepts a bundle with its own commonjs package.json", async () => {
	const pkg = await mkdtemp(join(tmpdir(), "pi402-wasm-cjs-"));
	const wasmDir = join(pkg, "wasm");
	await mkdir(wasmDir);
	await writeFile(join(pkg, "package.json"), JSON.stringify({ type: "module" }));
	await writeFile(join(wasmDir, "package.json"), JSON.stringify({ type: "commonjs" }));

	assertWasmDirIsCommonJs(wasmDir);
});

test("assertWasmDirIsCommonJs names a scoping package.json it cannot parse", async () => {
	const pkg = await mkdtemp(join(tmpdir(), "pi402-wasm-bad-"));
	const wasmDir = join(pkg, "wasm");
	await mkdir(wasmDir);
	await writeFile(join(wasmDir, "package.json"), "{not json");

	assert.throws(() => assertWasmDirIsCommonJs(wasmDir), /unable to parse .*wasm\/package\.json/);
});

// A small payment is only allowed onto the credit rail when the caller sets
// explicit caps, so prepareSend must carry both, bounded by the per-request
// ceiling. Without them the wallet refuses anything under ~1,000 sat.
test("payInvoice asks for credit caps equal to the per-request ceiling", async () => {
	const saved = process.env.PI402_MAX_SAT_PER_REQUEST;
	process.env.PI402_MAX_SAT_PER_REQUEST = "2500";

	try {
		const wallet = new WalletService();
		const seen: Record<string, any>[] = [];
		(wallet as any).call = async (method: string, args: Record<string, any>) => {
			assert.equal(method, "prepareSend");
			seen.push(args);
			// Over the ceiling, so payInvoice stops after the quote.
			return { SendIntentID: "i", PaymentHash: "h", AmountSat: 3000, FeeSat: 1 };
		};

		await assert.rejects(() => wallet.payInvoice("lnbc1invoice", 20), /exceeds per-request cap 2500/);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].Invoice, "lnbc1invoice");
		assert.equal(seen[0].MaxCreditSat, 2500);
		assert.equal(seen[0].MaxCreditTopupSat, 2500);
	} finally {
		if (saved === undefined) {
			delete process.env.PI402_MAX_SAT_PER_REQUEST;
		} else {
			process.env.PI402_MAX_SAT_PER_REQUEST = saved;
		}
	}
});

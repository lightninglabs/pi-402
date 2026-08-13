import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WalletService } from "../src/wallet.ts";

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

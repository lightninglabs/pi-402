// A mock L402 proxy for exercising the pi-402 buyer loop end to end without
// Lightning. It mimics aperture's challenge surface: a 402 with a
// WWW-Authenticate header carrying a macaroon and a BOLT11-shaped invoice,
// and it accepts the MockInvoicePayer's fixed all-zero preimage on the
// retried request. The upstream is either a built-in fake OpenAI SSE server
// or real Baseten (set BASETEN_API_KEY and UPSTREAM=baseten).
//
// Run with: node --experimental-strip-types dev/mock-l402-proxy.ts
import { randomBytes } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8402);

// UPSTREAM selects the backend: "fake" (default) streams a canned OpenAI
// completion; "baseten" forwards to the real Model APIs endpoint.
const UPSTREAM = process.env.UPSTREAM ?? "fake";
const BASETEN_URL = process.env.BASETEN_URL ?? "https://inference.baseten.co/v1/chat/completions";
const BASETEN_API_KEY = process.env.BASETEN_API_KEY ?? "";

// PRICE_SATS is encoded into the mock invoice's human-readable part so the
// buyer's BOLT11 amount decoding (and therefore the budget policy) sees a
// real amount. 100n = 10 sats, 1000n = 100 sats, etc.
const PRICE_SATS = Number(process.env.PRICE_SATS ?? 10);

// The MockInvoicePayer "pays" by returning 32 zero bytes; the mock proxy
// accepts exactly that preimage, mirroring aperture's preimage check.
const MOCK_PREIMAGE_HEX = "00".repeat(64 / 2);

// BECH32_CHARSET is the data alphabet of a real invoice. It contains no "1",
// which is what lets a decoder find the HRP separator as the last "1".
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// mockInvoice builds a BOLT11-shaped string whose HRP carries the price. The
// data part is garbage (the mock payer never pays it), but it sticks to the
// bech32 charset so the buyer's HRP decoder splits at the right separator.
function mockInvoice(sats: number): string {
	// One satoshi is 10 nano-BTC, so sats * 10 with the "n" multiplier.
	const nanoBtc = sats * 10;
	const data = Array.from(randomBytes(96), (b) => BECH32_CHARSET[b % 32]).join("");
	return `lnbcrt${nanoBtc}n1${data}`;
}

// Tokens issued by this proxy: opaque macaroon -> expiry.
const issuedMacaroons = new Map<string, number>();
const TOKEN_TTL_MS = 10 * 60 * 1000;

function issueChallenge(res: http.ServerResponse): void {
	const macaroon = randomBytes(32).toString("base64");
	issuedMacaroons.set(macaroon, Date.now() + TOKEN_TTL_MS);

	const invoice = mockInvoice(PRICE_SATS);
	const value = `L402 macaroon="${macaroon}", invoice="${invoice}"`;

	res.writeHead(402, {
		"WWW-Authenticate": value,
		"Cache-Control": "no-store",
		"Content-Type": "text/plain",
	});
	res.end("payment required");
	console.log(`[mock-proxy] issued 402 challenge (${PRICE_SATS} sats)`);
}

// checkAuth validates the L402 Authorization header: a known macaroon plus
// the mock preimage.
function checkAuth(req: http.IncomingMessage): boolean {
	const header = req.headers.authorization;
	if (!header?.startsWith("L402 ")) {
		return false;
	}
	const [macaroon, preimage] = header.slice("L402 ".length).split(":");
	const expiry = issuedMacaroons.get(macaroon ?? "");
	if (!expiry || Date.now() > expiry) {
		return false;
	}
	if (preimage !== MOCK_PREIMAGE_HEX) {
		console.log("[mock-proxy] rejected bad preimage");
		return false;
	}
	return true;
}

// fakeCompletion streams a canned OpenAI-compatible SSE completion, ending
// with a usage chunk (mirroring Baseten's include_usage default) and [DONE].
function fakeCompletion(model: string, res: http.ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
	});

	const words = "Lightning pays for these tokens, one chunk at a time.".split(" ");
	const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
	let i = 0;

	const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	const tick = setInterval(() => {
		if (i < words.length) {
			send({
				id,
				object: "chat.completion.chunk",
				model,
				choices: [{ index: 0, delta: { content: `${words[i]} ` }, finish_reason: null }],
			});
			i++;
			return;
		}
		clearInterval(tick);
		send({
			id,
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 25, completion_tokens: words.length, total_tokens: 25 + words.length },
		});
		res.write("data: [DONE]\n\n");
		res.end();
		console.log("[mock-proxy] fake completion streamed");
	}, 30);
}

// forwardToBaseten pipes the request to the real Model APIs endpoint with the
// proxy-held key, streaming the response back verbatim.
async function forwardToBaseten(body: string, res: http.ServerResponse): Promise<void> {
	const upstream = await fetch(BASETEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${BASETEN_API_KEY}`,
		},
		body,
	});

	res.writeHead(upstream.status, {
		"Content-Type": upstream.headers.get("content-type") ?? "application/json",
	});
	if (!upstream.body) {
		res.end();
		return;
	}
	for await (const chunk of upstream.body) {
		res.write(chunk);
	}
	res.end();
	console.log(`[mock-proxy] baseten responded ${upstream.status}`);
}

const server = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		void (async () => {
			const body = Buffer.concat(chunks).toString();

			if (!req.url?.includes("/chat/completions")) {
				res.writeHead(404).end("not found");
				return;
			}

			if (!checkAuth(req)) {
				issueChallenge(res);
				return;
			}

			console.log("[mock-proxy] L402 accepted, forwarding");
			if (UPSTREAM === "baseten") {
				await forwardToBaseten(body, res);
				return;
			}

			const model = (() => {
				try {
					return JSON.parse(body).model ?? "mock-model";
				} catch {
					return "mock-model";
				}
			})();
			fakeCompletion(model, res);
		})().catch((err) => {
			console.error("[mock-proxy] error:", err);
			if (!res.headersSent) {
				res.writeHead(500);
			}
			res.end();
		});
	});
});

server.listen(PORT, () => {
	console.log(`[mock-proxy] listening on :${PORT} (upstream: ${UPSTREAM}, price: ${PRICE_SATS} sats)`);
});

// A minimal fake OpenAI-compatible upstream: streams a canned SSE completion
// with usage on the final chunk, mirroring Baseten's Model APIs surface. Used
// as the backend behind aperture in the tier-2 regtest environment, so the
// full paid path runs with no model credential.
//
// Run with: node --experimental-strip-types dev/fake-openai-upstream.ts
import { randomBytes } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8410);

const server = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		if (!req.url?.includes("/chat/completions")) {
			res.writeHead(404).end("not found");
			return;
		}

		let model = "fake-model";
		try {
			model = JSON.parse(Buffer.concat(chunks).toString()).model ?? model;
		} catch {
			// A body that does not parse still gets a completion.
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
		});

		const words = "Metered inference over Lightning, settled by the preimage.".split(" ");
		const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
		const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
		let i = 0;

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
				usage: { prompt_tokens: 40, completion_tokens: words.length, total_tokens: 40 + words.length },
			});
			res.write("data: [DONE]\n\n");
			res.end();
			console.log(`[fake-upstream] completion streamed (${model})`);
		}, 25);
	});
});

server.listen(PORT, () => {
	console.log(`[fake-upstream] listening on :${PORT}`);
});

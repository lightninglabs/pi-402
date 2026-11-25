// The seller's model menu. A seller lists the models it sells in its rate file
// (<origin>/pi402.json, the file the bundle bar already reads), and the
// extension offers those models instead of a hard-coded list. Adding or
// renaming a model on the seller side then needs no pi-402 release.
//
// The file is read with a plain fetch, never the paying one: the menu is free
// metadata, and a seller that answers it with a 402 simply has no menu. Any
// failure keeps the last menu, or the built-in list when there is none.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RATES_PATH, RATES_TIMEOUT_MS } from "./bundle.ts";

// CatalogModel is one model as the extension registers it with Pi, plus the
// id the seller expects on the wire.
export interface CatalogModel {
	// id is the Pi-facing id, kept slash-free so it composes with Pi's
	// provider/model selection.
	id: string;
	// wireId is the model id sent to the seller.
	wireId: string;
	name: string;
	input: ("text" | "image")[];
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

// MAX_CATALOG_MODELS bounds how many models one seller can add to the menu.
export const MAX_CATALOG_MODELS = 64;

// MAX_CATALOG_BYTES bounds the rate file the menu is read from.
export const MAX_CATALOG_BYTES = 256 * 1024;

// DEFAULT_CONTEXT_WINDOW and DEFAULT_MAX_TOKENS fill in a model the seller
// describes without sizes and the built-in list does not know.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

// A wire id is what a seller's meter keys models by: vendor slugs like
// zai-org/GLM-5.3 or plain ids like deepseek-v4-1-flash.
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

// piModelId derives the Pi-facing id for a wire id the built-in list does not
// know: the part after the last slash, lowercased, with anything outside
// [a-z0-9.-] collapsed to a dash. zai-org/GLM-5.3-Flash becomes glm-5.3-flash.
export function piModelId(wireId: string): string {
	const tail = wireId.slice(wireId.lastIndexOf("/") + 1).toLowerCase();
	return tail.replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

// positiveInt returns value when it is a positive integer no larger than max.
function positiveInt(value: unknown, max: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : undefined;
}

// displayName cleans a seller-supplied name for the model picker: control
// characters dropped, whitespace collapsed, at most 80 characters.
function displayName(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const clean = value
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return clean || undefined;
}

// parseCatalog reads the menu from a rate file body (schema version 1). Each
// key of `models` is a wire id. Every field beyond it is optional:
// contextTokens (already in the file for the bar), and name, input,
// reasoning and maxTokens. A model the built-in list knows keeps its Pi id
// and fills its gaps from there, so existing selections keep working. A
// malformed entry is skipped; a file with no usable entry yields undefined,
// which means no menu.
export function parseCatalog(body: unknown, builtIns: readonly CatalogModel[]): CatalogModel[] | undefined {
	const file = body as { version?: unknown; models?: unknown } | null;
	if (!file || typeof file !== "object" || file.version !== 1) {
		return undefined;
	}
	const entries = file.models;
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
		return undefined;
	}

	const known = new Map(builtIns.map((model) => [model.wireId, model]));
	const seen = new Set<string>();
	const models: CatalogModel[] = [];
	for (const [wireId, raw] of Object.entries(entries as Record<string, unknown>)) {
		if (models.length >= MAX_CATALOG_MODELS) {
			break;
		}
		if (!WIRE_ID.test(wireId) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
			continue;
		}
		const entry = raw as Record<string, unknown>;
		const base = known.get(wireId);
		const id = base?.id ?? piModelId(wireId);
		if (!id || seen.has(id)) {
			continue;
		}

		const contextWindow =
			positiveInt(entry.contextTokens, 100_000_000) ?? base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const maxTokens =
			positiveInt(entry.maxTokens, contextWindow) ?? Math.min(base?.maxTokens ?? DEFAULT_MAX_TOKENS, contextWindow);

		let input = base?.input ?? ["text"];
		if (Array.isArray(entry.input)) {
			const kinds = entry.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image");
			if (kinds.includes("text")) {
				input = [...new Set(kinds)];
			}
		}

		const name = displayName(entry.name);
		seen.add(id);
		models.push({
			id,
			wireId,
			name: name ? `${name} (L402)` : (base?.name ?? `${wireId} (L402)`),
			input,
			reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : (base?.reasoning ?? false),
			contextWindow,
			maxTokens,
		});
	}
	return models.length > 0 ? models : undefined;
}

// fetchCatalog reads the seller's menu. It resolves to the parsed models and
// the raw body (for the cache), or undefined on any failure.
export async function fetchCatalog(
	origin: string,
	builtIns: readonly CatalogModel[],
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
	timeoutMs = RATES_TIMEOUT_MS,
): Promise<{ models: CatalogModel[]; body: unknown } | undefined> {
	try {
		const timeout = AbortSignal.timeout(timeoutMs);
		const res = await fetchFn(`${origin}${RATES_PATH}`, {
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!res.ok) {
			return undefined;
		}
		const text = await res.text();
		if (text.length > MAX_CATALOG_BYTES) {
			return undefined;
		}
		const body: unknown = JSON.parse(text);
		const models = parseCatalog(body, builtIns);
		return models ? { models, body } : undefined;
	} catch {
		return undefined;
	}
}

// CatalogCache keeps the last menu each seller published, so a restart (or an
// offline start) shows it before the network answers. It stores the raw rate
// file and parses it again on read, so a cache written by an older version
// goes through the same checks. Reads are synchronous because the provider is
// registered while the extension loads.
export class CatalogCache {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private readAll(): Record<string, unknown> {
		try {
			const state = JSON.parse(readFileSync(this.path, "utf8")) as { version?: unknown; sellers?: unknown };
			if (state?.version === 1 && state.sellers && typeof state.sellers === "object") {
				return state.sellers as Record<string, unknown>;
			}
		} catch {
			// Missing or corrupt: no cache.
		}
		return {};
	}

	read(origin: string, builtIns: readonly CatalogModel[]): CatalogModel[] | undefined {
		return parseCatalog(this.readAll()[origin], builtIns);
	}

	write(origin: string, body: unknown): void {
		const sellers = { ...this.readAll(), [origin]: body };
		const tmp = `${this.path}.${process.pid}.tmp`;
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(tmp, JSON.stringify({ version: 1, sellers }), { mode: 0o600 });
		renameSync(tmp, this.path);
	}
}

// toProviderModels shapes the menu for pi.registerProvider. Cost is metered
// in sats at the seller, not billed per token here.
export function toProviderModels(models: readonly CatalogModel[]) {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		input: model.input,
		reasoning: model.reasoning,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));
}

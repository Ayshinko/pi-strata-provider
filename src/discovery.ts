import type { Cost, StrataConfig } from "./config.ts";
import { humanizeModelId } from "./names.ts";

/**
 * A model discovered from Strata's /v1/models endpoint, with the metadata Pi
 * needs, filled in from configurable defaults. Structurally compatible with
 * Pi's ProviderChatModelConfig so the extension can register it directly.
 *
 * `contextWindow` and `maxTokens` may be `undefined` when no source of truth
 * produced a value (no `meta.n_ctx`, no per-model override, no config.json
 * default). undefined means "unavailable" — callers must warn/skip rather than
 * invent a limit.
 */
export interface DiscoveredModel {
	id: string;
	name: string;
	input: string[];
	reasoning: boolean;
	contextWindow: number | undefined;
	maxTokens: number | undefined;
	cost: Cost;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string>;
}

/**
 * A single entry parsed from Strata's /v1/models `data` array. Ids are always
 * populated; `nCtx` is present only when Strata reports `meta.n_ctx` on the
 * model (Strata does NOT expose a reliable max_tokens, so we never read one).
 */
export interface CatalogModel {
	id: string;
	/** meta.n_ctx (context window) reported live by Strata, if any. */
	nCtx?: number;
}

/** True when a limit is a finite, positive number (usable for Pi registration). */
export function isValidLimit(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Error thrown when Strata is unreachable or returns an invalid response. */
export class StrataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StrataError";
	}
}

/**
 * Fetch the model catalogue (ids + optional meta.n_ctx) from a Strata
 * OpenAI-compatible server. Throws StrataError on connection problems,
 * timeouts, non-2xx statuses, or invalid JSON/bodies. Callers should catch
 * StrataError to detect offline.
 */
export async function fetchModelCatalog(
	baseUrl: string,
	timeoutMs: number,
	outerSignal?: AbortSignal | null,
): Promise<CatalogModel[]> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	let response: Response;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
		const onAbort = () => controller.abort();
		if (outerSignal?.aborted) outerSignal.throwIfAborted();
		outerSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			response = await fetch(url, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
			outerSignal?.removeEventListener("abort", onAbort);
		}
	} catch (err) {
		throw new StrataError(`Could not reach Strata at ${url}: ${errorMessage(err)}`);
	}
	if (!response.ok) {
		throw new StrataError(`Strata /models returned HTTP ${response.status}`);
	}
	let json: unknown;
	try {
		json = await response.json();
	} catch (err) {
		throw new StrataError(`Strata /models returned invalid JSON: ${errorMessage(err)}`);
	}
	return parseModelCatalog(json);
}

/** Fetch just the model id list (thin wrapper over fetchModelCatalog). */
export async function fetchModelIds(
	baseUrl: string,
	timeoutMs: number,
	outerSignal?: AbortSignal | null,
): Promise<string[]> {
	const catalog = await fetchModelCatalog(baseUrl, timeoutMs, outerSignal);
	return catalog.map((m) => m.id);
}

/** Parse a /v1/models response into unique catalogue entries (ids + meta.n_ctx). */
export function parseModelCatalog(json: unknown): CatalogModel[] {
	const byId = new Map<string, CatalogModel>();
	for (const item of extractDataArray(json)) {
		if (!item || typeof item !== "object") continue;
		const obj = item as { id?: unknown; meta?: unknown };
		if (typeof obj.id !== "string") continue;
		const id = obj.id.trim();
		if (!id) continue;
		const nCtx = parseNCtx(obj.meta);
		const existing = byId.get(id);
		if (!existing) {
			byId.set(id, nCtx === undefined ? { id } : { id, nCtx });
		} else if (nCtx !== undefined && existing.nCtx === undefined) {
			existing.nCtx = nCtx;
		}
	}
	return Array.from(byId.values());
}

/** Extract just the id list from a /v1/models response. */
export function parseModelIds(json: unknown): string[] {
	return parseModelCatalog(json).map((m) => m.id);
}

function parseNCtx(meta: unknown): number | undefined {
	if (!meta || typeof meta !== "object") return undefined;
	const nCtx = (meta as { n_ctx?: unknown }).n_ctx;
	return isValidLimit(nCtx) ? nCtx : undefined;
}

function extractDataArray(json: unknown): unknown[] {
	if (Array.isArray(json)) return json;
	if (json && typeof json === "object") {
		const data = (json as { data?: unknown }).data;
		if (Array.isArray(data)) return data;
	}
	return [];
}

/**
 * Build Pi-ready model definitions for the given ids, applying configurable
 * defaults, per-model overrides, and — where available — Strata's live
 * `meta.n_ctx`. No limit is invented when the sources are exhausted.
 */
export function buildModels(ids: readonly string[], cfg: StrataConfig): DiscoveredModel[] {
	return buildModelsFromCatalog(ids.map((id) => ({ id })), cfg);
}

/**
 * Build Pi-ready model definitions from the full Strata catalogue, applying
 * the documented precedence rules.
 *
 * CONTEXT WINDOW:
 *   1. live Strata meta.n_ctx
 *   2. per-model config override
 *   3. config.json defaults.contextWindow
 *
 * MAX OUTPUT TOKENS:
 *   1. per-model config override maxTokens
 *   2. config.json defaults.maxTokens
 *   (never derived from n_ctx / contextWindow — Strata exposes no max_tokens)
 */
export function buildModelsFromCatalog(
	catalog: readonly CatalogModel[],
	cfg: StrataConfig,
): DiscoveredModel[] {
	const defaults = cfg.defaults;
	return catalog.map((entry) => {
		const id = entry.id;
		const ov = cfg.models?.[id];
		const contextWindow = entry.nCtx ?? ov?.contextWindow ?? defaults.contextWindow;
		const maxTokens = ov?.maxTokens ?? defaults.maxTokens;
		return {
			id,
			name: ov?.name ?? humanizeModelId(id),
			input: ov?.input ?? defaults.input,
			reasoning: ov?.reasoning ?? defaults.reasoning,
			contextWindow,
			maxTokens,
			cost: { ...defaults.cost, ...(ov?.cost ?? {}) },
			compat: ov?.compat ?? defaults.compat,
			thinkingLevelMap: ov?.thinkingLevelMap ?? defaults.thinkingLevelMap,
		};
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
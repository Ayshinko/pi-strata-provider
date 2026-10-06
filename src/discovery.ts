import type { Cost, StrataConfig } from "./config.ts";
import { humanizeModelId } from "./names.ts";

/**
 * A model discovered from Strata's /v1/models endpoint, with the metadata Pi
 * needs, filled in from configurable defaults. Structurally compatible with
 * Pi's ProviderChatModelConfig so the extension can register it directly.
 */
export interface DiscoveredModel {
	id: string;
	name: string;
	input: string[];
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: Cost;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string>;
}

/** Error thrown when Strata is unreachable or returns an invalid response. */
export class StrataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StrataError";
	}
}

/**
 * Fetch the model id list from a Strata OpenAI-compatible server.
 * Throws StrataError on connection problems, timeouts, non-2xx statuses, or
 * invalid JSON/bodies. Callers should catch StrataError to detect offline.
 */
export async function fetchModelIds(
	baseUrl: string,
	timeoutMs: number,
	outerSignal?: AbortSignal | null,
): Promise<string[]> {
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
	return parseModelIds(json);
}

/** Extract unique, non-empty model ids from a parsed /v1/models response. */
export function parseModelIds(json: unknown): string[] {
	const ids = new Set<string>();
	for (const item of extractDataArray(json)) {
		if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
			const id = (item as { id: string }).id.trim();
			if (id.length > 0) ids.add(id);
		}
	}
	return Array.from(ids);
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
 * defaults and any per-model overrides.
 */
export function buildModels(ids: readonly string[], cfg: StrataConfig): DiscoveredModel[] {
	const defaults = cfg.defaults;
	return ids.map((id) => {
		const ov = cfg.models?.[id];
		return {
			id,
			name: ov?.name ?? humanizeModelId(id),
			input: ov?.input ?? defaults.input,
			reasoning: ov?.reasoning ?? defaults.reasoning,
			contextWindow: ov?.contextWindow ?? defaults.contextWindow,
			maxTokens: ov?.maxTokens ?? defaults.maxTokens,
			cost: { ...defaults.cost, ...(ov?.cost ?? {}) },
			compat: ov?.compat ?? defaults.compat,
			thinkingLevelMap: ov?.thinkingLevelMap ?? defaults.thinkingLevelMap,
		};
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
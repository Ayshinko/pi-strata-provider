import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Token cost rates (per one million tokens). */
export interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Default metadata applied to every discovered Strata model. */
export interface ModelDefaults {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	cost: Cost;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string>;
}

/** Optional per-model overrides keyed by the Strata model id. */
export interface ModelOverride {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	cost?: Partial<Cost>;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string>;
}

/** Runtime configuration for the strata-auto provider. */
export interface StrataConfig {
	/** Pi provider id (registered with pi.registerProvider). */
	providerId: string;
	/** Provider display name. */
	name: string;
	/** Strata OpenAI-compatible base URL. */
	baseUrl: string;
	/** Dummy API key for the local, keyless endpoint. */
	apiKey: string;
	/** Pi API implementation used to talk to Strata. */
	api: string;
	/** How long to wait for the /models request before giving up. */
	timeoutMs: number;
	/** Model metadata defaults for discovered models. */
	defaults: ModelDefaults;
	/** Per-model overrides keyed by model id. */
	models: Record<string, ModelOverride>;
}

/** Sensible defaults. These are easy to change or override via config.json. */
export const DEFAULT_CONFIG: StrataConfig = {
	providerId: "strata-auto",
	name: "Strata Auto",
	baseUrl: "http://127.0.0.1:8080/v1",
	apiKey: "local",
	api: "openai-completions",
	timeoutMs: 2500,
	defaults: {
		contextWindow: 65536,
		maxTokens: 16384,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsReasoningEffort: true },
		thinkingLevelMap: {
			off: "none",
			minimal: "none",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
			max: "high",
		},
	},
	models: {},
};

/**
 * Load the package-local config.json (optional). Missing or invalid values fall
 * back to DEFAULT_CONFIG. Overrides in the JSON are merged over the defaults.
 */
export function loadConfig(configPath?: string): StrataConfig {
	let raw: unknown;
	const resolved = configPath ?? resolveDefaultConfigPath();
	if (resolved && existsSync(resolved)) {
		try {
			raw = JSON.parse(readFileSync(resolved, "utf8"));
		} catch {
			raw = undefined;
		}
	}
	if (!raw || typeof raw !== "object") {
		return { ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults }, models: {} };
	}
	return mergeConfig(DEFAULT_CONFIG, raw as Record<string, unknown>);
}

function resolveDefaultConfigPath(): string | undefined {
	try {
		// config.ts lives at <pkg>/src/config.ts; the package config.json is one level up.
		const here = fileURLToPath(import.meta.url);
		return fileURLToPath(new URL("../config.json", pathToFileURL(here)));
	} catch {
		return undefined;
	}
}

function mergeConfig(base: StrataConfig, raw: Record<string, unknown>): StrataConfig {
	const merged: StrataConfig = {
		...base,
		providerId: str(raw.providerId, base.providerId),
		name: str(raw.name, base.name),
		baseUrl: str(raw.baseUrl, base.baseUrl),
		apiKey: str(raw.apiKey, base.apiKey),
		api: str(raw.api, base.api),
		timeoutMs: num(raw.timeoutMs, base.timeoutMs),
		defaults: {
			...base.defaults,
			cost: { ...base.defaults.cost },
		},
		models: {},
	};
	if (raw.defaults && typeof raw.defaults === "object") {
		const d = raw.defaults as Record<string, unknown>;
		if (d.contextWindow !== undefined) merged.defaults.contextWindow = num(d.contextWindow, base.defaults.contextWindow);
		if (d.maxTokens !== undefined) merged.defaults.maxTokens = num(d.maxTokens, base.defaults.maxTokens);
		if (d.reasoning !== undefined) merged.defaults.reasoning = bool(d.reasoning, base.defaults.reasoning);
		if (d.input !== undefined && Array.isArray(d.input)) merged.defaults.input = d.input as string[];
		if (d.cost && typeof d.cost === "object") {
			merged.defaults.cost = { ...base.defaults.cost, ...(d.cost as object) };
		}
		if (d.compat && typeof d.compat === "object") merged.defaults.compat = d.compat as Record<string, unknown>;
		if (d.thinkingLevelMap && typeof d.thinkingLevelMap === "object")
			merged.defaults.thinkingLevelMap = d.thinkingLevelMap as Record<string, string>;
	}
	if (raw.models && typeof raw.models === "object") {
		for (const [id, ov] of Object.entries(raw.models as Record<string, unknown>)) {
			if (!ov || typeof ov !== "object") continue;
			const o = ov as Record<string, unknown>;
			const override: ModelOverride = {};
			if (o.name !== undefined) override.name = o.name as string;
			if (o.contextWindow !== undefined) override.contextWindow = num(o.contextWindow, base.defaults.contextWindow);
			if (o.maxTokens !== undefined) override.maxTokens = num(o.maxTokens, base.defaults.maxTokens);
			if (o.reasoning !== undefined) override.reasoning = bool(o.reasoning, base.defaults.reasoning);
			if (o.input !== undefined && Array.isArray(o.input)) override.input = o.input as string[];
			if (o.cost && typeof o.cost === "object") override.cost = o.cost as Partial<Cost>;
			if (o.compat && typeof o.compat === "object") override.compat = o.compat as Record<string, unknown>;
			if (o.thinkingLevelMap && typeof o.thinkingLevelMap === "object")
				override.thinkingLevelMap = o.thinkingLevelMap as Record<string, string>;
			merged.models[id] = override;
		}
	}
	return merged;
}

function str(v: unknown, fallback: string): string {
	return typeof v === "string" && v.length > 0 ? v : fallback;
}
function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}
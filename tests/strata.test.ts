import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	parseModelIds,
	parseModelCatalog,
	fetchModelIds,
	fetchModelCatalog,
	buildModels,
	buildModelsFromCatalog,
	isValidLimit,
	StrataError,
	type DiscoveredModel,
} from "../src/discovery.ts";
import { humanizeModelId } from "../src/names.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

/** Replace global fetch for the duration of a test; returns a restore fn. */
function installFetch(impl: (input: any, init?: any) => Promise<any>): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	return () => {
		globalThis.fetch = original;
	};
}

function mockResponse(body: unknown, status = 200): Promise<Response> {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response);
}

const MOCK_CATALOG = {
	object: "list",
	data: [
		{ id: "swift-1.5-iq3_xxs", object: "model", status: { value: "loaded" } },
		{ id: "qwen3.8-flash-next-q2_0", object: "model", status: { value: "loaded" } },
		{ id: "nv-ctx", object: "model", meta: { n_ctx: 65536 } },
	],
};

// ---------------------------------------------------------------------------
// 1. Extension modules import cleanly and defaults load without a config file.
// ---------------------------------------------------------------------------
test("modules import and DEFAULT_CONFIG is well-formed", () => {
	assert.equal(DEFAULT_CONFIG.providerId, "strata-auto");
	assert.equal(DEFAULT_CONFIG.baseUrl, "http://127.0.0.1:8080/v1");
	// No hardcoded model-limit fallbacks may live in source; config.json is the
	// single editable source of truth for maxTokens, Strata meta.n_ctx for ctx.
	assert.equal(DEFAULT_CONFIG.defaults.contextWindow, undefined);
	assert.equal(DEFAULT_CONFIG.defaults.maxTokens, undefined);
	assert.ok(DEFAULT_CONFIG.defaults.cost);
});

test("loadConfig reads the shipped package config.json (BOM-tolerant)", () => {
	const cfg = loadConfig();
	assert.equal(cfg.providerId, "strata-auto");
	assert.equal(cfg.defaults.contextWindow, 65536);
	assert.equal(cfg.defaults.maxTokens, 32768);
});

// ---------------------------------------------------------------------------
// 2. Parsing produces model ids.
// ---------------------------------------------------------------------------
test("parseModelIds extracts dispatched ids from real /v1/models shape", () => {
	const ids = parseModelIds(MOCK_CATALOG);
	assert.deepEqual(ids, ["swift-1.5-iq3_xxs", "qwen3.8-flash-next-q2_0", "nv-ctx"]);
});

// ---------------------------------------------------------------------------
// 3. buildModels produces Pi-ready model definitions. With DEFAULT_CONFIG there
//    is NO hardcoded model-limit fallback, so limits are undefined (unavailable)
//    rather than an invented number.
// ---------------------------------------------------------------------------
test("buildModels with DEFAULT_CONFIG leaves limits unavailable (no invented fallback)", () => {
	const models = buildModels(["swift-1.5-iq3_xxs", "qwen3.8-flash-next-q2_0"], DEFAULT_CONFIG);
	assert.equal(models.length, 2);
	const swift = models.find((m) => m.id === "swift-1.5-iq3_xxs") as DiscoveredModel;
	assert.equal(swift.name, "Swift 1.5 IQ3_XXS");
	assert.equal(swift.contextWindow, undefined);
	assert.equal(swift.maxTokens, undefined);
	assert.equal(swift.reasoning, true);
	assert.deepEqual(swift.input, ["text"]);
	assert.equal(swift.cost.input, 0);
	assert.equal(swift.cost.output, 0);
	assert.equal(swift.cost.cacheRead, 0);
	assert.equal(swift.cost.cacheWrite, 0);
	assert.deepEqual(swift.compat, { supportsReasoningEffort: true });
});

test("name derivation examples", () => {
	assert.equal(humanizeModelId("swift-1.5-iq3_xxs"), "Swift 1.5 IQ3_XXS");
	assert.equal(humanizeModelId("qwen3.8-flash-next-q2_0"), "Qwen3.8 Flash Next Q2_0");
});

// ---------------------------------------------------------------------------
// 4. Invalid response is handled (empty list, never throws).
// ---------------------------------------------------------------------------
test("invalid /v1/models response yields an empty list", () => {
	assert.deepEqual(parseModelIds(null), []);
	assert.deepEqual(parseModelIds({ foo: "bar" }), []);
	assert.deepEqual(parseModelIds({ data: "not-an-array" }), []);
	assert.deepEqual(parseModelIds([{ id: "" }, { id: "  " }, { nope: 1 }]), []);
});

test("invalid JSON from the server is a StrataError", async () => {
	const restore = installFetch(() =>
		Promise.resolve({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error("bad json");
			},
		} as unknown as Response),
	);
	try {
		await assert.rejects(fetchModelIds("http://127.0.0.1:8080/v1", 500), StrataError);
	} finally {
		restore();
	}
});

// ---------------------------------------------------------------------------
// 5. Connection refused is handled without crashing.
// ---------------------------------------------------------------------------
test("connection refused surfaces as StrataError", async () => {
	const restore = installFetch(async () => {
		throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8080");
	});
	try {
		await assert.rejects(fetchModelIds("http://127.0.0.1:8080/v1", 500), StrataError);
	} finally {
		restore();
	}
});

test("non-2xx response surfaces as StrataError", async () => {
	const restore = installFetch(() => mockResponse({}, 503));
	try {
		await assert.rejects(fetchModelIds("http://127.0.0.1:8080/v1", 500), StrataError);
	} finally {
		restore();
	}
});

// ---------------------------------------------------------------------------
// 6. Timeout is handled.
// ---------------------------------------------------------------------------
test("timeout surfaces as StrataError", async () => {
	// A fetch that never resolves but rejects once the caller aborts the request
	// (as a real network fetch would). exercise fetchModelIds' own timeout.
	const restore = installFetch((_input: any, init?: any) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => reject(new DOMException("timed out", "AbortError")),
				{ once: true },
			);
		}),
	);
	try {
		await assert.rejects(fetchModelIds("http://127.0.0.1:8080/v1", 60), StrataError);
	} finally {
		restore();
	}
});

// ---------------------------------------------------------------------------
// 7. Duplicate model ids are de-duplicated.
// ---------------------------------------------------------------------------
test("duplicate model ids are collapsed", () => {
	const ids = parseModelIds({
		data: [
			{ id: "swift-1.5-iq3_xxs" },
			{ id: "swift-1.5-iq3_xxs" },
			{ id: "qwen3.8-flash-next-q2_0" },
		],
	});
	assert.deepEqual(ids, ["swift-1.5-iq3_xxs", "qwen3.8-flash-next-q2_0"]);
});

// ---------------------------------------------------------------------------
// 8. Per-model overrides and defaults are applied.
// ---------------------------------------------------------------------------
test("per-model overrides override defaults", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		defaults: { ...DEFAULT_CONFIG.defaults, contextWindow: 49152, maxTokens: 4096 },
		models: {
			"swift-1.5-iq3_xxs": { name: "Custom Swift", contextWindow: 8000, maxTokens: 1000 },
		},
	};
	const [swift, qwen] = buildModels(["swift-1.5-iq3_xxs", "qwen3.8-flash-next-q2_0"], cfg);
	assert.equal(swift.name, "Custom Swift");
	assert.equal(swift.contextWindow, 8000);
	assert.equal(swift.maxTokens, 1000);
	assert.equal(qwen.name, "Qwen3.8 Flash Next Q2_0");
	assert.equal(qwen.contextWindow, 49152);
	assert.equal(qwen.maxTokens, 4096);
});

test("config.json merge respects user values", () => {
	const cfg = loadConfig("tests/fixtures/config.json");
	assert.equal(cfg.providerId, "strata-auto");
	assert.equal(cfg.defaults.contextWindow, 100000);
	assert.equal(cfg.defaults.maxTokens, 32000);
	assert.equal(cfg.timeoutMs, 1500);
	assert.equal(cfg.models["swift-1.5-iq3_xxs"].contextWindow, 64000);
});

// ---------------------------------------------------------------------------
// 9. Full discovery round-trip using a stubbed (online) server.
// ---------------------------------------------------------------------------
test("fetchModelIds + buildModels round-trip reports the real model", async () => {
	const restore = installFetch(() => mockResponse(MOCK_CATALOG, 200));
	try {
		const ids = await fetchModelIds("http://127.0.0.1:8080/v1", 500);
		assert.deepEqual(ids, ["swift-1.5-iq3_xxs", "qwen3.8-flash-next-q2_0", "nv-ctx"]);
		const models = buildModels(ids, DEFAULT_CONFIG);
		assert.ok(models.some((m) => m.id === "swift-1.5-iq3_xxs"));
	} finally {
		restore();
	}
});

// ---------------------------------------------------------------------------
// 10. Single source of truth: Strata meta.n_ctx + config.json maxTokens.
// ---------------------------------------------------------------------------

test("Strata meta.n_ctx=65536 overrides stale configured contextWindow", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		// "stale" configured default context window — Strata's live metadata wins.
		defaults: { ...DEFAULT_CONFIG.defaults, contextWindow: 32768, maxTokens: 32768 },
		models: {},
	};
	const [model] = buildModelsFromCatalog([{ id: "swift-1.5-iq3_xxs", nCtx: 65536 }], cfg);
	assert.equal(model.contextWindow, 65536);
	// No nCtx-based maxTokens invention; falls through to config.json default.
	assert.equal(model.maxTokens, 32768);
});

test("maxTokens=32768 comes from config.json defaults (registered result)", () => {
	const cfg = loadConfig(); // reads package config.json (maxTokens 32768)
	assert.equal(cfg.defaults.maxTokens, 32768);
	// Desired result with current Strata: n_ctx 65536, config.json maxTokens 32768.
	const [model] = buildModelsFromCatalog([{ id: "nv-ctx", nCtx: 65536 }], cfg);
	assert.equal(model.contextWindow, 65536);
	assert.equal(model.maxTokens, 32768);
});

test("no literal 16384 fallback remains in production source", () => {
	const sourceDir = resolve(import.meta.dirname, "../src");
	const files: string[] = [];
	(function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else files.push(p);
		}
	})(sourceDir);
	for (const file of files.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
		const content = readFileSync(file, "utf8");
		assert.ok(!content.includes("16384"), `${file} still contains a literal 16384`);
		assert.ok(!content.includes("32768"), `${file} still contains a literal 32768`);
	}
});

test("changing config maxTokens to 49152 produces maxTokens=49152 without source edits", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-strata-config-"));
	const configPath = join(dir, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({ defaults: { contextWindow: 8192, maxTokens: 49152 } }, null, 2),
	);
	try {
		const cfg = loadConfig(configPath);
		const [model] = buildModelsFromCatalog([{ id: "nv-ctx" }], cfg);
		assert.equal(model.maxTokens, 49152);
		assert.equal(model.contextWindow, 8192);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("per-model maxTokens override wins over defaults", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		defaults: { ...DEFAULT_CONFIG.defaults, maxTokens: 32768, contextWindow: 65536 },
		models: { "swift-1.5-iq3_xxs": { maxTokens: 8192 } },
	};
	const [swift, qwen] = buildModels(["swift-1.5-iq3_xxs", "qwen3.8-flash-next-q2_0"], cfg);
	assert.equal(swift.maxTokens, 8192);
	assert.equal(qwen.maxTokens, 32768);
});

test("missing maxTokens does not silently become 16384", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		defaults: { ...DEFAULT_CONFIG.defaults }, // no maxTokens, no contextWindow
		models: {},
	};
	const [model] = buildModelsFromCatalog([{ id: "swift-1.5-iq3_xxs" }], cfg);
	assert.equal(model.maxTokens, undefined);
	assert.notEqual(model.maxTokens, 16384);
	assert.equal(model.contextWindow, undefined);
	// Such a model is genuinely unavailable and must not be registered.
	assert.equal(isValidLimit(model.maxTokens), false);
});

test("isValidLimit distinguishes available vs unavailable limits", () => {
	assert.equal(isValidLimit(1000), true);
	assert.equal(isValidLimit(undefined), false);
	assert.equal(isValidLimit(0), false);
	assert.equal(isValidLimit(Number.NaN), false);
});

// ---------------------------------------------------------------------------
// 11. Optional live test against a running Strata server.
//     Run with:  STRATA_LIVE_TEST=1 node --test tests/strata.test.ts
// ---------------------------------------------------------------------------
test("live: real Strata /v1/models is queried", { skip: !process.env.STRATA_LIVE_TEST }, async () => {
	const catalog = await fetchModelCatalog("http://127.0.0.1:8080/v1", 3000);
	assert.ok(catalog.length >= 0);
	const models = buildModelsFromCatalog(catalog, DEFAULT_CONFIG);
	for (const m of models) {
		assert.equal(typeof m.id, "string");
		if (isValidLimit(m.contextWindow)) assert.ok(m.contextWindow > 0);
	}
});
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { buildModels, fetchModelIds, StrataError } from "./discovery.ts";
import type { DiscoveredModel } from "./discovery.ts";
import { loadConfig } from "./config.ts";
import type { StrataConfig } from "./config.ts";

// Module-level state shared across extension reloads within the Pi process.
let config: StrataConfig | null = null;
let currentModels: DiscoveredModel[] = [];
let registered = false;

/** Best-effort discovery. Never throws; reports offline status + last-known models. */
async function discoverAndStore(): Promise<{
	models: DiscoveredModel[];
	offline: boolean;
	error?: string;
}> {
	const cfg = config!;
	try {
		const ids = await fetchModelIds(cfg.baseUrl, cfg.timeoutMs);
		currentModels = buildModels(ids, cfg);
		return { models: currentModels, offline: false };
	} catch (err) {
		const offline = err instanceof StrataError;
		return {
			models: currentModels,
			offline,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Build the ProviderConfig Pi should register. */
function buildProviderConfig(): ProviderConfig {
	const cfg = config!;
	return {
		name: cfg.name,
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		api: cfg.api as ProviderConfig["api"],
		models: currentModels as unknown as ProviderModelConfig[],
		refreshModels: async (context) => {
			// On cache-only initialization, keep the last-known list without a network call.
			if (context.allowNetwork === false) {
				return currentModels as unknown as ProviderModelConfig[];
			}
			// Attempt a live refresh. On failure we retain the previous list so a
			// temporary outage does not wipe the in-memory catalogue.
			await discoverAndStore();
			return currentModels as unknown as ProviderModelConfig[];
		},
	};
}

/** (Re)apply the provider registration so the runtime registry reflects currentModels. */
function applyProvider(pi: ExtensionAPI): void {
	if (registered) {
		pi.unregisterProvider(config!.providerId);
	}
	pi.registerProvider(config!.providerId, buildProviderConfig());
	registered = true;
}

function formatModels(models: DiscoveredModel[]): string {
	const ids = models.map((m) => m.id);
	return ids.length === 0 ? "(none)" : ids.map((id) => `- ${id}`).join("\n");
}

export default async function strataProviderExtension(pi: ExtensionAPI): Promise<void> {
	config = await loadConfig();

	// Best-effort initial discovery so /model shows models even before a refresh.
	await discoverAndStore();
	applyProvider(pi);

	pi.registerCommand("strata-refresh", {
		description: `Re-discover models from Strata (${config!.baseUrl})`,
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await discoverAndStore();
			applyProvider(pi);
			if (result.offline) {
				ctx.ui.notify(
					`Strata: refresh failed — ${result.error ?? "offline"}` +
						(currentModels.length > 0 ? `\nKept last-known models (${currentModels.length}).` : ""),
					"error",
				);
				return;
			}
			const count = result.models.length;
			const summary = count === 1 ? "model" : "models";
			ctx.ui.notify(`Strata: ${count} ${summary} discovered\n${formatModels(result.models)}`, "info");
		},
	});

	pi.registerCommand("strata-status", {
		description: `Show Strata endpoint status and discovered models (${config!.baseUrl})`,
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await discoverAndStore();
			const cfg = config!;
			const lines = [
				"Strata",
				`Endpoint: ${cfg.baseUrl}`,
				`Status: ${result.offline ? "offline" : "online"}`,
			];
			if (result.offline && result.error) {
				lines.push(`Error: ${result.error}`);
			}
			lines.push(`Models: ${result.models.length}`);
			if (result.models.length > 0) {
				lines.push(formatModels(result.models));
			}
			ctx.ui.notify(lines.join("\n"), result.offline ? "error" : "info");
		},
	});
}
# pi-strata-provider

A lightweight [Pi](https://pi.dev) provider extension that **automatically discovers models** exposed by a local **Strata** OpenAI-compatible server.

It registers a dynamic Pi provider named **`strata-auto`** that queries Strata's `/v1/models` endpoint and makes every returned model available in Pi's `/model` picker — **without you having to hand-edit `models.json` every time Strata loads a new GGUF**.

- **Provider id:** `strata-auto`
- **Strata endpoint:** `http://127.0.0.1:8080/v1`
- **API:** OpenAI-compatible (`openai-completions`)
- **Discovery source:** `GET http://127.0.0.1:8080/v1/models`

---

## Why does this exist?

Pi normally requires models to be declared statically in `~/.pi/agent/models.json` (or to come from a bundled catalogue). Adding a locally-served GGUF model meant editing that file by hand. This extension replaces that manual step: it performs the dynamic model discovery that Pi's official **custom-provider / `registerProvider` / `refreshModels`** APIs support, so Strata models show up automatically.

It is intentionally **small and dependency-free** — it uses built-in `fetch`, no HTTP libraries, and no packaged runtime dependencies.

---

## How it works

1. On extension load, the package asynchronously queries Strata's `/v1/models`.
2. Every valid model object returned is mapped to a Pi chat model definition with configurable defaults.
3. The models are registered under the `strata-auto` provider via `pi.registerProvider(...)`.
4. `refreshModels` and the `/strata-refresh` command re-query `/v1/models` and update the catalogue.
5. Only models **actually reported by Strata** are discoverable. The package does **not** scan `E:\Model`, does **not** infer models from GGUF filenames, and does **not** modify `models.json`.

---

## Installation

Install with Pi's package manager. From any directory:

```bash
pi install C:\Users\matri\.pi\agent\git\github.com\Ayshinko\pi-strata-provider
```

or from the checkout directory:

```bash
pi install .
```

> For a one-off test without installing, load the extension directly:
> ```bash
> pi -e ./src/index.ts
> ```

After installing, either start a new Pi session or run `/reload`. Verify the provider is listed:

```bash
pi --extension ./src/index.ts --list-models | grep strata
```

You should see (at minimum, while `swift-1.5-iq3_xxs` is loaded in Strata):

```
strata-auto   swift-1.5-iq3_xxs
```

The existing **`strata-local`** provider (from `models.json`) and any other providers (e.g. OpenRouter) are **not** touched.

---

## Commands

### `/strata-refresh`

Re-queries `http://127.0.0.1:8080/v1/models` and refreshes the dynamic catalogue.

Example output:

```
Strata: 1 model discovered
- swift-1.5-iq3_xxs
```

If Strata is offline it reports the failure and, if a previous discovery exists, it keeps the **last-known** models for the current Pi process instead of clearing them:

```
Strata: refresh failed - Could not reach Strata at ...
Kept last-known models (1).
```

### `/strata-status`

Shows the endpoint, live status, and the current discovery:

```
Strata
Endpoint: http://127.0.0.1:8080/v1
Status: online
Models: 1
- swift-1.5-iq3_xxs
```

When Strata is offline:

```
Strata
Endpoint: http://127.0.0.1:8080/v1
Status: offline
Error: Could not reach Strata at ...
Models: 0
```

---

## Selecting a model

Use `/model` and search for the discovered models using the `strata-auto` provider prefix:

```
strata-auto/swift-1.5-iq3_xxs
```

Think of it like any other provider/model pair (for example `openrouter/some-model`).

---

## Configuration

All configuration is optional and lives in a package-local `config.json` next to `package.json`. If the file is absent, sensible defaults are used, so **no configuration is required** for normal operation.

```json
{
  "providerId": "strata-auto",
  "name": "Strata Auto",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "apiKey": "local",
  "api": "openai-completions",
  "timeoutMs": 2500,
  "defaults": {
    "contextWindow": 65536,
    "maxTokens": 16384,
    "reasoning": true,
    "input": ["text"],
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
    "compat": { "supportsReasoningEffort": true },
    "thinkingLevelMap": {
      "off": "none", "minimal": "none", "low": "low", "medium": "medium",
      "high": "high", "xhigh": "high", "max": "high"
    }
  },
  "models": {}
}
```

### Defaults

Strata's `/v1/models` generally returns an **id** plus runtime info (such as `n_ctx`), but not Pi-specific fields like output limits or pricing. This package applies configurable `defaults` to every discovered model:

| Field | Default |
| --- | --- |
| `contextWindow` | `65536` |
| `maxTokens` | `16384` |
| `reasoning` | `true` |
| `input` | `["text"]` |
| `cost` (all four rates) | `0` |
| `compat.supportsReasoningEffort` | `true` |
| `thinkingLevelMap` | generic 7-level mapping |

### Per-model overrides

Add an entry to the `models` object keyed by the **exact Strata model id** to override any default for that model:

```json
{
  "models": {
    "swift-1.5-iq3_xxs": {
      "name": "Swift 1.5 IQ3_XXS (local strata)",
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen3.8-flash-next-q2_0": {
      "reasoning": false
    }
  }
}
```

Overrides are optional; without them the defaults apply.

---

## Model names

Readable names are derived from the returned model id:

| Strata model id | Pi display name |
| --- | --- |
| `swift-1.5-iq3_xxs` | `Swift 1.5 IQ3_XXS` |
| `qwen3.8-flash-next-q2_0` | `Qwen3.8 Flash Next Q2_0` |

Any model id Strata returns is handled automatically — nothing is hard-coded to the two examples above.

---

## Behavior when Strata is offline

- **Pi itself still starts normally.**
- Cloud providers such as **OpenRouter keep working.**
- `/model` does **not** crash.
- `/strata-status` reports `Status: offline` with the connection error.
- `/strata-refresh` reports a useful error.
- Requests use a short timeout (default **2.5s**), so startup is never blocked for long by an unresponsive Strata.

If a previously successful discovery exists in the current Pi process and Strata goes offline, the last-known list is **retained** (a temporary outage does not wipe the catalogue), but `strata-status` still clearly reports the current offline/online state.

---

## Relationship to `strata-local`

Pi separately defines a static **`strata-local`** provider in `~/.pi/agent/models.json`. This extension does **not** modify, replace, or remove that provider — it registers a **new** provider id (`strata-auto`) that lives alongside it. You may keep both while you validate the dynamic provider, then remove `strata-local` from `models.json` yourself if you prefer.

---

## Limitations (v0.1)

- **Source of truth is `/v1/models`.** Only models Strata currently reports are discoverable. Strata may choose not to expose every GGUF file it has on disk — the extension reflects what the API returns.
- **No disk scanning.** GGUF files are never scanned nor inferred from filenames; `E:\Model` is never touched.
- **Simple defaults.** Per-model Pi metadata (context/output/cost) comes from configurable defaults, not from Strata (which does not expose it).
- **No persistent catalogue.** Discovery is in-memory for the current Pi process. On a fresh process Strata is re-queried at startup.
- **Dummy API key.** The local keyless endpoint uses a dummy `apiKey: "local"` so Pi treats the provider as authenticated.
- This is intentionally a small, focused provider. It does not attempt to manage Strata itself.

---

## Development & tests

Run the unit tests (mock server; no Strata required):

```bash
npm install --legacy-peer-deps   # dev-only: typescript + @types/node for type-checking
npm test
```

Run the live test against a running Strata endpoint:

```bash
npm run test:live   # or:  STRATA_LIVE_TEST=1 node --test tests/strata.test.ts
```

Type-check:

```bash
npm run typecheck
```

Tests cover: module import, registration inputs, parsing the real `/v1/models` response shape, name derivation, invalid responses, connection refused, timeouts, duplicate ids, default and per-model metadata overrides, config merging, and an opt-in real-endpoint check.

> The runtime package itself requires **no** `npm install`; it ships as source TypeScript and runs under Pi's bundled loader with only Pi's host-provided packages.

---

## License

[MIT](./LICENSE)
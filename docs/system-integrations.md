# Integrations

Dashboard sidebar: **System → Integrations**. Which harness config blocks omnilist writes on each run (sync targets).

Config key: `targets.*`. Current defaults in `config.jsonc` have Solo + Router on for opencode, kilo, t3, dsh, pi, opencodex (REST on for t3, dsh, pi, opencodex), everything off for zcode.

## The three block types (per harness)

| Block | Writes | Source models |
|---|---|---|
| **Solo** (`<harness>_solo`) | Solo provider blocks from each `providers.csv` row | Currently wired per harness config; solo/provider scoping follows the same provider model |
| **Router** (`<harness>_router`) | Single gateway block for the `Router` row | Full (filtered or raw-bypassed) catalog |
| **REST** (`<harness>_rest`) | Per-provider `c-*` instances for non-Router rows | That provider's `provider/`-prefixed models, prefix-stripped |

Harnesses: `opencode`, `kilo`, `t3`, `dsh`, `pi`, `zcode`, `opencodex` (GUI label `ocx`). Full keys: `opencode_solo`, `opencode_router`, `opencode_rest`, `kilo_solo`, … `opencodex_rest`, plus `kilo_copy_opencode_full_provider_block` (copy the full OpenCode provider block into Kilo instead of generating separately).

Managed keys are `c-<simplified-provider>[-<N>][-<simplified-adapter>]` where "simplified" = lowercased, `a-z`/`0-9` only. Cleanup prunes `c-*` keys gated by these toggles + `cleanup_providers` (see [General](system-general.md)).

## Harness notes

- **opencode / kilo** — `npm`-style adapters (`@ai-sdk/...`), full hardcoded template when enabled (see [General](system-general.md)).
- **t3** — flat Router list + per-provider instances; drivers under [T3 drivers](system-t3-drivers.md); `[1m]` ids handled there.
- **dsh** — `settings.yaml` + `.credentials.yaml`; APIs via adapters (legacy `router_apis`/`rest_apis` still accepted); `model_inputs` (`hardcode`/`vision`/array) controls the `input` field.
- **pi** — `models.json`, `api: "openai-completions"`, `[1m]` ids excluded.
- **zcode** — `config.json`, `kind: "openai-compatible"`, `builtin:*` entries always preserved.
- **opencodex** — `config.json`, `adapter`/`apiKeyPool` shape, `defaultProvider` set by Router sync only; forces `claudeCode.authMode: "proxy"` with a `~/.claude/settings.json` backup-and-clear warning.

## Dashboard

**Harness sync targets** list — one row per harness with Solo / Router / REST pill toggles (click to flip, `aria-pressed` reflects state). **Options** sub-section — Kilo copy toggle. **Raw JSON Direct Edit** card for the whole `targets` block. **Reset to Defaults** / **Push as Default** per card.

CLI: `omnilist opencode` runs a harness with its configured modes; append `--router` / `--solo` / `--rest` for one mode only. Disabling a toggle (or removing a provider) prunes that harness's `c-*` entries on the next run.

Deep link: `/targets` or `#/targets` (sidebar label "Integrations").

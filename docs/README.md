# Omnilist docs

Full guides for every dashboard tab. The root `README.md` is a quick install + usage guide only — start there, then come here for detail.

## Workspace

- [Run](dashboard-run.md) — run the full pipeline or one target, live console, `-mi`/`-mo`, clean cache / remove models.
- [Models](dashboard-models.md) — browse `models-all.csv` vs `models-filtered.csv`, search, `show_harness_model_list` previews.
- [Providers](dashboard-providers.md) — `providers.csv`, Router vs Solo vs REST, badges, search, raw CSV edit.

## Rules & Pipeline

- [Filters](rules-filters.md) — `model_filters` + `harness_filters`, expression language, `model_sort`, top/bottom-N, raw-catalog harnesses, unified rules workspace.
- [Field overrides](rules-field-overrides.md) — `invalid_value_overrides` vs `always_overrides`, `(field:value)->harness` syntax.
- [Capabilities](rules-capabilities.md) — `capabilities.fields` probing + `n_a_defaults` when the router reports no data.
- [Custom models](rules-custom-models.md) — `custom_models[]`, never filtered out, id-collision wins.

## System

- [General](system-general.md) — `cli`, `fetch.models_endpoint`, `follow_hardcoded_model_template`, `cleanup_default`, `cleanup_providers`.
- [Paths](system-paths.md) — every `paths.*` key, `~`/relative/absolute, env overrides.
- [Integrations](system-integrations.md) — `targets.*` Solo / Router / REST toggles per harness (opencode, kilo, t3, dsh, pi, zcode, ocx).
- [Adapters](system-adapters.md) — per-harness `router_adapters` / `solo_adapters` / `rest_adapters` + per-provider overrides.
- [T3 drivers](system-t3-drivers.md) — `t3.router_drivers`, `solo_provider_drivers`, `rest_provider_drivers`, `driver_strategy`, `[1m]` handling, per-provider overrides.
- [Commands & advanced](system-commands-advanced.md) — `custom_commands` (`sleep`, `bg:`), whole-config raw JSON escape hatch.

Config reference for all of the above: [`config/config.jsonc`](../config/config.jsonc) (every key optional, falls back to defaults). Private machine overrides: [`config/config.local.jsonc`](../config/config.jsonc) shape, gitignored.

## Reference

- [Architecture](architecture.md) — full program flowchart (CLI, setup wizard, fetch/filter pipelines, per-harness sync, GUI server).

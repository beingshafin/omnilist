# Providers

Dashboard sidebar: **Workspace → Providers**. Editor for `providers.csv` (path: `paths.providers_csv`). This is the **one source of truth** for gateways and credentials.

## Provider types

Exactly **one** row must be the Router — the row whose `description` column (whitespace-trimmed, **case-sensitive**) equals `Router`. That row's `base_url` + `api_key` fetch the model catalog (`{base_url}/models` unless `fetch.models_endpoint` is set — see [General](system-general.md)) and become the router provider block in each harness.

- More than one `Router` row → error on the console, first one kept, rest ignored.
- None → fetch/sync targets fail with a clear message.
- Every other row is a Solo/REST provider: its `provider` name selects its models by `provider/` id prefix (`agentrouter/flash` belongs to `agentrouter`), and its `base_url` + `api_key` become Solo/REST blocks per `targets.*` (see [Integrations](system-integrations.md)).

Example:

```csv
provider,base_url,api_key,description
omniroute,http://localhost:20128/v1,sk-0b4b...,Router
agentrouter,https://agentrouter.org,sk-agent...,github-shafin454
fmd,https://cc.freemodel.dev,fe_oa_...,joy11
```

Solo vs REST is not a CSV column — it's which `targets.<harness>_solo` / `<harness>_rest` toggles are on. A disabled provider (toggle in the GUI table) is skipped for Solo/REST sync and, per `cleanup_providers`, its `c-*` keys are pruned.

## Controls

- **Stats bar** — total count plus `Router` / `Solo` / `REST` / `Disabled` badges. There should always be exactly 1 Router badge.
- **Search** — filters on provider name, URL, or notes, with live match count.
- **Refresh** — reload `providers.csv` from disk.
- **Add provider** — append a row (name, base URL, API key, description/notes).
- **Row actions** — edit, enable/disable, delete; per-provider Solo/REST adapter and T3-driver overrides live under [Adapters](system-adapters.md) / [T3 drivers](system-t3-drivers.md).
- **Raw providers.csv → Direct Edit** — modal editor for the whole CSV. Columns: `provider,base_url,api_key,type,description`. API keys are masked in the table view but visible in the raw editor — treat it as secret material.

## After editing

1. **Save** (bottom save bar), then [Run → Fetch](dashboard-run.md) to refresh `models-all.csv` / `models-filtered.csv`.
2. Run everything (or the affected harness buttons) to push new keys. Removing a provider prunes its `c-*` entries per `cleanup_providers` (see [General](system-general.md)).
3. Rotated a credential? Same flow — edit key → save → run. Never edit harness configs directly; omnilist is the only writer.

Deep link: `/providers` or `#/providers`.

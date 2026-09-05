# T3 drivers

Dashboard sidebar: **System → T3 drivers**. Which T3 drivers launch the Router flat list and the per-provider Solo/REST instances, and how each driver authenticates.

Config key: `t3` (`router_drivers`, `solo_provider_drivers`, `rest_provider_drivers`, `driver_strategy`).

## Current defaults

```jsonc
"t3": {
  "router_drivers":        [{ "driver": "claudeAgent", "1m": true }, { "driver": "codex", "1m": false }],
  "solo_provider_drivers": [{ "driver": "claudeAgent", "1m": true }],
  "rest_provider_drivers": [{ "driver": "claudeAgent", "1m": true }],
  "driver_strategy": {
    "claudeAgent": { "mode": "env", "apiKey": "ANTHROPIC_API_KEY", "baseUrl": "ANTHROPIC_BASE_URL" },
    "codex":       { "mode": "launchArgs" }
  }
}
```

- Each driver entry: `{ driver, 1m }`. `1m` controls `[1m]`-suffixed model handling for that driver.
- Common drivers (autocomplete datalist in the GUI): `claudeAgent`, `codex`, `geminiAgent`, `opencode`.
- `driver_strategy` per driver: `mode: "env"` (inject `apiKey`/`baseUrl` env vars) vs `"launchArgs"` (pass on the command line).

## Dashboard

1. **Main table** — one row ("T3 CLI Instances — active launched driver processes"), columns Router / Solo / REST drivers. Editable driver cells with a **reset-to-default** button (visible only when diverged).
2. **Individual providers selector** — `none` / `solo` / `rest` / `both`. Overrides launched drivers or 1M context for specific Solo/REST providers.
3. **Raw JSON Direct Edit** card for the whole `t3` block (drivers + strategy). **Reset to Defaults** / **Push as Default** per card.

Enable/disable the T3 blocks themselves under [Integrations](system-integrations.md) (`t3_solo` / `t3_router` / `t3_rest`); clear T3 logs via [Run → Clean cache](dashboard-run.md).

Deep link: `/t3` or `#/t3`.

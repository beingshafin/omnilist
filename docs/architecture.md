# Architecture

Complete flowchart of omnilist: CLI entry, setup wizard, fetch pipeline, filter pipeline, per-harness sync fan-out, cleanup, custom commands, and the GUI server.

```mermaid
flowchart TD
  ENTRY(["node src/omnilist.js …args<br/>(or omnilist shim)") ] --> PARSE["parseArgs: targets, modes<br/>--router --solo --rest, -mi -mo,<br/>--port, --clean --noclean"]
  PARSE --> CFG["loadConfig: DEFAULTS<br/>overlaid by config.jsonc,<br/>config.local.jsonc, env vars"]
  CFG --> ACT{"action?"}

  ACT -->|"setup / init"| S_BANNER["setup banner"] --> WIZ["ensureRouterProvider wizard<br/>(Router vs Solo, retry loops,<br/>confirm, write providers.csv)"]
  WIZ --> S_INST["installAsCommand"] --> S_GUI["startGuiInBackground"] --> S_DONE["onboarding banner"]
  ACT -->|"gui"| G_ONLY["startGuiInBackground"]
  ACT -->|"start"| ST_GUI["startGuiInBackground"] --> PIPE
  ACT -->|"stop"| DO_STOP["stopGui"]
  ACT -->|"restart"| DO_REST["stopGui + startGuiInBackground"]
  ACT -->|"install"| DO_INST["installAsCommand"]
  ACT -->|"uninstall"| DO_UNINST["uninstallAsCommand"]
  ACT -->|"run / fetch / harness targets"| PIPE

  PIPE["sync pipeline"] --> AUTOI["installAsCommand quiet<br/>(if cli.install_as_command)"]
  AUTOI --> NEEDR{"router target<br/>requested?"}
  NEEDR -->|"fetch, opencode, kilo, t3,<br/>dsh, pi, zcode, opencodex"| WIZ2["ensureRouterProvider<br/>(skip if Router row exists;<br/>skip if Solo rows exist)"]
  NEEDR -->|"rest / cleanup only"| PREV
  WIZ2 --> PREV["cleanupHarnessPreviews<br/>(drop previews disallowed<br/>by show_harness_model_list)"]
  PREV --> LOOP["for target in execution order:<br/>cleanmodels, fetch, opencode,<br/>opencoderest, kilo, kilorest, kilopro,<br/>t3models, t3rest, dsh, dshrest,<br/>pi, pirest, zcode, zcoderest,<br/>opencodex, opencodexrest,<br/>cleanupproviders, cleanup, commands"]

  LOOP --> TGT{"target?"}
  TGT -->|cleanmodels| T_CM["remove managed models<br/>and c-* providers"]
  TGT -->|fetch| FETCH
  TGT -->|"opencode, kilo, t3models,<br/>dsh, pi, zcode, opencodex<br/>(+ rest variants, kilopro)"| SYNC
  TGT -->|cleanupproviders| T_CP["prune stale c-* and legacy<br/>c_ keys, renumber, drop<br/>unreferenced DSH credentials"]
  TGT -->|cleanup| T_CL["delete transient files<br/>(T3 logs dir)"]
  TGT -->|commands| T_CC["run custom_commands in order:<br/>sleep N pauses, bg: detaches,<br/>else sequential; failure<br/>marks exit 1, chain continues"]

  subgraph FETCH ["fetchModels()"]
    direction TB
    F_READ["read providers.csv"] --> F_HASR{"Router row?"}
    F_HASR -->|yes| F_GET["GET base_url/models<br/>(or fetch.models_endpoint),<br/>Bearer api_key"]
    F_GET --> F_DEDUP["dedupe: drop parent != null<br/>aliases and duplicate ids"]
    F_DEDUP --> F_CAP["capability detect per model:<br/>vision, reasoning, tool → 1 / 0 / -1"]
    F_HASR -->|no| F_SKIP["skip router catalog"]
    F_CAP --> F_MERGE1["mergeCustomModels<br/>(custom wins on id collision)"]
    F_SKIP --> F_MERGE1
    F_MERGE1 --> F_ALL["write models-all.csv<br/>(id-sorted, pre-filter)"]
    F_ALL --> F_FILT["applyModelFilters:<br/>model_filters, last-match-wins"]
    F_FILT --> F_MERGE2["mergeCustomModels again<br/>(custom is never filtered)"]
    F_MERGE2 --> F_TOPN["applyTopNDirective +<br/>sortModels(model_sort)"]
    F_TOPN --> F_WF["write models-filtered.csv"]
    F_WF --> F_SOLO["for each Solo row:<br/>fetchSoloModels →<br/>models-all-solo.csv +<br/>models-filtered-solo.csv"]
  end

  subgraph SYNC ["per-harness sync — opencode, kilo, t3, dsh, pi, zcode, opencodex"]
    direction TB
    H_SRC["pick source: models-filtered.csv,<br/>or models-all.csv when harness<br/>is in raw_catalog_harnesses"] --> H_HF["apply harness_filters<br/>for this harness<br/>(bare rules + ->harness rules)"]
    H_HF --> H_TOPN["apply per-harness<br/>top-N directive"]
    H_TOPN --> H_OVR["apply invalid_value_overrides<br/>then always_overrides"]
    H_OVR --> H_MM["apply -mi / -mo<br/>min-context flags"]
    H_MM --> H_SOLO{"targets solo on?"}
    H_SOLO -->|yes| H_WS["write Solo blocks<br/>from solo CSVs"]
    H_SOLO -->|no| H_ROUTER
    H_WS --> H_ROUTER{"targets router on?"}
    H_ROUTER -->|yes| H_WR["write Router gateway block<br/>(full catalog)"]
    H_ROUTER -->|no| H_REST
    H_WR --> H_REST{"targets rest on?"}
    H_REST -->|yes| H_WX["write per-provider REST c-* blocks<br/>(provider prefix, ids stripped)"]
    H_REST -->|no| H_PREV
    H_WX --> H_PREV["write models-harness.csv preview<br/>(per show_harness_model_list)"]
  end

  subgraph GUI ["GUI server — src/gui.js + src/dashboard.html"]
    direction TB
    G_SRV["http server on 127.0.0.1:PORT<br/>(localhost only, zero deps)"] --> G_TABS["dashboard tabs: Run, Models, Providers<br/>+ config sections: General, Paths,<br/>Integrations, Adapters, T3 drivers,<br/>Filters, Overrides, Capabilities,<br/>Custom models, Commands"]
    G_SRV --> G_API["REST API: /api/config,<br/>/api/models, /api/providers,<br/>/api/preview-filters, /api/browse,<br/>/api/validate, /api/meta,<br/>/api/run, /api/run/stream,<br/>/api/run/stop, /api/shutdown,<br/>/api/restart, /api/ping"]
    G_API --> G_CHILD["Run tab spawns<br/>node omnilist.js child,<br/>streams console output"]
    G_API --> G_SAVE["saves → config.local.jsonc<br/>(or config.jsonc) + .bak;<br/>Push-as-Default → default.jsonc"]
  end

  G_ONLY -.-> GUI
  ST_GUI -.-> GUI
  S_GUI -.-> GUI
```

## How to read it

1. **Entry** — every invocation parses args, layers config (`DEFAULTS` ← `config.jsonc` ← `config.local.jsonc` ← env like `OMNILIST_CONFIG`, `MODELS_TEST`, `T3_DATA_DIR`), then dispatches on `action`.
2. **Setup** (`setup` / `init`) — the interactive wizard (`ensureRouterProvider`) creates the first `providers.csv` row, then installs the global command and launches the dashboard. The same wizard runs automatically inside the pipeline whenever a router target is requested but no Router (and no Solo) row exists.
3. **Fetch** — Router catalog first (`models-all.csv` raw, then `model_filters` → `models-filtered.csv`), then one independent fetch per Solo row. `custom_models` are merged twice so they survive every filter and win id collisions.
4. **Sync fan-out** — each of the 7 harnesses reads filtered (or raw on bypass), then applies, in order: `harness_filters` → top-N → field overrides → `-mi`/`-mo` → Solo / Router / REST block writes gated by `targets.*` → preview CSV.
5. **Tail** — `cleanupproviders` reconciles managed `c-*` keys (legacy `c_*` always stale), `cleanup` deletes transient files, `commands` runs the post-sync chain.
6. **GUI** — a localhost-only server around the same engine: the dashboard edits config through the REST API, and Run re-enters the whole pipeline as a child process (which is why runs use the config on disk — save first).

## Per-harness output shapes

| Harness | Config file | Key shape | Connection field |
|---|---|---|---|
| opencode | `opencode.jsonc` | `c-provider[-N][-adapter]` | `npm` (`@ai-sdk/...`) |
| kilo | `kilo.jsonc` | `c-provider[-N][-adapter]` | `npm` (`@ai-sdk/...`) |
| t3 | T3 userdata | flat list + per-provider instances | drivers (`claudeAgent`, `codex`, …) |
| dsh | `settings.yaml` + `.credentials.yaml` | `c-provider[-N][-api]` | `api` (`openai-completions`, …) |
| pi | `models.json` | `c-provider[-N]` | `api` |
| zcode | `config.json` | `c-provider[-N]` | `kind` |
| opencodex | `config.json` | `c-provider[-N]` | `adapter` |

Detail per tab: [docs index](README.md). Config reference: [`config/config.jsonc`](../config/config.jsonc).

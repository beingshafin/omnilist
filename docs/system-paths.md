# Paths

Dashboard sidebar: **System → Paths**. Where catalog files and each harness config live.

Config key: `paths.*`. Paths may be absolute, relative (to the project root), or use `~` for the home directory.

## Keys

| Key | Default | What it is |
|---|---|---|
| `models_csv` | `models-filtered.csv` (repo `data/`) | Filtered catalog — the sync source (see [Models](../docs/dashboard-models.md)). Env `MODELS_TEST` overrides. |
| `providers_csv` | `providers.csv` (repo `data/`) | Router + provider credentials (see [Providers](dashboard-providers.md)). |
| `all_models_csv` | `models-all.csv` | Raw dedup'd catalog, pre-filter. Empty = `<models dir>/models-all.csv`. |
| `harness_models_file` | `models-<harness>.csv` | Per-harness preview template (`<harness>` → `t3`, `dsh`, …). |
| `opencode_file` | `~/.config/opencode/opencode.jsonc` | OpenCode config. Env `JSONC_TEST` overrides. |
| `kilo_file` | `~/.config/kilo/kilo.jsonc` | Kilo config. Env `KILO_TEST` overrides. |
| `t3_data_dir` | `~/.t3/userdata` | T3 userdata dir. Env `T3_DATA_DIR` overrides. |
| `t3_settings_file` | `""` → `<t3_data_dir>/settings.json` | T3 settings override. |
| `t3_logs_dir` | `""` → `<t3_data_dir>/logs` | T3 logs (cleared by `cleanup`). |
| `dsh_settings_file` | `~/.dsh/settings.yaml` | DSH settings. Env `DSH_SETTINGS_FILE` overrides. |
| `dsh_credentials_file` | `~/.dsh/.credentials.yaml` | DSH credentials (`C_*_API_KEY`). Env `DSH_CREDENTIALS_FILE` overrides. |
| `pi_file` | `~/.pi/agent/models.json` | pi agent catalog. Env `PI_FILE` overrides. |
| `zcode_file` | `~/.zcode/v2/config.json` | zcode catalog. Env `ZCODE_FILE` overrides. |
| `opencodex_file` | `~/.opencodex/config.json` | opencodex catalog. Env `OPENCODEX_FILE` / `OCX_FILE` overrides. |

Whole-config override: `OMNILIST_CONFIG` env points at a different config file entirely.

> `config/config.jsonc` is committed — don't put machine-specific paths or secrets there. Put them in gitignored `config/config.local.jsonc` instead:
>
> ```jsonc
> { "paths": { "opencode_file": "D:/personal/opencode.jsonc" } }
> ```

## Dashboard

One path row per key with a built-in file browser, per-card **Reset to Defaults** / **Push as Default**, and a **raw JSON Direct Edit** card for the whole `paths` block.

Deep link: `/paths` or `#/paths`.

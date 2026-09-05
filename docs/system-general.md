# General

Dashboard sidebar: **System → General**. Command registration, model endpoint, template behavior, and cleanup toggles.

## Fields

| GUI field | Config key | Meaning |
|---|---|---|
| Install as command | `cli.install_as_command` | Auto-register the global command on every run. |
| Command name | `cli.command_name` | Global command name (default `omnilist`). Used in usage text and the `omnilist.cmd` shim. |
| Models endpoint | `fetch.models_endpoint` | Full URL for the model list. Leave empty to use `{base_url}/models` from the Router row in `providers.csv`. |
| Hardcoded model template | `follow_hardcoded_model_template` | Emit the full hardcoded model template into OpenCode/Kilo blocks — all capability flags `true`, plus `modalities` and `variants`; only context/output limits come from `models-filtered.csv`. Default `true`. |
| Cleanup by default | `cleanup_default` | Default for the cleanup step. CLI `--clean` / `--noclean` overrides per run. |
| Remove if provider disabled | `cleanup_providers.remove_if_false_provider` | Prune `c-*` keys whose provider is disabled in `providers.csv`. |
| Remove if provider missing | `cleanup_providers.remove_if_provider_doesnt_exist` | Prune `c-*` keys whose provider no longer exists. |

Legacy `c_…` keys are always treated as stale and removed by `cleanupproviders`.

## Config layers

`config/config.jsonc` (committed) ← overridden by `config/config.local.jsonc` (gitignored, same shape) ← overridden by env vars. Every key is optional; `{}` works. Each GUI save writes only changed keys to `config.local.jsonc` if it exists, else to `config.jsonc` (preserving header/comments), with a one-generation `.bak` backup next to the target.

## Dashboard

Toggles/text fields per row above, per-card **Reset to Defaults** / **Push as Default** (writes `config/default.jsonc` baseline), and a **raw JSON Direct Edit** card for the whole general block.

Deep link: `/general` or `#/general` (default landing section).

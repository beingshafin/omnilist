# Run

Dashboard sidebar: **Workspace → Run**. One page that executes the sync pipeline in a fresh `node src/omnilist.js` process and streams output into an in-page console.

> Runs use the config **on disk**. Save your changes first (save bar at the bottom) — unsaved edits are not picked up.

## What it does

Same as the CLI: fetch the Router catalog → write `models-filtered.csv` / `models-all.csv` → sync every enabled `targets.*` block → `cleanupproviders` → `cleanup` → `commands`. See [Integrations](system-integrations.md) for which blocks are enabled.

## Controls

| Control | Action |
|---|---|
| **Run everything** | Full pipeline (`fetch` → all enabled harness targets → cleanup → commands). Same as bare `omnilist` / `omnilist run` / `omnilist all`. |
| **Fetch** | Refresh `models-filtered.csv` + `models-all.csv` only. Same as `omnilist fetch`. |
| **OpenCode / Kilo / T3 / DSH / pi / zcode / ocx** | Sync one harness using its configured Solo + Router + REST modes. Same as `omnilist opencode`, `omnilist kilo`, etc. |
| **Clean cache** | Delete transient files (e.g. T3 logs dir). Same as `omnilist cleanup`. Title tooltip in the GUI confirms this. |
| **Remove models** (danger) | Remove all script-added models and `c-*` providers across all harness configs. Same as `omnilist cleanmodels` / `removemodels`. |
| **Custom commands** | Run `custom_commands` sequentially. Same as `omnilist commands`. See [Commands & advanced](system-commands-advanced.md). |
| **Min input / Min output** | `-mi` / `-mo` filters for this run only. Skip models with `input_context < N` / `output_context < N`. `0` = none. Same as `omnilist -mi 200000 -mo 8192`. Overrides run **after** [field overrides](rules-field-overrides.md), so a repaired model still passes. |
| **Stop** (danger) | Kill the running child process. Enabled only while a run is active. |
| **Console + status line** | Live `role=log` output of the child process plus a `role=status` summary line. |

## CLI equivalents

```powershell
omnilist                 # = Run everything
omnilist run             # same, explicit
omnilist fetch           # = Fetch
omnilist opencode        # = OpenCode button (kilo, t3, dsh, pi, zcode, ocx likewise)
omnilist fetch opencode  # combine: fetch then sync one harness
omnilist cleanup         # = Clean cache
omnilist cleanmodels     # = Remove models
omnilist commands        # = Custom commands
omnilist -mi 200000 -mo 8192   # = Min input / Min output fields
omnilist opencode --router     # router block only
omnilist opencode --solo       # solo blocks only
omnilist opencode --rest       # REST blocks only
```

Target mode flags (`--router` / `--solo` / `--rest`) have no GUI equivalent — use the CLI when you need one mode only. With no mode flag, the harness runs all modes enabled in `targets.*`.

## Tips

- Deep link: `/run` or `#/run`.
- If models don't show up in a tool, re-run that harness button explicitly, then check [Models](dashboard-models.md) previews and [Filters](rules-filters.md).
- Cleanup behavior honors `cleanup_default` (CLI `--clean` / `--noclean`); see [General](system-general.md).

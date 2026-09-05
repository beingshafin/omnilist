# Omnilist

One command to fetch your **Router**'s model catalog and keep every AI coding tool's config in sync.

A "Router" is any gateway that fronts multiple model providers behind a single OpenAI-compatible endpoint — e.g. [OmniRoute](https://www.imshafin.tech/blog/omniroute-setup), 9router, agentrouter, or your own. You keep one `providers.csv`, omnilist fetches the model catalog once and pushes it into OpenCode, Kilo, T3, DSH, pi agent, zcode, and opencodex for you.

## Requirements

- **Node.js** 16+ (any recent LTS)
- **A Router gateway** running and reachable (the one `providers.csv` row whose `description` is exactly `Router`)
- **Windows** for the auto-install command feature (the sync logic itself is cross-platform)

## Installation

Clone to a permanent location (the folder gets added to your PATH — don't move it later without reinstalling):

```powershell
git clone https://github.com/beingshafin/omnilist.git
cd omnilist
.\setup.cmd
```

Or with Node directly:

```powershell
node src/omnilist.js setup
```

First run prompts for your **Router** gateway (or a Solo provider), writes `data/providers.csv`, installs the global `omnilist` command, boots the dashboard, and offers to run the first sync. Reinstall the command anytime with `node src/omnilist.js install`, then `omnilist help`.

## Usage

```powershell
omnilist                 # fetch catalog + sync all enabled targets + cleanup
omnilist fetch           # refresh models-filtered.csv / models-all.csv only
omnilist opencode        # sync one harness (kilo, t3, dsh, pi, zcode, ocx likewise)
omnilist fetch t3        # combine targets
omnilist -mi 200000      # this run only: skip models with input context < 200k
omnilist gui             # dashboard on port 55555 (auto-increments if busy)
omnilist gui 8080        # or pick a port: bare number, --port N, or -p N
```

Harness mode flags: `omnilist opencode --router` / `--solo` / `--rest` sync one block type only (no flag = all modes enabled in config).

## Dashboard

`omnilist gui` serves `src/gui.js` + `src/dashboard.html` (zero dependencies, localhost only) and prints a clickable `http://127.0.0.1:55555` link. Full guides live in [`docs/`](docs/README.md):

| Tab | Guide |
|---|---|
| Workspace → Run | [docs/dashboard-run.md](docs/dashboard-run.md) |
| Workspace → Models | [docs/dashboard-models.md](docs/dashboard-models.md) |
| Workspace → Providers | [docs/dashboard-providers.md](docs/dashboard-providers.md) |
| Rules & Pipeline → Filters | [docs/rules-filters.md](docs/rules-filters.md) |
| Rules & Pipeline → Field overrides | [docs/rules-field-overrides.md](docs/rules-field-overrides.md) |
| Rules & Pipeline → Capabilities | [docs/rules-capabilities.md](docs/rules-capabilities.md) |
| Rules & Pipeline → Custom models | [docs/rules-custom-models.md](docs/rules-custom-models.md) |
| System → General | [docs/system-general.md](docs/system-general.md) |
| System → Paths | [docs/system-paths.md](docs/system-paths.md) |
| System → Integrations | [docs/system-integrations.md](docs/system-integrations.md) |
| System → Adapters | [docs/system-adapters.md](docs/system-adapters.md) |
| System → T3 drivers | [docs/system-t3-drivers.md](docs/system-t3-drivers.md) |
| System → Commands & advanced | [docs/system-commands-advanced.md](docs/system-commands-advanced.md) |

Config reference: [`config/config.jsonc`](config/config.jsonc) (every key optional; private overrides in gitignored `config/config.local.jsonc`).

## Troubleshooting

| Problem | Fix |
|---|---|
| Command not found in a new terminal | Reopen the terminal, or run `omnilist install` again |
| "No provider with description Router found" | Add a `providers.csv` row whose `description` is exactly `Router` |
| Fetch fails | Confirm the Router gateway is reachable and `base_url`/`api_key` are correct |
| Models missing in a tool | Run that target explicitly, e.g. `omnilist t3rest`, then check the Models tab |

## Uninstall

```powershell
omnilist uninstall
```

Removes the global command and PATH entry. Config files and local data are left untouched.

## Running the tests

```powershell
node --test test/omnilist.test.js
# or
npm test
```

Zero-dependency suite with an in-process mock router; no network needed.

## License

MIT

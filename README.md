# Omnilist

One command to fetch your OmniRoute model catalog and keep every AI coding tool's config in sync.

[OmniRoute](https://www.imshafin.tech/blog/omniroute-setup/windows-autostart) gives you a single local gateway for every model provider you use. The problem is that OpenCode, Kilo, and T3 each store their model list in their own config files, in their own format. Add or rotate a provider, and you end up pasting the same information into three places.

Omnilex fixes that. You keep one list of providers and one fetched model catalog, and it pushes everything into every tool for you.

## Why use it

- **One source of truth**: your OmniRoute gateway + `providers.csv`
- **No copy-paste fatigue**: model lists, context limits, and API keys are written to OpenCode, Kilo, and T3 automatically
- **Stays clean**: filter out models you don't want once, and every tool gets the same trimmed list
- **Self-installing**: registers as a global `omnilist` command on Windows

## Requirements

- **Node.js** (any recent LTS — 16+ is fine)
- **OmniRoute gateway** running locally (default `http://localhost:20128`) — see the [setup guide](https://www.imshafin.tech/blog/omniroute-setup)
- **Windows** for the auto-install command feature (the sync logic itself is cross-platform)

## Installation

Clone or copy the repo to a permanent location. The folder gets added to your PATH, so don't move it later without reinstalling.

```powershell
git clone https://github.com/beingshafin/omnilist.git
cd omnilist
node omnilist.js
```

On the first run it will ask for your VSCode-compatible models endpoint URL or API key. Paste either:

- A full URL: `http://localhost:20128/api/v1/vscode/<key>/models`
- Or just the bare key/token

It saves it to `providers.csv` so you're only prompted once. To force a new prompt later, pass `--new`.

Then install the global command:

```powershell
node omnilist.js install
```

After that, `omnilist` works from any terminal:

```powershell
omnilist help
```

## How to use it

### Run everything

```powershell
omnilist
```

No arguments runs the full pipeline: fetch the catalog, sync every enabled target, clean up stale entries, and clear transient T3 logs.

### Run a specific step

```powershell
omnilist fetch           # Refresh models.csv only
omnilist opencode        # Sync OmniRoute models into OpenCode
omnilist kilo            # Sync OmniRoute models into Kilo
omnilist t3              # Sync OmniRoute models into T3
omnilist t3providers     # Sync per-provider instances into T3
omnilist all             # Same as running with no arguments
```

You can combine targets:

```powershell
omnilist fetch t3 t3providers
```

### Filter the model list

```powershell
omnilist -mi 200000              # Only models with 200k+ input context (default floor)
omnilist --min-output-limit 8192 # Only models with 8k+ output limit
omnilist -mi 0                   # No input filter — show everything
```

## When to use it

- **Right after setting up OmniRoute** — populate OpenCode, Kilo, and T3 in one shot
- **After editing `providers.csv`** — add a key, remove a provider, or rotate a credential
- **When new models appear** — rerun to pull the fresh catalog and push it everywhere
- **On a new machine** — clone, fill in `providers.csv`, run `omnilist`
- **Whenever your model pickers feel out of sync** — one run reconciles everything

## What it does, briefly

1. Calls your OmniRoute gateway to fetch the live model catalog
2. Filters models by your rules and writes `models.csv`
3. Syncs the catalog into OpenCode, Kilo, and T3 in their native formats
4. Cleans up stale provider entries and temporary T3 logs

You never edit the tool config files directly. `omnilist` is the only thing that writes to them.

## Files you'll see

| File | What it is |
|---|---|
| `omnilist.js` | The script itself — zero dependencies |
| `omnilist.cmd` | Generated Windows shim |
| `providers.csv` | Your provider base URLs + API keys |
| `models.csv` | Auto-generated model catalog |

`providers.csv` and `models.csv` are gitignored. Treat them as local config/output.

## Companion guide

For the full OmniRoute setup on Windows — gateway install, autostart, everything — see:

👉 **[OmniRoute setup on Windows with autostart](https://www.imshafin.tech/blog/omniroute-setup/windows-autostart)**

Omnilex assumes the gateway is already running. That guide covers the rest.

## Troubleshooting

| Problem | Fix |
|---|---|
| Command not found in a new terminal | Close and reopen the terminal, or run `omnilist install` again |
| Prompt keeps asking for the endpoint/key | The key is stored in `providers.csv`. If that file is missing, run `omnilist --new` |
| Models not showing up in a tool | Run with that tool's target explicitly, e.g. `omnilist t3providers` |
| Config file errors | Check the file for trailing commas or manual edits; the script parses and rewrites these files |
| OmniRoute unreachable | Confirm the gateway is running at `http://localhost:20128` |

## Uninstall

```powershell
omnilist uninstall
```

Removes the global command and PATH entry. Your config files and local data are left untouched.

## License

MIT

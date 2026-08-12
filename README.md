# Omnilist

One command to fetch your **Router**'s model catalog and keep every AI coding tool's config in sync.

A "Router" is any gateway that fronts multiple model providers behind a single OpenAI-compatible endpoint — e.g. [OmniRoute](https://www.imshafin.tech/blog/omniroute-setup), 9router, agentrouter, or your own. The problem is that OpenCode, Kilo, and T3 each store their model list in their own config files, in their own format. Add or rotate a provider, and you end up pasting the same information into three places.

Omnilist fixes that. You keep one list of providers and one fetched model catalog, and it pushes everything into every tool for you.

## Why use it

- **One source of truth**: your Router gateway + `providers.csv`
- **No copy-paste fatigue**: model lists, context limits, capabilities, and API keys are written to OpenCode, Kilo, and T3 automatically
- **Stays clean**: filter out models you don't want once, and every tool gets the same trimmed list
- **Router-agnostic**: any provider whose `description` is `Router` becomes the special gateway — OmniRoute, 9router, etc.
- **Self-installing**: registers as a global `omnilist` command on Windows

## Requirements

- **Node.js** (any recent LTS — 16+ is fine)
- **A Router gateway** running and reachable (the special provider in `providers.csv`)
- **Windows** for the auto-install command feature (the sync logic itself is cross-platform)

## The special "Router" provider

The script treats exactly **one** provider in `providers.csv` as the Router — the row whose `description` column (whitespace-trimmed, case-sensitive) equals `Router`. That row's `base_url` + `api_key` are used to fetch the model catalog, and it becomes the router provider block in each tool's config.

- If **more than one** row has `description` = `Router`, the script prints an error on the console, keeps the **first** one, and ignores the rest.
- If **none** do, fetch/sync targets fail with a clear message.

Example `providers.csv`:

```csv
provider,base_url,api_key,description
omniroute,http://localhost:20128/v1,sk-0b4b...,Router
agentrouter,https://agentrouter.org,sk-agent...,github-shafin454
fmd,https://cc.freemodel.dev,fe_oa_...,joy11
```

## Installation

Clone or copy the repo to a permanent location. The folder gets added to your PATH, so don't move it later without reinstalling.

```powershell
git clone https://github.com/beingshafin/omnilist.git
cd omnilist
node omnilist.js
```

On the first run it fetches your Router's model catalog from `{base_url}/models` (or a full `models_endpoint` from `config.jsonc`, see below). No interactive prompt — the Router's URL and key come straight from `providers.csv`.

Then install the global command:

```powershell
node omnilist.js install
```

After that, `omnilist` works from any terminal:

```powershell
omnilist help
```

## Configuration

All behavior is configured in **`config.jsonc`** (next to the script). It ships with safe defaults and is heavily commented (JSONC, so comments are allowed) — **just edit it directly**, no copy step needed.

Every key is optional — the script falls back to sensible defaults for anything missing, so an empty `config.jsonc` (`{}`) works too. The full schema is documented inline in `config.jsonc`. Highlights:

| Section | Controls |
|---|---|
| `paths` | Where `models.csv`, `providers.csv`, `opencode.jsonc`, `kilo.jsonc`, and T3's data live |
| `fetch.models_endpoint` | Full URL to the model list. Leave `""` to use `{base_url}/models` |
| `capabilities.fields` | Which fields the router's model objects use to report `vision` / `reasoning` / `tool` |
| `capabilities.n_a_defaults` | What sync steps emit when a router doesn't report a capability (default `true`) |
| `follow_hardcoded_model_template` | Emit the full hardcoded model template into OpenCode/Kilo — all capability flags `true`, plus `modalities` and `variants`; only context/output limits come from `models.csv` (default `true`) |
| `model_filters` | Model allow/block rules (see below) |
| `targets` | Which tools/blocks to sync (`opencode_router`, `t3_rest`, …) |
| `t3` | T3 drivers, per-driver strategy, and `[1m]` handling |

Paths may be absolute, relative (to the script dir), or use `~` for your home directory. The environment variables `MODELS_TEST`, `JSONC_TEST`, `KILO_TEST`, `T3_DATA_DIR`, and `OMNILIST_CONFIG` still override paths / the config location.

**`config.jsonc` is committed to the repo**, so don't put machine-specific or personal values in it. If you want personal overrides that stay off GitHub, create **`config.local.jsonc`** (gitignored) next to it with the same shape — its values override `config.jsonc`. Example:

```jsonc
// config.local.jsonc — private overrides, gitignored
{
  "paths": { "opencode_file": "D:/personal/opencode.jsonc" }
}
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
omnilist opencode        # Sync Router models into OpenCode
omnilist kilo            # Sync Router models into Kilo
omnilist t3              # Sync Router models into T3
omnilist t3providers     # Sync per-provider instances into T3
omnilist all             # Same as running with no arguments
```

You can combine targets:

```powershell
omnilist fetch t3 t3providers
```

### Filter the model list

```powershell
omnilist -mi 200000              # Only models with 200k+ input context
omnilist --min-output-limit 8192 # Only models with 8k+ output limit
omnilist -mi 0                   # No input filter — show everything
```

Filter rules live in `config.jsonc` under `model_filters` (last matching rule wins). Each entry is one statement in a small C-like expression language:

```
[prefix] <expression>
```

The **prefix** sets the action to take when the expression is true:

| Prefix | Meaning | Example |
|---|---|---|
| *(none)* or `=` | include models that match | `*free`, `=$vision == 1` |
| `!` | exclude models that match | `!kc/*`, `!$input_context < 200000` |
| `==` | keep **only** models that match, drop the rest | `==*free`, `==$input_context >= 200000` |

An **expression** is a boolean formula over the model:

- **Id patterns** match `model.id`. A bare id is an **exact** match; `*` matches any run of characters and `?` matches one:
  - `foo` exact · `foo*` prefix · `*foo` suffix · `*foo*` contains
  - `/`, `:`, `-`, `.` are literal, so `kc/*`, `north-mini-code:free` keep working.
- **`$field`** reads a model property. A bare `$field` is truthy (`value != 0`); add a relational operator and a value to compare:
  - fields: `$id` · `$in`/`$input_context` · `$out`/`$output_context` · `$vision` · `$reasoning` · `$tool`
  - operators: `==` `!=` `<=` `>=` `<` `>` — values are numbers, `true`/`false` (= 1/0), or strings.
- **Boolean operators**: `&&` (and), `||` (or), `!` (not), and parentheses for grouping. Precedence, loosest → tightest: `||` → `&&` → `!` → relational (`==` `!=` `<=` `>=` `<` `>`). A logical `!` wraps the whole comparison after it — `!$vision == 1` means "not (`$vision == 1`)", no parens needed. A `!` at the *start of a rule* is the block prefix (it applies to the entire expression), not a logical not.

```jsonc
"model_filters": [
  "!kc/*",                            // block everything under kc/
  "!(!*kc*)",                         // block ids that DON'T contain "kc"
  "!(kc* && !*free)",                 // block kc ids that don't end in "free"
  "==*free",                          // keep ONLY free models
  "==$input_context >= 200000",       // keep ONLY 200k+ context models
  "!$vision == 1 && $tool == 1"       // block models that are vision AND tool
]
```

> **Note**: a bare id is an **exact** match, not a substring. To block every id *containing* a keyword, wrap it in `*…*` — `!no-think` only blocks the exact id `no-think`, while `!*no-think*` blocks every id that contains `no-think`.

Rules run top-down and the **last matching rule wins** — a later rule overrides earlier ones for the same model, so put the rule you want to win the *last*.

## When to use it

- **Right after setting up a Router** — populate OpenCode, Kilo, and T3 in one shot
- **After editing `providers.csv`** — add a key, remove a provider, or rotate a credential
- **When new models appear** — rerun to pull the fresh catalog and push it everywhere
- **On a new machine** — clone, fill in `providers.csv`, run `omnilist`
- **Whenever your model pickers feel out of sync** — one run reconciles everything

## What it does, briefly

1. Calls your Router's `{base_url}/models` endpoint (Bearer key) to fetch the live model catalog
2. Deduplicates aliases: a model whose `parent` is non-null is an alias of its canonical `parent: null` entry, so only the canonical one is kept
3. Writes `models.csv` with context limits and per-model capabilities (`vision`, `reasoning`, `tool`)
4. Filters models by your rules and syncs the catalog into OpenCode, Kilo, and T3 in their native formats
5. Cleans up stale provider entries and temporary T3 logs

You never edit the tool config files directly. `omnilist` is the only thing that writes to them.

## Files you'll see

| File | What it is |
|---|---|
| `omnilist.js` | The script itself — zero dependencies |
| `config.jsonc` | Shipped config — safe defaults + full comments; edit directly (committed) |
| `config.local.jsonc` | Your private overrides (gitignored; optional) |
| `omnilist.cmd` | Generated Windows shim |
| `providers.csv` | Your provider base URLs + API keys |
| `models.csv` | Auto-generated model catalog |

`config.local.jsonc`, `providers.csv`, and `models.csv` are gitignored — treat them as local config/output. `config.jsonc` is tracked, so keep it free of personal values.

## Troubleshooting

| Problem | Fix |
|---|---|
| Command not found in a new terminal | Close and reopen the terminal, or run `omnilist install` again |
| "No provider with description Router found" | Add a row to `providers.csv` whose `description` is exactly `Router` |
| "Multiple providers have description Router" | The script keeps the first and ignores the rest — delete the extra `Router` rows to silence it |
| Model list missing capabilities | Your router doesn't report them, so they're stored as `-1`; edit `capabilities.n_a_defaults` in `config.jsonc` |
| Fetch fails | Confirm the Router gateway is reachable and `base_url`/`api_key` in `providers.csv` are correct |
| Models not showing up in a tool | Run with that tool's target explicitly, e.g. `omnilist t3providers` |
| Config file errors | Check the file for trailing commas or manual edits; the script parses and rewrites these files |

## Uninstall

```powershell
omnilist uninstall
```

Removes the global command and PATH entry. Your config files and local data are left untouched.

## Running the tests

The repo ships a zero-dependency test suite (`test/omnilist.test.js`) that spins up a mock OpenAI-compatible router and verifies the whole pipeline — fetch → `models.csv` capability columns, the `custom_<routerName>` blocks in OpenCode/Kilo, T3 router + REST instances, multi-Router handling, and stale-entry cleanup.

```powershell
node --test test/omnilist.test.js
# or
npm test
```

No network access is needed; the mock router runs in-process.

## License

MIT

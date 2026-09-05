# Filters

Dashboard sidebar: **Rules & Pipeline → Filters**. Unified pipeline: first-stage `model_filters` (fetch time) → `model_sort` → second-stage `harness_filters` (sync time), with `raw_catalog_harnesses` bypass and top/bottom-N truncation.

Config keys: `model_filters`, `harness_filters`, `model_sort`, `raw_catalog_harnesses`, `show_harness_model_list`. All documented in [`config/config.jsonc`](../config/config.jsonc).

## Pipeline order

1. Fetch Router catalog → dedup aliases (`parent != null` dropped) → `models-all.csv` (id-sorted, always).
2. Apply `model_filters` (+ `custom_models`, never dropped) → sort by `model_sort` → `models-filtered.csv`.
3. Per harness: start from `models-filtered.csv` — unless the harness is in `raw_catalog_harnesses`, then start from `models-all.csv` (raw leakage, no live fetch needed) — apply that harness's `harness_filters` (+ top-N) → field overrides → `-mi`/`-mo` → harness config. Optionally write `models-<harness>.csv` per `show_harness_model_list`.

## Expression language (both filter lists)

One statement per entry: `[prefix] <expression>`. Last matching rule wins — put the rule you want to win **last**.

| Prefix | Meaning | Example |
|---|---|---|
| *(none)* or `=` | include models that match | `*free`, `=$vision == 1` |
| `!` | exclude models that match | `!kc/*`, `!$input_context < 200000` |
| `==` | keep **only** models that match, drop the rest | `==*free`, `==$input_context >= 200000` |

- **Id patterns** match `model.id`. Bare id = **exact** match, not substring. `*` = any run, `?` = one char: `foo` exact · `foo*` prefix · `*foo` suffix · `*foo*` contains. `/`, `:`, `-`, `.` are literal (`kc/*` works). To block ids *containing* a keyword, wrap it: `!*no-think*` (not `!no-think`).
- **`$field`**: `$id` · `$in`/`$input_context` · `$out`/`$output_context` · `$vision` · `$reasoning` · `$tool`. Bare `$field` = truthy (`!= 0`); or compare with `==` `!=` `<=` `>=` `<` `>`. Values: numbers, `true`/`false` (= 1/0), strings.
- **Boolean**: `&&`, `||`, `!`, parentheses. Precedence loosest→tightest: `||` → `&&` → `!` → relational. A logical `!` wraps the whole comparison after it: `!$vision == 1` = "not (`$vision == 1`)". A `!` at the *start of a rule* is the block prefix, not a logical not.

```jsonc
"model_filters": [
  "!kc/*",                       // block everything under kc/
  "!(!*kc*)",                    // block ids that DON'T contain "kc"
  "!(kc* && !*free)",            // block kc ids that don't end in "free"
  "==*free",                     // keep ONLY free models
  "==$input_context >= 200000",  // keep ONLY 200k+ context models
  "!$vision == 1 && $tool == 1"  // block models that are vision AND tool
]
```

## Harness targeting (`harness_filters`)

Same language, plus a `->h1,h2` suffix. Bare rule (no suffix) applies to all harnesses.

```jsonc
"harness_filters": [
  "!agy/*",                     // all harnesses
  "!(kc/* && !*free)->t3,dsh",  // only t3 and dsh
  "!*no-think->deepseek",       // only dsh (alias)
]
"raw_catalog_harnesses": ["dsh"]  // dsh reads models-all.csv, bypassing models-filtered.csv
```

Harness ids (case-insensitive, aliases accepted): `opencode` (`oc`, `open code`, `open-code`, `open_code`, `opc`), `kilo` (`kc`, `kilo code`, `kilocode`, `kilo-code`, `kilo_code`), `t3` (`t3code`, `t3-code`, `t3_code`, `t3 code`), `dsh` (`ds`, `deepseek`, `deepseek_harness`, `deepseek harness`, `deepseek-harness`), `pi` (`pi`, `pi-agent`, `pi_agent`, `pi agent`, `piagent`), `zcode` (`zcode`, `z-code`, `z_code`, `z code`, `zc`), `ocx` (`ox`, `opencodex`, `open codex`, `open-codex`, `open_codex`).

## Sorting + top/bottom-N

`model_sort` orders `models-filtered.csv`, every preview, and every harness block. Comma-separated CSV column names (`id`, `input_context`, `output_context`, `vision`, `reasoning`, `tool`), leading `-` = descending, ties break by id. Default `"id"`.

```jsonc
"model_sort": "-input_context",      // largest context first
"model_sort": "-input_context,id",   // multi-key
```

`top<N>` / `bottom<N>` truncate the **sorted** list (`top100` + `"-input_context"` = 100 largest-context models). Optional per-directive sort chain overrides `model_sort` for that directive: `(top10:-input_context:-output_context)`.

- In `model_filters` (`"top100"`): fetch time, baked into `models-filtered.csv`, affects every harness.
- In `harness_filters` (`"(top100)"`, `"(top100)->t3,dsh"`): sync time. Bare = all harnesses; `->` = listed ones only; last matching directive wins per harness.
- REST providers: N applies to each provider's **own** models (after `provider/` prefix-filtering), not the global catalog.
- `custom_models[]` always survive and never consume N slots.

Preview CSVs (`models-<harness>.csv`) are governed by `show_harness_model_list`: `"raw"` (only `raw_catalog_harnesses`) · `"all"` (every synced harness) · `"configured"` (only `harness_filters` `->` targets) · `"none"` (never, delete existing). Change it from the [Models](dashboard-models.md) dropdown.

## Dashboard workspace

- **Raw Catalog Harnesses (Raw Leakage)** chips at the top — toggle `raw_catalog_harnesses` per harness.
- **Model sort** — field dropdown + direction chips → `model_sort`.
- **Filter Scope** dropdown — `All (Global Filters)` edits `model_filters`; `Router (…)` / `Solo: …` scopes edit provider-scoped rules (`rule@provider`). Rules with a `->harness` suffix are stored in `harness_filters`; the rest in `model_filters`.
- **Rule rows** — enable/disable (`# ` prefix), edit, delete, multi-select; **Add rule to scope** appends to the current scope.
- **Live preview** — match count re-evaluated as you edit (debounced).
- Every card has **Reset to Defaults** + **Push as Default** (writes `config/default.jsonc` baseline) and a **raw JSON Direct Edit** card.

Deep link: `/filters` or `#/filters` (`harness-filters` redirects here).

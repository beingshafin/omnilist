# Models

Dashboard sidebar: **Workspace → Models**. Read-only browser for the fetched catalog plus the per-harness preview CSVs.

## Files shown

| File | Contents |
|---|---|
| `models-filtered.csv` (default view) | Dedup'd catalog **after** `model_filters` + `custom_models` + `model_sort`. This is what harnesses sync from (unless listed in `raw_catalog_harnesses`). Path: `paths.models_csv`. |
| `models-all.csv` (raw) | Dedup'd catalog **before** `model_filters`. Always id-sorted. Path: `paths.all_models_csv`. |
| `models-<harness>.csv` | Per-harness preview after `harness_filters` + overrides pipeline. Template: `paths.harness_models_file` (`<harness>` → `t3`, `dsh`, …). Written per `show_harness_model_list` (see below). |

Columns: `id`, `input_context`, `output_context`, `vision`, `reasoning`, `tool` (`1` = yes, `0` = no, `-1` = router reported no data — see [Capabilities](rules-capabilities.md)). CSV files keep raw router values; [field overrides](rules-field-overrides.md) apply at sync time only.

## Controls

- **Which catalog** dropdown — switch `models-filtered.csv` ↔ `models-all.csv (raw)`.
- **Search model ID** — substring filter on `id`.
- **Count** — live match count (`role=status`).
- **Refresh** — reload the CSVs from disk (re-run [Fetch](dashboard-run.md) first to update them).
- **Show harness model list** dropdown — edits `show_harness_model_list`:
  - `raw` — write previews only for `raw_catalog_harnesses`.
  - `all` — write a preview for every synced harness.
  - `configured` (current default in `config.jsonc`) — only harnesses targeted by a `harness_filters` rule with a `->` suffix. A bare rule without `->` applies to all harnesses and doesn't count.
  - `none` — never write; existing `models-<harness>.csv` files are deleted on each run.
- **Sortable columns** — click a column header to sort the table view (display only; pipeline order comes from `model_sort`).

## How to read it

1. New models missing? Check `models-all.csv` — if absent there, the Router didn't return them (check [Providers](dashboard-providers.md) + fetch output).
2. Present in `all` but missing in `filtered`? A `model_filters` rule or `-mi`/`-mo` dropped them — see [Filters](rules-filters.md). Exception: `custom_models[]` are never dropped (see [Custom models](rules-custom-models.md)).
3. Present in `filtered` but missing in a harness? A `harness_filters` rule, `raw_catalog_harnesses` bypass, top-N truncation, or `[1m]` exclusion dropped them — compare the `models-<harness>.csv` preview.

Deep link: `/models` or `#/models`.

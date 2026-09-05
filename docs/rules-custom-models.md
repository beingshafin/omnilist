# Custom models

Dashboard sidebar: **Rules & Pipeline → Custom models**. Hand-injected models that enter the pipeline on every fetch and are **never filtered out**.

Config key: `custom_models`.

## Guarantees

- `model_filters`, `harness_filters`, keep-only (`==`) rules, and `-mi`/`-mo` CLI filters **cannot drop them**.
- Added to every catalog file: `models-all.csv`, `models-filtered.csv`, and every `models-<harness>.csv` preview. Paths configurable under `paths` (`all_models_csv`, `harness_models_file`).
- Added to every harness sync.
- On an id collision with a Router-returned model, the injected entry **wins** — its context limits and capabilities are what get written.
- Never consume top/bottom-N slots (see [Filters](rules-filters.md)).

Use for: models the router hides, renamed/aliased entries you want pinned, or local models with hand-set limits.

## Fields

Each entry: `id` plus `in`/`out` context sizes and capabilities (`1` = yes, `0` = no, `-1` = unknown) — card subtitle in the GUI states exactly this. JSON shape follows the catalog columns (`id`, `input_context`, `output_context`, `vision`, `reasoning`, `tool`).

## Dashboard

Table editor (add/edit/delete rows) plus a **raw JSON Direct Edit** card for pasting the whole array. **Reset to Defaults** / **Push as Default** per card.

Deep link: `/custom-models` or `#/custom-models`.

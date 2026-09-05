# Field overrides

Dashboard sidebar: **Rules & Pipeline → Field overrides**. Sync-time value repairs applied when each harness reads models. CSV files keep the raw router values.

Config keys: `invalid_value_overrides`, `always_overrides`.

## The two lists

| List | Rewrites when… | Use for |
|---|---|---|
| `invalid_value_overrides` | Current value is **invalid**: `<= 0` for numeric fields (for capability flags, `-1` no-data **and** `0` false both count), empty for `id` | Fallback context limits for harnesses that refuse `0`/missing values |
| `always_overrides` | **Unconditionally** | Force a capability on/off per harness |

```jsonc
"invalid_value_overrides": [
  "(input_context:1000000)->t3,dsh",  // t3 + dsh get a 1M fallback context
  "(output_context:8192)",            // every harness: output fallback when <= 0
],
"always_overrides": [
  "(vision:1)->opencode",             // opencode always sees vision=true
]
```

## Syntax

`(field:value)` → all harnesses. `(field:value)->t3,dsh` → listed harnesses only (same harness ids/aliases as [Filters](rules-filters.md)). Fields are the `models-filtered.csv` columns: `id`, `input_context`, `output_context`, `vision`, `reasoning`, `tool`. Later directives win on collisions.

## Order of operations

Overrides run **before** the `-mi`/`-mo` min-context filters, so a model repaired by an override still passes them. They run after `harness_filters` + top-N.

## Dashboard

Two sub-sections — **Invalid-value overrides** and **Always overrides** — each with an override builder (field dropdown, value input, harness checkbox targeting, empty-state text when none). Plus **Reset to Defaults** / **Push as Default** per card and a **raw JSON Direct Edit** card covering both arrays.

Deep link: `/overrides` or `#/overrides`.

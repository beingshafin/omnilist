# Capabilities

Dashboard sidebar: **Rules & Pipeline → Capabilities**. Controls how `vision` / `reasoning` / `tool` are detected when building `models-filtered.csv`, and what to assume when the router says nothing.

Config key: `capabilities` (`capabilities.fields`, `capabilities.n_a_defaults`).

## How detection works

For each capability, omnilist probes the router's model object field-by-field, in priority order, at the top level and inside nested objects such as `capabilities` (e.g. `capabilities.reasoning`). First hit wins:

- truthy → `1`
- falsy → `0`
- none of the fields exist → `-1` (unknown)

Defaults in `config.jsonc`:

```jsonc
"capabilities": {
  "fields": {
    "vision":    ["vision", "supports_vision", "image", "input_modalities", "attachment"],
    "reasoning": ["reasoning", "supports_reasoning", "thinking", "supportsThinking"],
    "tool":      ["tool_call", "tool_calls", "supports_tool_call", "tools", "tool_calling", "supports_tool_calling"]
  },
  "n_a_defaults": { "vision": true, "reasoning": true, "tool": true }
}
```

## Unknown defaults

`n_a_defaults` controls what sync steps emit when a model is `-1`. Default `true` for all three (optimistic: assume the capability). If your model list is missing capabilities, your router doesn't report them — they're stored as `-1`; flip the relevant default to `false` to assume absence instead.

Note the interaction with [field overrides](rules-field-overrides.md): `invalid_value_overrides` treat **both** `-1` and `0` as invalid for capability flags.

## Dashboard

- Three **Vision / Reasoning / Tool use** rows — list editors for the probed field names (add/remove/reorder; empty state `(no fields probed)`).
- Three **Assume … when unknown** toggles → `n_a_defaults`.
- **Reset to Defaults** / **Push as Default** + **raw JSON Direct Edit** card.

Deep link: `/capabilities` or `#/capabilities`.

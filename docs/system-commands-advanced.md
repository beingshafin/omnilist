# Commands & advanced

Dashboard sidebar: **System → Commands & advanced**. Post-sync commands plus the raw-JSON escape hatch for the whole config.

Config key: `custom_commands` (array of strings, run after **all** sync targets finish, sequentially, in order).

## Command forms

| Form | Meaning |
|---|---|
| `"ocx sync"` | Normal command — runs to completion (`cmd.exe /c` on Windows, `sh -c` elsewhere) before the next starts. Output shown only on non-zero exit. Failure doesn't stop the chain but makes the script exit 1. |
| `"sleep 5"` | Pause the chain for N seconds. |
| `"bg:ocx start"` | Launch detached in the background (for servers that never exit); the chain continues immediately. |

Current default in `config.jsonc`:

```jsonc
"custom_commands": ["bg:ocx restart", "ocx sync", "ocx claude desktop apply"]
```

## Dashboard

- **Custom commands** sub-section — list editor (add/edit/reorder/delete, multi-select) with the hint "Run after all sync targets, in order. `sleep 5` pauses; `bg:cmd` launches detached for servers."
- **Raw custom commands (JSON)** Direct Edit card — edit the array as JSON.
- **Entire config (raw JSON)** Direct Edit card — view/edit the whole effective configuration as JSON; any valid JSON overrides are applied. This is the escape hatch for keys with no dedicated GUI control.
- **Reset to Defaults** / **Push as Default** per card.

Run the chain from [Run → Custom commands](dashboard-run.md) (`omnilist commands`).

Deep link: `/commands` or `#/commands`.

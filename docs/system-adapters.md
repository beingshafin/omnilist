# Adapters

Dashboard sidebar: **System → Adapters**. The connection-method string each harness writes for its Router, Solo, and REST blocks.

Config keys: per harness — `opencode`, `kilo`, `dsh`, `pi`, `zcode`, `opencodex`, each with `{ router_adapters: [...], solo_adapters: [...], rest_adapters: [...] }`. Free-form strings, written verbatim into that harness's field. (T3 has no adapters — see [T3 drivers](system-t3-drivers.md).)

Current defaults in `config.jsonc` (yours may differ after Push as Default):

| Harness | Router | Solo | REST | Written into |
|---|---|---|---|---|
| opencode | `@ai-sdk/anthropic` | `@ai-sdk/openai-compatible` | `@ai-sdk/anthropic` | `npm` field |
| kilo | `@ai-sdk/anthropic` | `@ai-sdk/openai-compatible` | `@ai-sdk/anthropic` | `npm` field |
| dsh | `anthropic-messages` | `openai-completions` | `anthropic-messages` | `api` field |
| pi | `anthropic-messages` | `openai-completions` | `anthropic-messages` | `api` field |
| zcode | `anthropic` | `openai-compatible` | `anthropic` | `kind` field |
| opencodex | `anthropic` | `openai-chat` | `anthropic` | `adapter` field |

DSH legacy `router_apis` / `rest_apis` (`openai-completions` | `openai-responses` | `anthropic-messages`) are still accepted as fallback.

## Key naming

Managed keys embed the adapter: `c-<simplified-provider>[-<N>][-<simplified-adapter>]` ("simplified" = lowercased, `a-z`/`0-9` only). Single-adapter configs stay bare (`c-agentrouter`); multi-adapter configs append it (`c-agentrouter-2-openaicompletions`). Legacy `c_…` keys are stale and removed by `cleanupproviders`.

## Dashboard

1. **Main table** — rows = harnesses, columns = Router / Solo / REST adapter. Each cell is an editable adapter list; each row has a **reset-to-default** button (visible only when diverged).
2. **Individual providers selector** — `none` / `solo` / `rest` / `both`. Overrides adapters for specific Solo/REST providers from `providers.csv` (rendered as a per-provider table once loaded).
3. **Raw JSON Direct Edit** card for all harness adapter blocks. **Reset to Defaults** / **Push as Default** per card.

Deep link: `/adapters` or `#/adapters`.

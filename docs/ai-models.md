# AI models: what MetaCode can use

Every AI feature (AI Coding, Ask MetaCode, Import Data, Analyze CSV, the AI
Scraper, the desktop app and the AI Coding Lab) reaches models through
providers configured **on the server**; keys never reach the browser. This
page lists the providers, how the model list is built and checked, and the
models in the current catalogs. How the AI service behind it runs and is set
up: [opencode-service.md](opencode-service.md).

## Providers

| Provider | Used by | Needs | Formats and capabilities |
|---|---|---|---|
| **OpenCode Zen** (`opencode/…`), through MetaCode's AI service | every AI feature; the Lab's `metacode` provider | nothing for its free models; `OPENCODE_API_KEY` for the others | streaming; tool calling, attachments and reasoning variants per model (catalog); no embeddings, no fine-tuning |
| **AI gateway** (EMIS, an OpenAI-compatible gateway; `emis/…`), through MetaCode's AI service | every AI feature; the Lab's `metacode` provider | `EMIS_API_KEY` (one or several, rotated); optional `EMIS_BASE_URL` | streaming; tool calling and attachments per model (catalog flags); no embeddings, no fine-tuning |
| **OpenAI / OpenAI-compatible API** | the AI Coding Lab only (`openai` provider) | `AI_LAB_OPENAI_API_KEY`; optional `AI_LAB_OPENAI_BASE_URL` (https), `AI_LAB_OPENAI_MODELS` | chat, streaming, JSON mode when asked; fine-tuning only with `AI_LAB_FINE_TUNING=on` and `AI_LAB_FINE_TUNE_MODELS` |

MetaCode's AI service is its OpenCode service (`opencode/`), which runs beside
MetaCode and speaks OpenAI's chat format to it (`GET /v1/models`,
`POST /v1/chat/completions`); Anthropic-format requests are translated by
MetaCode's server first. The service reaches each Zen model in the model's own
protocol (OpenAI chat completions or Responses, Anthropic Messages, Gemini,
Mistral) and the gateway with chat completions. No embeddings provider is
integrated.

**Privacy.** Free Zen models are rate-limited, and their providers may use
prompts to improve their models during the free period. AI Coding sends the
text of the posts it codes, so researchers working with sensitive posts should
use paid models or the gateway, and set `OPENCODE_DISABLE_FREE_MODELS=1`
([details](opencode-service.md#opencode-zen-opencode)).

## How the list is built and checked

1. **The service's list.** MetaCode reads the AI service's model list (cached
   30 seconds; **↻ Refresh list** in Settings → AI models reads it again): each
   model's id (`provider/model`), name, provider, whether it's free and offered
   now, its capability flags (`tool_call`, `reasoning`, `attachment`), context
   window, output limit and reasoning variants. Only providers that are set up
   contribute:
   - **OpenCode Zen**: OpenCode's catalog (models.dev) — bundled in
     `opencode/zen-models.json`, refreshed every hour from
     `https://models.opencode.ai` when the server can reach it. Without
     `OPENCODE_API_KEY` only the free models are listed;
     `OPENCODE_DISABLE_FREE_MODELS=1` removes them.
   - **The gateway**: `emis-models.json` (or the file `EMIS_MODELS_FILE`
     names) — the gateway's OpenCode config,
     `https://emis.zxs-is-very.cool/cli/opencode.json`, generated live from its
     catalog and filtered to models with tool calling — in OpenCode's format:
     ids, names and capability flags (`tool_call`, `reasoning`, `attachment`,
     optional `limit.context` / `limit.output`). Edits apply without a
     restart. Without the file, the gateway's live list
     (`GET {EMIS_BASE_URL}/models`) is the catalog. Download the file again to
     update it.
2. **Checked against the gateway's own list.** The service also reads the
   gateway's live list (cached 5 minutes) and marks each of the file's models:
   offered now, **not offered now**, or unknown (the list couldn't be read).
   Models are marked, not hidden: the catalog is the operator's choice, and a
   service may answer models it leaves out of its list. Settings → AI models
   shows *"— not offered now"*; the Lab's Models page has an **Offered now**
   column. AI requests never wait for this check.
3. **Validation.** A request for a model id that isn't in the list never
   reaches a provider: the main AI routes use the default model instead (and
   log it once); the Lab refuses it (`model_unavailable`). A request needing a
   capability the list says a model lacks (tools, attachments) is refused
   before it's sent. Ids are sanitized; names are shown as plain text.
4. **Failures.** A 429 for one model rests that model and switches to the
   closest similar model (`model-match.js`, on by default; switching off in
   Settings or with `AI_MODEL_SWITCH=off` covers rate limits and models picked
   in Settings, while the server's default model still falls back when it
   can't run). A used-up budget — the gateway's keys (prompts and/or tokens per
   day, week or month) or Zen's free limit — rests the whole provider until it
   resets, and the closest model from the other provider answers meanwhile
   (never a free model for a paid one, below). With a Zen key, Zen's free limit
   rests only its free models, and a spend limit Zen sets for one model rests
   only that model. When three models of one provider answer with server
   errors within a minute, that provider counts as failing: requests switch to
   the closest model of another provider until one of its models answers. A provider that isn't set up, a
   wrong address or a rejected key give a clear message naming the setting to
   fix; unknown capabilities are shown as unknown, never assumed. Context windows come from Zen's catalog; for the
   gateway they're unknown unless the file states them (the Lab then uses a
   conservative budget).

## Model ids, the default model and switching

- **Ids** are `provider/model`: `opencode/big-pickle`, `emis/claude-opus-5.5`.
  A Zen model can take one of its reasoning variants after `#`
  (`opencode/glm-5.3-flash-free#high`), in requests and in `OPENCODE_MODEL`
  (quoted in `.env`, or `#…` is read as a comment); a variant the model doesn't
  have is refused in a request (400), not answered by another model. Pickers group the models by provider,
  mark free ones (*· free*) and show names; when two providers offer a model
  under the same name, the provider's name is added.
- **The default model**: `OPENCODE_MODEL` in `.env` (or `EMIS_MODEL=<id>` from
  earlier versions, meaning `emis/<id>`); otherwise `emis/claude-opus-5.5` when
  the gateway is set up and lists it; otherwise Zen's first model — without a
  Zen key Big Pickle, with one the newest release. The full order:
  [opencode-service.md](opencode-service.md#3-model-ids-and-the-default-model).
- **Ids saved by earlier versions** (without `emis/`) in Settings, the AI
  Coding Lab and `EMIS_MODEL` still work: they're read as the model of the
  first provider (the gateway before Zen) that lists that id or another
  spelling of it (below). Settings saves the new id once the providers ahead
  of the match have listed their models (a provider without any key isn't
  waited for).
- **Switching.** The closest similar model is the same model from the other
  provider first (Zen spells some ids with dashes where the gateway uses dots;
  `opencode/claude-opus-5-5` is the closest model to `emis/claude-opus-5.5`),
  then the same family and line, the nearest version and size, the same speed
  tier and capabilities. Up to four similar models are tried per request.
  **A free model never answers for one that isn't free**: when the gateway's
  budget is used up, for example, its models are answered by a paid Zen model
  (with a Zen key) or get the quota message, never by Zen's free models (which
  are offered by default; `OPENCODE_DISABLE_FREE_MODELS=1` turns them off). Any
  model can answer for a free one. `AI_FALLBACK_TO_FREE_MODELS=on` in `.env`
  lets free models answer for paid ones too; Settings → AI connection then
  says so.

## Models by status

| Status | Which | What it takes |
|---|---|---|
| Integrated and usable | Zen's free models; Zen's other models; the gateway's models that it lists (Settings shows them unmarked) | nothing; `OPENCODE_API_KEY`; `EMIS_API_KEY` |
| Listed in the gateway's catalog but not offered now | marked in Settings and the Lab | nothing to configure; check with the gateway's operator, or remove them from `emis-models.json` |
| Offered by the gateway but not in its catalog | anything `GET /models` lists beyond the file — models without tool calling, which `/cli/opencode.json` leaves out (e.g. `gpt-oss-120b`, the example in the gateway's documentation) | add it to `emis-models.json` with `"tool_call": false` (or remove the file to use the live list as is) |
| Left out of Zen's list | deprecated models, models without text in and out, realtime, embedding and reranking models | nothing (as in OpenCode) |
| Need more credentials | the Lab's OpenAI-compatible provider; fine-tuning | `AI_LAB_OPENAI_API_KEY` (+ base URL, model list); `AI_LAB_FINE_TUNING=on` |
| Not supported | embeddings; images and videos in answers (the gateway makes them inside a chat completion; MetaCode's features use the text and show `[image omitted]`); image, audio and video models (filtered out of chat pickers) | new provider adapters |

**Supportable without architectural changes:** any OpenAI-compatible
endpoint — for example OpenRouter, Groq, Together, Mistral, DeepSeek,
Google's OpenAI-compatible Gemini endpoint, or a local vLLM / Ollama /
LM Studio server — either through the Lab's `openai` provider
(`AI_LAB_OPENAI_BASE_URL`, Lab only, one at a time), or for the whole app as
another provider in the AI service's config file (`OPENCODE_CONFIG`, with
`"npm": "@ai-sdk/openai-compatible"`; [opencode-service.md](opencode-service.md#5-the-config-file)).

## OpenCode Zen's catalog

`opencode/zen-models.json` as bundled (the models.dev catalog in OpenCode
2.1.4, 2026-10-26): 130 Zen models, of which **82 are offered** with a key
(deprecated ones are left out), **9 of them free** — the only ones offered
without a key. All 82 have tool calling and reasoning; 68 accept attachments.
By protocol: 31 OpenAI Responses, 25 OpenAI chat completions, 17 Anthropic
Messages, 8 Gemini, 1 Mistral. Without a key the free models are listed
starting with Big Pickle, DeepSeek V4.1 Flash Free and GLM-5.3-Flash Free; with
a key, newest first (as below).

The service refreshes the catalog every hour when it can reach
`models.opencode.ai`, so a running server may offer a newer list than this
one: **Settings → AI models → ↻ Refresh list** shows it. Prices are Zen's
(models.dev); MetaCode shows only whether a model is free.

| Id | Name | Free | Protocol | Tools | Reasoning (variants) | Attachments | Context | Output |
|---|---|---|---|---|---|---|---|---|
| `opencode/flint-40b-free` | Flint 40B Free | **free** | chat | yes | yes (low, medium, high, xhigh, max) | no | 262,144 | 65,536 |
| `opencode/nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL Free | **free** | chat | yes | yes (none, minimal, low, medium, high, xhigh) | yes | 1,048,576 | 131,072 |
| `opencode/gemini-4-argon` | Gemini 4 Argon |  | google | yes | yes (low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/muse-wonder-1.0` | Muse Wonder |  | responses | yes | yes (minimal, low, medium, high, xhigh, max) | yes | 1,048,576 | 131,072 |
| `opencode/claude-haiku-5-5` | Claude Haiku 5.5 |  | anthropic | yes | yes (none, low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/mistral-large-4` | Mistral Large 4 |  | mistral | yes | yes (none, high) | yes | 524,288 | 262,144 |
| `opencode/beam-free` | Beam Free | **free** | chat | yes | yes (low, medium, high, xhigh, max) | no | 1,048,576 | 131,072 |
| `opencode/gpt-6.1-sol` | GPT-6.1 Sol |  | responses | yes | yes (low, medium, high, xhigh, max) | yes | 1,050,000 | 128,000 |
| `opencode/claude-sonnet-5-5` | Claude Sonnet 5.5 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/mimo-v2.6-flash-free` | MiMo-V2.6-Flash Free | **free** | chat | yes | yes | yes | 200,000 | 32,000 |
| `opencode/claude-opus-5-5` | Claude Opus 5.5 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/gpt-6-sol` | GPT-6 Sol |  | responses | yes | yes (none, low, medium, high, xhigh, max) | yes | 1,050,000 | 128,000 |
| `opencode/gpt-6-luna` | GPT-6 Luna |  | responses | yes | yes (none, low, medium, high, xhigh, max) | yes | 1,050,000 | 128,000 |
| `opencode/grok-4.7` | Grok 4.7 |  | responses | yes | yes (low, medium, high, xhigh) | yes | 500,000 | 500,000 |
| `opencode/deepseek-v4.1-flash` | DeepSeek V4.1 Flash |  | chat | yes | yes (low, high, max) | yes | 1,000,000 | 384,000 |
| `opencode/deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free | **free** | chat | yes | yes (low, high, max) | yes | 200,000 | 32,000 |
| `opencode/gpt-6-astra` | GPT-6 Astra |  | responses | yes | yes (low, medium, high, xhigh, max) | yes | 1,050,000 | 128,000 |
| `opencode/gemini-3.8-flash` | Gemini 3.8 Flash |  | google | yes | yes (low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/muse-spark-1.3` | Muse Spark 1.3 |  | responses | yes | yes (minimal, low, medium, high, xhigh) | yes | 1,048,576 | 131,072 |
| `opencode/claude-fable-5-1` | Claude Fable 5.1 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/glm-5.3-flash` | GLM-5.3-Flash |  | chat | yes | yes (low, high, max) | yes | 1,000,000 | 131,072 |
| `opencode/glm-5.3-flash-free` | GLM-5.3-Flash Free | **free** | chat | yes | yes (low, high, max) | yes | 200,000 | 32,000 |
| `opencode/qwen3.8-flash` | Qwen3.8 Flash |  | anthropic | yes | yes (none, low, medium, xhigh) | yes | 1,000,000 | 131,072 |
| `opencode/glm-5.3` | GLM-5.3 |  | chat | yes | yes (low, high, max) | no | 1,000,000 | 131,072 |
| `opencode/gemini-3.7-flash` | Gemini 3.7 Flash |  | google | yes | yes (low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/grok-4.6` | Grok 4.6 |  | responses | yes | yes (low, medium, high, xhigh) | yes | 500,000 | 500,000 |
| `opencode/nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | **free** | chat | yes | yes | no | 262,144 | 262,144 |
| `opencode/muse-spark-1.2` | Muse Spark 1.2 |  | responses | yes | yes (minimal, low, medium, high, xhigh) | yes | 1,048,576 | 131,072 |
| `opencode/qwen3.8-max` | Qwen3.8 Max |  | chat | yes | yes (low, medium, xhigh) | yes | 262,144 | 131,072 |
| `opencode/deepseek-v4-flash` | DeepSeek V4 Flash |  | chat | yes | yes (low, high, max) | no | 1,000,000 | 384,000 |
| `opencode/claude-opus-5` | Claude Opus 5 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite |  | google | yes | yes (minimal, low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/gemini-3.6-flash` | Gemini 3.6 Flash |  | google | yes | yes (minimal, low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/kimi-k3` | Kimi K3 |  | chat | yes | yes (low, high, max) | yes | 1,048,576 | 131,072 |
| `opencode/gpt-5.6-luna` | GPT-5.6 Luna |  | responses | yes | yes (none, low, medium, high, xhigh, max) | yes | 1,050,000 | 128,000 |
| `opencode/gpt-5.6-sol` | GPT-5.6 Sol |  | responses | yes | yes (none, low, medium, high, xhigh, max) | yes | 1,050,000 | 128,000 |
| `opencode/gpt-5.6-terra` | GPT-5.6 Terra |  | responses | yes | yes (none, low, medium, high, xhigh, max) | yes | 1,050,000 | 128,000 |
| `opencode/grok-4.5` | Grok 4.5 |  | responses | yes | yes (low, medium, high) | yes | 500,000 | 500,000 |
| `opencode/claude-sonnet-5` | Claude Sonnet 5 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/glm-5.2` | GLM-5.2 |  | chat | yes | yes (high, max) | no | 1,000,000 | 131,072 |
| `opencode/kimi-k2.7-code` | Kimi K2.7 Code |  | chat | yes | yes | yes | 262,144 | 262,144 |
| `opencode/claude-fable-5` | Claude Fable 5 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/nemotron-3-ultra-free` | Nemotron 3 Ultra Free | **free** | chat | yes | yes | no | 1,000,000 | 128,000 |
| `opencode/minimax-m3` | MiniMax-M3 |  | chat | yes | yes | yes | 512,000 | 128,000 |
| `opencode/claude-opus-4-8` | Claude Opus 4.8 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/gemini-3.5-flash` | Gemini 3.5 Flash |  | google | yes | yes (minimal, low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/deepseek-v4-pro` | DeepSeek V4 Pro |  | chat | yes | yes (high, max) | no | 1,000,000 | 384,000 |
| `opencode/gpt-5.5` | GPT-5.5 |  | responses | yes | yes (none, low, medium, high, xhigh) | yes | 1,050,000 | 128,000 |
| `opencode/gpt-5.5-pro` | GPT-5.5 Pro |  | responses | yes | yes (medium, high, xhigh) | yes | 1,050,000 | 128,000 |
| `opencode/kimi-k2.6` | Kimi K2.6 |  | chat | yes | yes | yes | 262,144 | 65,536 |
| `opencode/grok-build-0.1` | Grok Build 0.1 |  | responses | yes | yes | yes | 256,000 | 256,000 |
| `opencode/claude-opus-4-7` | Claude Opus 4.7 |  | anthropic | yes | yes (low, medium, high, xhigh, max) | yes | 1,000,000 | 128,000 |
| `opencode/glm-5.1` | GLM-5.1 |  | chat | yes | yes | no | 204,800 | 131,072 |
| `opencode/qwen3.6-plus` | Qwen3.6 Plus |  | anthropic | yes | yes (none, high, max) | yes | 262,144 | 65,536 |
| `opencode/minimax-m2.7` | MiniMax-M2.7 |  | chat | yes | yes | no | 204,800 | 131,072 |
| `opencode/gpt-5.4-mini` | GPT-5.4 Mini |  | responses | yes | yes (none, low, medium, high, xhigh) | yes | 400,000 | 128,000 |
| `opencode/gpt-5.4-nano` | GPT-5.4 Nano |  | responses | yes | yes (none, low, medium, high, xhigh) | yes | 400,000 | 128,000 |
| `opencode/gpt-5.4-pro` | GPT-5.4 Pro |  | responses | yes | yes (medium, high, xhigh) | yes | 1,050,000 | 128,000 |
| `opencode/gpt-5.4` | GPT-5.4 |  | responses | yes | yes (none, low, medium, high, xhigh) | yes | 1,050,000 | 128,000 |
| `opencode/gemini-3.1-pro` | Gemini 3.1 Pro Preview |  | google | yes | yes (low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/claude-sonnet-4-6` | Claude Sonnet 4.6 |  | anthropic | yes | yes (low, medium, high, max) | yes | 1,000,000 | 64,000 |
| `opencode/qwen3.5-plus` | Qwen3.5 Plus |  | anthropic | yes | yes (none, high, max) | yes | 262,144 | 65,536 |
| `opencode/glm-5` | GLM-5 |  | chat | yes | yes | no | 204,800 | 131,072 |
| `opencode/minimax-m2.5` | MiniMax-M2.5 |  | chat | yes | yes | no | 204,800 | 131,072 |
| `opencode/gpt-5.3-codex-spark` | GPT-5.3 Codex Spark |  | responses | yes | yes (low, medium, high, xhigh) | no | 128,000 | 128,000 |
| `opencode/claude-opus-4-6` | Claude Opus 4.6 |  | anthropic | yes | yes (low, medium, high, max) | yes | 1,000,000 | 128,000 |
| `opencode/gpt-5.3-codex` | GPT-5.3 Codex |  | responses | yes | yes (none, low, medium, high, xhigh) | yes | 400,000 | 128,000 |
| `opencode/kimi-k2.5` | Kimi K2.5 |  | chat | yes | yes | yes | 262,144 | 65,536 |
| `opencode/gemini-3-flash` | Gemini 3 Flash |  | google | yes | yes (minimal, low, medium, high) | yes | 1,048,576 | 65,536 |
| `opencode/gpt-5.2-codex` | GPT-5.2 Codex |  | responses | yes | yes (low, medium, high, xhigh) | yes | 400,000 | 128,000 |
| `opencode/gpt-5.2` | GPT-5.2 |  | responses | yes | yes (none, low, medium, high, xhigh) | yes | 400,000 | 128,000 |
| `opencode/claude-opus-4-5` | Claude Opus 4.5 |  | anthropic | yes | yes (low, medium, high) | yes | 200,000 | 64,000 |
| `opencode/gpt-5.1-codex-mini` | GPT-5.1 Codex Mini |  | responses | yes | yes (low, medium, high) | yes | 400,000 | 128,000 |
| `opencode/gpt-5.1-codex` | GPT-5.1 Codex |  | responses | yes | yes (low, medium, high) | yes | 400,000 | 128,000 |
| `opencode/gpt-5.1` | GPT-5.1 |  | responses | yes | yes (none, low, medium, high) | yes | 400,000 | 128,000 |
| `opencode/gpt-5.1-codex-max` | GPT-5.1 Codex Max |  | responses | yes | yes (low, medium, high, xhigh) | yes | 400,000 | 128,000 |
| `opencode/big-pickle` | Big Pickle | **free** | chat | yes | yes | no | 200,000 | 32,000 |
| `opencode/claude-haiku-4-5` | Claude Haiku 4.5 |  | anthropic | yes | yes (high, max) | yes | 200,000 | 64,000 |
| `opencode/claude-sonnet-4-5` | Claude Sonnet 4.5 |  | anthropic | yes | yes (high, max) | yes | 1,000,000 | 64,000 |
| `opencode/gpt-5-codex` | GPT-5 Codex |  | responses | yes | yes (low, medium, high) | yes | 400,000 | 128,000 |
| `opencode/gpt-5` | GPT-5 |  | responses | yes | yes (minimal, low, medium, high) | yes | 400,000 | 128,000 |
| `opencode/gpt-5-nano` | GPT-5 Nano |  | responses | yes | yes (minimal, low, medium, high) | yes | 400,000 | 128,000 |

Variants are the reasoning settings a model accepts after `#` in its id (or as
`reasoning_effort`); "yes" without a list means the model reasons but has no
settings for it.

## The gateway's catalog

`emis-models.json` as committed in `378c897` (2026-10-22): **347 models**, all
with tool calling (the gateway's `/cli/opencode.json`, which the file is,
lists only those), 266 with reasoning, 213 accepting attachments; none states a
context window or output limit. In MetaCode their ids start with `emis/`. When
the gateway is set up and `OPENCODE_MODEL` is empty, the default is
`emis/claude-opus-5.5`; the file's first entry, `flint-v1.0-free`, isn't a
choice anyone made — the file's order is the gateway's.

Twelve ids of the previous catalog are now spelled with dots: `claude-opus-5-5`
→ `claude-opus-5.5`, `claude-sonnet-5-5` → `claude-sonnet-5.5`,
`claude-opus-4-6` → `claude-opus-4.6`, `gpt-6-1-sol` → `gpt-6.1-sol`, `gpt-5-6`
→ `gpt-5.6-sol`, `gpt-5-5` → `gpt-5.5`, `gemini-3-8-flash` → `gemini-3.8-flash`,
`kimi-k2-6` → `kimi-k2.6`, `grok-4-7` → `grok-4.7`, `qwen-3-7-max` →
`qwen-3.7-max`, `glm-5-3` → `glm-5.3`, `glm-5-3-flash` → `glm-5.3-flash`. A
model picked under an old spelling is still that model (`renamedModel()` in
`model-match.js`: "-" or "_" between two digits reads as "."), in Settings,
the Lab, `OPENCODE_MODEL` and `EMIS_MODEL`. Some models are listed under both
spellings (`claude-opus-4.8` / `claude-opus-4-8`, `claude-opus-4.7` /
`claude-opus-4-7`, `claude-fable-5.1` / `claude-fable-5-1`, `deepseek-v4.1-flash` /
`deepseek-v4-1-flash`), and two different ids share the name "Deepseek V4
Flash" (`deepseek-v4-flash`, `deepseek-v4-flash-latest`); a rate-limited model
is answered by a similar model before its other spelling. `openai`,
`openai-fast` and the `…-latest` ids are aliases whose underlying model the
gateway chooses.

Families (by id): OpenAI GPT 65, Alibaba Qwen 54, Anthropic Claude 22,
DeepSeek 19, Zhipu GLM 18, Google Gemini 17, Mistral 17, xAI Grok 12, NVIDIA
Nemotron 10, Moonshot Kimi 8, Muse 8, MiniMax 7, ByteDance Seed 6, Xiaomi
MiMo 6, and fewer than 6 each for the rest.

Whether each model is offered **right now** can only be read from the gateway
with the server's key: open **Settings → AI models → ↻ Refresh list** (or the
Lab's **Models** page) on the server. The list below is the catalog, not a
verified availability list. To update it, download
`https://emis.zxs-is-very.cool/cli/opencode.json` again and save it as
`emis-models.json`.

| Family (by id) | Id | Name | Tools | Reasoning | Attachments |
|---|---|---|---|---|---|
| OpenAI GPT | `emis/gpt-6.1-sol-pro` | GPT-6.1 Sol Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-6.1-sol` | GPT-6.1 Sol | yes | yes | yes |
| OpenAI GPT | `emis/gpt-6-luna-pro` | GPT-6 Luna Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-6-luna` | GPT-6 Luna | yes | yes | yes |
| OpenAI GPT | `emis/gpt-6-sol-pro` | GPT-6 Sol Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-6-sol` | GPT-6 Sol | yes | yes | yes |
| OpenAI GPT | `emis/gpt-astra-latest` | GPT Astra | yes | yes | yes |
| OpenAI GPT | `emis/gpt-sol-latest` | GPT Sol | yes | yes | yes |
| OpenAI GPT | `emis/gpt-terra-latest` | GPT Terra | yes | yes | yes |
| OpenAI GPT | `emis/gpt-luna-latest` | GPT Luna | yes | yes | yes |
| OpenAI GPT | `emis/gpt-6-astra` | GPT-6 Astra | yes | yes | yes |
| OpenAI GPT | `emis/gpt-6-astra-pro` | GPT-6 Astra Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.6-luna-pro` | GPT-5.6 Luna Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.6-terra-pro` | GPT-5.6 Terra Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.6-terra` | GPT-5.6 Terra | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.6-sol-pro` | GPT-5.6 Sol Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.6-sol` | GPT-5.6 Sol | yes | yes | yes |
| OpenAI GPT | `emis/gpt-chat-latest` | GPT Chat | yes | no | yes |
| OpenAI GPT | `emis/gpt-mini-latest` | GPT Mini | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.5-pro` | GPT-5.5 Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.5` | GPT-5.5 | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.4-nano` | GPT-5.4 Nano | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.4-pro` | GPT-5.4 Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.4` | GPT-5.4 | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.3-codex` | GPT-5.3 Codex | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.2-codex` | GPT-5.2 Codex | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.2-chat` | GPT-5.2 Chat | yes | no | yes |
| OpenAI GPT | `emis/gpt-5.2-pro` | GPT-5.2 Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.2` | GPT-5.2 | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.1-codex-max` | GPT-5.1 Codex Max | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.1` | GPT-5.1 | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.1-codex` | GPT-5.1 Codex | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.1-codex-mini` | GPT-5.1 Codex Mini | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5-pro` | GPT-5 Pro | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5` | GPT-5 | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5-mini` | GPT-5 Mini | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5-nano` | GPT-5 Nano | yes | yes | yes |
| OpenAI GPT | `emis/gpt-oss-20b` | GPT-OSS 20B | yes | yes | no |
| OpenAI GPT | `emis/o3-pro` | O3 Pro | yes | yes | yes |
| OpenAI GPT | `emis/o4-mini-high` | O4 Mini High | yes | yes | yes |
| OpenAI GPT | `emis/o3` | O3 | yes | yes | yes |
| OpenAI GPT | `emis/o4-mini` | O4 Mini | yes | yes | yes |
| OpenAI GPT | `emis/gpt-4.1` | GPT-4.1 | yes | no | yes |
| OpenAI GPT | `emis/gpt-4.1-mini` | GPT-4.1 Mini | yes | no | yes |
| OpenAI GPT | `emis/gpt-4.1-nano` | GPT-4.1 Nano | yes | no | yes |
| OpenAI GPT | `emis/o3-mini-high` | O3 Mini High | yes | yes | no |
| OpenAI GPT | `emis/o3-mini` | O3 Mini | yes | yes | no |
| OpenAI GPT | `emis/o1` | O1 | yes | yes | yes |
| OpenAI GPT | `emis/gpt-4o-2024-11-20` | GPT 4o 2024 11 20 | yes | no | yes |
| OpenAI GPT | `emis/gpt-4o-2024-08-06` | GPT 4o 2024 08 06 | yes | no | yes |
| OpenAI GPT | `emis/gpt-4o-mini` | GPT 4o Mini | yes | no | yes |
| OpenAI GPT | `emis/gpt-4o-mini-2024-07-18` | GPT 4o Mini 2024 07 18 | yes | no | yes |
| OpenAI GPT | `emis/gpt-4o` | GPT 4o | yes | no | yes |
| OpenAI GPT | `emis/gpt-4o-2024-05-13` | GPT 4o 2024 05 13 | yes | no | yes |
| OpenAI GPT | `emis/gpt-4-turbo` | GPT-4 Turbo | yes | no | yes |
| OpenAI GPT | `emis/gpt-3.5-turbo-0613` | GPT-3.5 Turbo 0613 | yes | no | no |
| OpenAI GPT | `emis/gpt-3.5-turbo-16k` | GPT-3.5 Turbo 16k | yes | no | no |
| OpenAI GPT | `emis/gpt-3.5-turbo` | GPT-3.5 Turbo | yes | no | no |
| OpenAI GPT | `emis/gpt-4` | GPT-4 | yes | no | no |
| OpenAI GPT | `emis/gpt-5-chat-2` | GPT 5 Chat 2 | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.4-mini-kb-curate` | GPT 5.4 Mini Kb Curate | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5.2_critique` | GPT 5.2 Critique | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5-chat` | GPT-5 Chat | yes | yes | yes |
| OpenAI GPT | `emis/gpt-5-kiara` | GPT 5 Kiara | yes | yes | yes |
| OpenAI GPT | `emis/gpt-oss` | GPT OSS | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.8-max-prime` | Qwen 3.8 Max Prime | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.8-omni-flash` | Qwen 3.8 Omni Flash | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.8-max-0902` | Qwen 3.8 Max 0902 | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.8-flash` | Qwen 3.8 Flash | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.8-27b` | Qwen 3.8 27B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.8-2.4t-a95b` | Qwen 3.8 2.4t A95B | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.7-flash` | Qwen 3.7 Flash | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.7-plus` | Qwen 3.7 Plus | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.7-max` | Qwen 3.7 Max | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.5-plus-20260420` | Qwen 3.5 Plus 20260420 | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.6-flash` | Qwen 3.6 Flash | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.6-35b-a3b` | Qwen 3.6 35B A3B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.6-27b` | Qwen 3.6 27B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.6-plus` | Qwen 3.6 Plus | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.5-9b` | Qwen 3.5 9B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.5-35b-a3b` | Qwen 3.5 35B A3B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.5-27b` | Qwen 3.5 27B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.5-122b-a10b` | Qwen 3.5 122B A10B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.5-flash-02-23` | Qwen 3.5 Flash 02 23 | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.5-plus-02-15` | Qwen 3.5 Plus 02 15 | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3.5-397b-a17b` | Qwen 3.5 397B A17B | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3-coder-next` | Qwen 3 Coder Next | yes | no | no |
| Alibaba Qwen | `emis/qwen-3-vl-8b-instruct` | Qwen 3 VL 8B | yes | no | yes |
| Alibaba Qwen | `emis/qwen-3-vl-30b-a3b-thinking` | Qwen 3 VL 30B A3B Thinking | yes | yes | yes |
| Alibaba Qwen | `emis/qwen-3-vl-30b-a3b-instruct` | Qwen 3 VL 30B A3B | yes | no | yes |
| Alibaba Qwen | `emis/qwen-3-vl-235b-a22b-instruct` | Qwen 3 VL 235B A22B | yes | no | yes |
| Alibaba Qwen | `emis/qwen-3-coder-flash` | Qwen 3 Coder Flash | yes | no | no |
| Alibaba Qwen | `emis/qwen-3-next-80b-a3b-thinking` | Qwen 3 Next 80B A3B Thinking | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3-next-80b-a3b-instruct` | Qwen 3 Next 80B A3B | yes | no | no |
| Alibaba Qwen | `emis/qwen-3-coder-30b-a3b-instruct` | Qwen 3 Coder 30B A3B | yes | no | no |
| Alibaba Qwen | `emis/qwen-3-30b-a3b-instruct-2507` | Qwen 3 30B A3B 2507 | yes | no | no |
| Alibaba Qwen | `emis/qwen-3-235b-a22b-thinking-2507` | Qwen 3 235B A22B Thinking 2507 | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3-coder` | Qwen 3 Coder | yes | no | no |
| Alibaba Qwen | `emis/qwen-3-235b-a22b-2507` | Qwen 3 235B A22B 2507 | yes | no | no |
| Alibaba Qwen | `emis/qwen-3-30b-a3b` | Qwen 3 30B A3B | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3-14b` | Qwen 3 14B | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3-32b` | Qwen 3 32B | yes | yes | no |
| Alibaba Qwen | `emis/qwen-plus` | Qwen Plus | yes | no | no |
| Alibaba Qwen | `emis/qwen-2.5-7b-instruct` | Qwen 2.5 7B | yes | no | no |
| Alibaba Qwen | `emis/qwen-2.5-72b-instruct` | Qwen 2.5 72B | yes | no | no |
| Alibaba Qwen | `emis/qwen-3.5-plus` | Qwen 3.5 Plus | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.5-plus-thinking` | Qwen 3.5 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.6-plus-thinking` | Qwen 3.6 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.7-plus-thinking` | Qwen 3.7 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.6-max-preview` | Qwen 3.6 Max Preview | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.6-max-preview-thinking` | Qwen 3.6 Max Preview Thinking | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.7-max-thinking` | Qwen 3.7 Max Thinking | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.8-max` | Qwen 3.8 Max | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.8-max-thinking` | Qwen 3.8 Max Thinking | yes | yes | no |
| Alibaba Qwen | `emis/qwen-3.5-omni-plus` | Qwen 3.5 Omni Plus | yes | yes | yes |
| Alibaba Qwen | `emis/qwen3.5-397b-a17b` | Qwen3.5 397b A17b | yes | yes | no |
| Alibaba Qwen | `emis/qwen3.6-27b` | Qwen3.6 27b | yes | yes | no |
| Alibaba Qwen | `emis/qwen3.5-9b` | Qwen3.5 9b | yes | yes | no |
| Alibaba Qwen | `emis/qwen2.5-vl-72b-instruct` | Qwen2.5 VL 72b Instruct | yes | no | yes |
| Anthropic Claude | `emis/claude-haiku-5.5` | Claude Haiku 5.5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-sonnet-5.5` | Claude Sonnet 5.5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-5.5` | Claude Opus 5.5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-fable-5.1` | Claude Fable 5.1 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-5` | Claude Opus 5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-sonnet-5` | Claude Sonnet 5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-fable-latest` | Claude Fable | yes | yes | yes |
| Anthropic Claude | `emis/claude-fable-5` | Claude Fable 5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-4.8` | Claude Opus 4.8 | yes | yes | yes |
| Anthropic Claude | `emis/claude-haiku-latest` | Claude Haiku | yes | yes | yes |
| Anthropic Claude | `emis/claude-sonnet-latest` | Claude Sonnet | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-latest` | Claude Opus | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-4.7` | Claude Opus 4.7 | yes | yes | yes |
| Anthropic Claude | `emis/claude-sonnet-4.6` | Claude Sonnet 4.6 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-4.6` | Claude Opus 4.6 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-4.5` | Claude Opus 4.5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-haiku-4.5` | Claude Haiku 4.5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-sonnet-4.5` | Claude Sonnet 4.5 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-4.1` | Claude Opus 4.1 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-4-8` | Claude Opus 4.8 | yes | yes | yes |
| Anthropic Claude | `emis/claude-fable-5-1` | Claude Fable 5.1 | yes | yes | yes |
| Anthropic Claude | `emis/claude-opus-4-7` | Claude Opus 4.7 | yes | yes | yes |
| DeepSeek | `emis/deepseek-v4.1-flash-1017` | Deepseek V4.1 Flash 1017 | yes | yes | yes |
| DeepSeek | `emis/deepseek-pro-latest` | Deepseek Pro | yes | yes | no |
| DeepSeek | `emis/deepseek-flash-latest` | Deepseek Flash | yes | yes | yes |
| DeepSeek | `emis/deepseek-v4.1-flash` | Deepseek V4.1 Flash | yes | yes | yes |
| DeepSeek | `emis/deepseek-v4-flash-vision-exp` | Deepseek V4 Flash Vision Exp | yes | yes | yes |
| DeepSeek | `emis/deepseek-v4-pro-0813` | Deepseek V4 Pro 0813 | yes | yes | no |
| DeepSeek | `emis/deepseek-v4-flash-latest` | Deepseek V4 Flash | yes | yes | no |
| DeepSeek | `emis/deepseek-v4-flash-0731` | Deepseek V4 Flash 0731 | yes | yes | no |
| DeepSeek | `emis/deepseek-v4-pro` | Deepseek V4 Pro | yes | yes | no |
| DeepSeek | `emis/deepseek-v4-flash` | Deepseek V4 Flash | yes | yes | no |
| DeepSeek | `emis/deepseek-v3.2` | Deepseek V3.2 | yes | yes | no |
| DeepSeek | `emis/deepseek-v3.2-exp` | Deepseek V3.2 Exp | yes | yes | no |
| DeepSeek | `emis/deepseek-v3.1-terminus` | Deepseek V3.1 Terminus | yes | yes | no |
| DeepSeek | `emis/deepseek-chat-v3.1` | Deepseek Chat V3.1 | yes | yes | no |
| DeepSeek | `emis/deepseek-r1-0528` | Deepseek R1 0528 | yes | yes | no |
| DeepSeek | `emis/deepseek-chat-v3-0324` | Deepseek Chat V3 0324 | yes | no | no |
| DeepSeek | `emis/deepseek-chat` | Deepseek Chat | yes | no | no |
| DeepSeek | `emis/deepseek-v4-1-flash` | Deepseek V4 1 Flash | yes | yes | no |
| DeepSeek | `emis/deepseek-v4-flash-0731-turbo` | DeepSeek V4 Flash (0731) | yes | yes | no |
| Zhipu GLM | `emis/glm-5.3-prime` | GLM 5.3 Prime | yes | yes | no |
| Zhipu GLM | `emis/glm-5.3-flashx` | GLM 5.3 Flashx | yes | yes | yes |
| Zhipu GLM | `emis/glm-flash-latest` | GLM Flash | yes | yes | yes |
| Zhipu GLM | `emis/glm-5.3-flash` | GLM 5.3 Flash | yes | yes | yes |
| Zhipu GLM | `emis/glm-latest` | GLM | yes | yes | no |
| Zhipu GLM | `emis/glm-5.3` | GLM 5.3 | yes | yes | no |
| Zhipu GLM | `emis/glm-5.2` | GLM 5.2 | yes | yes | no |
| Zhipu GLM | `emis/glm-5.1` | GLM 5.1 | yes | yes | no |
| Zhipu GLM | `emis/glm-5v-turbo` | GLM 5v Turbo | yes | yes | yes |
| Zhipu GLM | `emis/glm-5-turbo` | GLM 5 Turbo | yes | yes | no |
| Zhipu GLM | `emis/glm-5` | GLM 5 | yes | yes | no |
| Zhipu GLM | `emis/glm-4.7-flash` | GLM 4.7 Flash | yes | yes | no |
| Zhipu GLM | `emis/glm-4.7` | GLM 4.7 | yes | yes | no |
| Zhipu GLM | `emis/glm-4.6v` | GLM 4.6v | yes | yes | yes |
| Zhipu GLM | `emis/glm-4.6` | GLM 4.6 | yes | yes | no |
| Zhipu GLM | `emis/glm-4.5v` | GLM 4.5v | yes | yes | yes |
| Zhipu GLM | `emis/glm-4.5` | GLM 4.5 | yes | yes | no |
| Zhipu GLM | `emis/glm-4.5-air` | GLM 4.5 Air | yes | yes | no |
| Google Gemini | `emis/gemini-4-argon` | Gemini 4 Argon | yes | yes | yes |
| Google Gemini | `emis/gemini-3.8-flash` | Gemini 3.8 Flash | yes | yes | yes |
| Google Gemini | `emis/gemini-3.7-flash` | Gemini 3.7 Flash | yes | yes | yes |
| Google Gemini | `emis/gemini-3.6-flash` | Gemini 3.6 Flash | yes | yes | yes |
| Google Gemini | `emis/gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | yes | yes | yes |
| Google Gemini | `emis/gemini-3.5-flash` | Gemini 3.5 Flash | yes | yes | yes |
| Google Gemini | `emis/gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | yes | yes | yes |
| Google Gemini | `emis/gemini-pro-latest` | Gemini Pro | yes | yes | yes |
| Google Gemini | `emis/gemini-flash-latest` | Gemini Flash | yes | yes | yes |
| Google Gemini | `emis/gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | yes | yes | yes |
| Google Gemini | `emis/gemini-3.1-pro-preview-customtools` | Gemini 3.1 Pro Preview Customtools | yes | yes | yes |
| Google Gemini | `emis/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | yes | yes | yes |
| Google Gemini | `emis/gemini-3-flash-preview` | Gemini 3 Flash Preview | yes | yes | yes |
| Google Gemini | `emis/gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | yes | yes | yes |
| Google Gemini | `emis/gemini-2.5-flash` | Gemini 2.5 Flash | yes | yes | yes |
| Google Gemini | `emis/gemini-2.5-pro` | Gemini 2.5 Pro | yes | yes | yes |
| Google Gemini | `emis/gemini-2.5-pro-preview` | Gemini 2.5 Pro Preview | yes | yes | yes |
| Mistral | `emis/mistral-large-4-0` | Mistral Large 4.0 | yes | yes | yes |
| Mistral | `emis/mistral-medium-3-5` | Mistral Medium 3.5 | yes | yes | yes |
| Mistral | `emis/ministral-14b-2512` | Ministral 14B 2512 | yes | no | yes |
| Mistral | `emis/ministral-8b-2512` | Ministral 8B 2512 | yes | no | yes |
| Mistral | `emis/ministral-3b-2512` | Ministral 3B 2512 | yes | no | yes |
| Mistral | `emis/mistral-medium-3.1` | Mistral Medium 3.1 | yes | no | yes |
| Mistral | `emis/codestral-2508` | Codestral 2508 | yes | no | no |
| Mistral | `emis/mistral-small-3.2-24b-instruct` | Mistral Small 3.2 24B | yes | no | yes |
| Mistral | `emis/mistral-medium-3` | Mistral Medium 3 | yes | no | yes |
| Mistral | `emis/mistral-small-3.1-24b-instruct` | Mistral Small 3.1 24B | yes | no | yes |
| Mistral | `emis/mistral-large-2407` | Mistral Large 2407 | yes | no | no |
| Mistral | `emis/mistral-nemo` | Mistral Nemo | yes | no | no |
| Mistral | `emis/mistral-large` | Mistral Large | yes | no | no |
| Mistral | `emis/codestral-latest` | Codestral Latest | yes | no | no |
| Mistral | `emis/mistral-small-3.2-24b-instruct-2506` | Mistral Small 3.2 24b Instruct 2506 | yes | no | no |
| Mistral | `emis/mistral-nemo-instruct-2407` | Mistral Nemo Instruct 2407 | yes | no | no |
| Mistral | `emis/mistral-7b-instruct-v0.3` | Mistral 7b Instruct V0.3 | yes | no | no |
| xAI Grok | `emis/grok-4.7` | Grok 4.7 | yes | yes | yes |
| xAI Grok | `emis/grok-4.6` | Grok 4.6 | yes | yes | yes |
| xAI Grok | `emis/grok-4.5` | Grok 4.5 | yes | yes | yes |
| xAI Grok | `emis/grok-latest` | Grok | yes | yes | yes |
| xAI Grok | `emis/grok-build-0.1` | Grok Build 0.1 | yes | yes | yes |
| xAI Grok | `emis/grok-4.3` | Grok 4.3 | yes | yes | yes |
| xAI Grok | `emis/grok-4.20` | Grok 4.20 | yes | yes | yes |
| xAI Grok | `emis/grok-4` | Grok 4 | yes | yes | yes |
| xAI Grok | `emis/grok-4-fast` | Grok 4 Fast | yes | yes | yes |
| xAI Grok | `emis/grok-3` | Grok 3 | yes | no | yes |
| xAI Grok | `emis/grok-3-mini` | Grok 3 Mini | yes | yes | yes |
| xAI Grok | `emis/grok-code-fast-1` | Grok Code Fast 1 | yes | no | yes |
| NVIDIA Nemotron | `emis/nemotron-3.5-super-vl` | Nemotron 3.5 Super VL | yes | yes | yes |
| NVIDIA Nemotron | `emis/nemotron-3.5-lightning` | Nemotron 3.5 Lightning | yes | yes | no |
| NVIDIA Nemotron | `emis/nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra 550B A55B | yes | yes | no |
| NVIDIA Nemotron | `emis/nemotron-3-nano-omni-30b-a3b-reasoning-free` | Nemotron 3 Nano Omni 30B A3B Reasoning Free | yes | yes | yes |
| NVIDIA Nemotron | `emis/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B A12B | yes | yes | no |
| NVIDIA Nemotron | `emis/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B A3B | yes | yes | no |
| NVIDIA Nemotron | `emis/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning` | Nvidia Nemotron 3 Nano Omni 30b A3b Reasoning | yes | yes | yes |
| NVIDIA Nemotron | `emis/nvidia-nemotron-3-super-120b-a12b` | Nvidia Nemotron 3 Super 120b A12b | yes | yes | no |
| NVIDIA Nemotron | `emis/nvidia-nemotron-3-ultra-550b-a55b` | Nvidia Nemotron 3 Ultra 550b A55b | yes | yes | no |
| NVIDIA Nemotron | `emis/nvidia-nemotron-3.5-lightning` | Nvidia Nemotron 3.5 Lightning | yes | yes | no |
| Moonshot Kimi | `emis/kimi-k3` | Kimi K3 | yes | yes | yes |
| Moonshot Kimi | `emis/kimi-k2.7-code` | Kimi K2.7 Code | yes | yes | yes |
| Moonshot Kimi | `emis/kimi-latest` | Kimi | yes | yes | yes |
| Moonshot Kimi | `emis/kimi-k2.6` | Kimi K2.6 | yes | yes | yes |
| Moonshot Kimi | `emis/kimi-k2.5` | Kimi K2.5 | yes | yes | yes |
| Moonshot Kimi | `emis/kimi-k2-thinking` | Kimi K2 Thinking | yes | yes | no |
| Moonshot Kimi | `emis/kimi-k2-0905` | Kimi K2 0905 | yes | no | no |
| Moonshot Kimi | `emis/kimi-k2` | Kimi K2 | yes | no | no |
| Muse | `emis/muse-spark-open` | Muse Spark Open | yes | yes | yes |
| Muse | `emis/muse-wonder` | Muse Wonder | yes | yes | yes |
| Muse | `emis/muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | yes | yes | yes |
| Muse | `emis/muse-spark-1.3` | Muse Spark 1.3 | yes | yes | yes |
| Muse | `emis/muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | yes | yes | yes |
| Muse | `emis/muse-glimmer-30b` | Muse Glimmer 30B | yes | yes | yes |
| Muse | `emis/muse-spark-1.2` | Muse Spark 1.2 | yes | yes | yes |
| Muse | `emis/muse-spark-1.1` | Muse Spark 1.1 | yes | yes | yes |
| MiniMax | `emis/minimax-m3.1-flash` | Minimax M3.1 Flash | yes | yes | yes |
| MiniMax | `emis/minimax-m3` | Minimax M3 | yes | yes | yes |
| MiniMax | `emis/minimax-m2.7` | Minimax M2.7 | yes | yes | no |
| MiniMax | `emis/minimax-m2.5` | Minimax M2.5 | yes | yes | no |
| MiniMax | `emis/minimax-m2.1` | Minimax M2.1 | yes | yes | no |
| MiniMax | `emis/minimax-m2` | Minimax M2 | yes | yes | no |
| MiniMax | `emis/minimax-m1` | Minimax M1 | yes | yes | no |
| ByteDance Seed | `emis/seed-2-1-turbo` | Seed 2.1 Turbo | yes | yes | yes |
| ByteDance Seed | `emis/seed-2.0-code` | Seed 2.0 Code | yes | yes | yes |
| ByteDance Seed | `emis/seed-2.0-lite` | Seed 2.0 Lite | yes | yes | yes |
| ByteDance Seed | `emis/seed-2.0-mini` | Seed 2.0 Mini | yes | yes | yes |
| ByteDance Seed | `emis/seed-1.6-flash` | Seed 1.6 Flash | yes | yes | yes |
| ByteDance Seed | `emis/seed-1.6` | Seed 1.6 | yes | yes | yes |
| Xiaomi MiMo | `emis/mimo-v2.6-pro-ultraspeed` | Mimo V2.6 Pro Ultraspeed | yes | yes | yes |
| Xiaomi MiMo | `emis/mimo-v2.6-flash` | Mimo V2.6 Flash | yes | yes | yes |
| Xiaomi MiMo | `emis/mimo-v2.6-pro` | Mimo V2.6 Pro | yes | yes | yes |
| Xiaomi MiMo | `emis/mimo-v2.5-pro` | Mimo V2.5 Pro | yes | yes | no |
| Xiaomi MiMo | `emis/mimo-v2.5` | Mimo V2.5 | yes | yes | yes |
| Xiaomi MiMo | `emis/xiaomi-mimo-2.5` | Xiaomi MiMo 2.5 | yes | yes | yes |
| Aion | `emis/aion-3.5-mini` | Aion 3.5 Mini | yes | yes | no |
| Aion | `emis/aion-3.5` | Aion 3.5 | yes | yes | no |
| Aion | `emis/aion-3.0-mini` | Aion 3.0 Mini | yes | yes | no |
| Aion | `emis/aion-3.0` | Aion 3.0 | yes | yes | no |
| Aion | `emis/aion-2.0` | Aion 2.0 | yes | yes | no |
| Amazon Nova | `emis/nova-2-lite-v1` | Nova 2 Lite V1 | yes | yes | yes |
| Amazon Nova | `emis/nova-premier-v1` | Nova Premier V1 | yes | no | yes |
| Amazon Nova | `emis/nova-lite-v1` | Nova Lite V1 | yes | no | yes |
| Amazon Nova | `emis/nova-micro-v1` | Nova Micro V1 | yes | no | no |
| Amazon Nova | `emis/nova-pro-v1` | Nova Pro V1 | yes | no | yes |
| Google Gemma | `emis/gemma-4-26b-a4b-it` | Gemma 4 26B A4B | yes | yes | yes |
| Google Gemma | `emis/gemma-4-31b-it` | Gemma 4 31B | yes | yes | yes |
| Google Gemma | `emis/gemma-3-12b-it` | Gemma 3 12B | yes | no | yes |
| Google Gemma | `emis/gemma-3-27b-it` | Gemma 3 27B | yes | no | yes |
| Google Gemma | `emis/gemma-4-26b` | Gemma 4 26B | yes | no | yes |
| Meta Llama | `emis/llama-4-maverick` | Llama 4 Maverick | yes | no | yes |
| Meta Llama | `emis/llama-4-scout` | Llama 4 Scout | yes | no | yes |
| Meta Llama | `emis/llama-3.1-70b-instruct` | Llama 3.1 70B | yes | no | no |
| Meta Llama | `emis/llama-3.1-8b-instruct` | Llama 3.1 8B | yes | no | no |
| Meta Llama | `emis/meta-llama-3_3-70b-instruct` | Meta Llama 3 3 70b Instruct | yes | no | no |
| Laguna | `emis/laguna-s-2.1` | Laguna S 2.1 | yes | yes | no |
| Laguna | `emis/laguna-xs-2.1` | Laguna Xs 2.1 | yes | yes | no |
| Laguna | `emis/poolside-laguna-xs-2.1` | Poolside Laguna XS 2.1 | yes | no | no |
| Laguna | `emis/poolside-laguna-s-2.1` | Poolside Laguna S 2.1 | yes | no | no |
| Cohere Command | `emis/command-a-plus` | Command A Plus | yes | yes | yes |
| Cohere Command | `emis/command-r-08-2024` | Command R 08 2024 | yes | no | no |
| Cohere Command | `emis/command-r-plus-08-2024` | Command R Plus 08 2024 | yes | no | no |
| Fugu | `emis/fugu-ultra-v2` | Fugu Ultra V2 | yes | yes | yes |
| Fugu | `emis/fugu-max` | Fugu Max | yes | yes | yes |
| Fugu | `emis/fugu-ultra` | Fugu Ultra | yes | yes | yes |
| Hy | `emis/hy4-preview` | Hy4 Preview | yes | yes | no |
| Hy | `emis/hy3` | Hy3 | yes | yes | no |
| Hy | `emis/hy3-preview` | Hy3 Preview | yes | yes | no |
| inclusionAI Ling | `emis/ling-3.1-flash` | Ling 3.1 Flash | yes | yes | no |
| inclusionAI Ling | `emis/ling-3.0-flash-vl` | Ling 3.0 Flash VL | yes | yes | yes |
| inclusionAI Ling | `emis/ling-3.0-flash` | Ling 3.0 Flash | yes | yes | no |
| Liquid LFM | `emis/lfm-2.5-24b-a2b` | LFM 2.5 24B A2B | yes | yes | no |
| Liquid LFM | `emis/lfm-2.5-2.6b-free` | LFM 2.5 2.6B Free | yes | yes | no |
| Liquid LFM | `emis/liquid-lfm-2.5-2.6b` | Liquid Lfm 2.5 2.6b | yes | no | no |
| Mercury | `emis/mercury-3` | Mercury 3 | yes | yes | no |
| Mercury | `emis/mercury-2.5` | Mercury 2.5 | yes | yes | no |
| Mercury | `emis/mercury-2` | Mercury 2 | yes | yes | no |
| Pareto | `emis/pareto-26.10` | Pareto 26.10 | yes | no | yes |
| Pareto | `emis/pareto-latest` | Pareto | yes | no | yes |
| Pareto | `emis/pareto-26.9` | Pareto 26.9 | yes | no | yes |
| StepFun Step | `emis/step-5-preview` | Step 5 Preview | yes | yes | yes |
| StepFun Step | `emis/step-3.7-flash` | Step 3.7 Flash | yes | yes | yes |
| StepFun Step | `emis/step-3.5-flash` | Step 3.5 Flash | yes | yes | no |
| Upstage Solar | `emis/solar-mini4` | Solar Mini4 | yes | yes | no |
| Upstage Solar | `emis/solar-pro4` | Solar Pro4 | yes | yes | no |
| Upstage Solar | `emis/solar-pro-3` | Solar Pro 3 | yes | yes | no |
| Dots | `emis/dots-3-note-preview-free` | Dots 3 Note Preview Free | yes | yes | yes |
| Dots | `emis/dots-studio-dots-3-note-preview` | Dots Studio Dots 3 Note Preview | yes | no | no |
| Inkling | `emis/inkling-small` | Inkling Small | yes | yes | yes |
| Inkling | `emis/inkling` | Inkling | yes | yes | yes |
| Noctis | `emis/noctis-auto-paid` | Noctis Auto Paid | yes | no | no |
| Noctis | `emis/noctis-auto` | Noctis Auto | yes | no | no |
| OpenAI (alias) | `emis/openai` | OpenAI | yes | no | no |
| OpenAI (alias) | `emis/openai-fast` | OpenAI Fast | yes | no | no |
| Beam | `emis/beam-1.0-501b-a23b` | Beam 1.0 501B A23B | yes | yes | no |
| Devstral | `emis/devstral-2512` | Devstral 2512 | yes | no | no |
| Ember | `emis/ember-1` | Ember 1 | yes | yes | yes |
| Flint | `emis/flint-v1.0-free` | Flint V1.0 Free | yes | yes | no |
| Glimpse | `emis/glimpse` | Glimpse | yes | yes | yes |
| IBM Granite | `emis/granite-4.2-8b` | Granite 4.2 8B | yes | yes | no |
| Jev | `emis/jev-router` | Jev Router | yes | yes | yes |
| Longcat | `emis/longcat-2.0` | Longcat 2.0 | yes | yes | no |
| Nex | `emis/nex-n2.5-pro` | Nex N2.5 Pro | yes | yes | yes |
| Nexum | `emis/nexum-router` | Nexum Router | yes | no | no |
| North | `emis/north-mini-code-free` | North Mini Code Free | yes | yes | no |
| Perceptron | `emis/perceptron-mk1.5` | Perceptron Mk1.5 | yes | yes | yes |
| Reka | `emis/reka-edge` | Reka Edge | yes | no | yes |
| Relace | `emis/relace-search` | Relace Search | yes | no | no |
| Sakana | `emis/sakana-namazu` | Sakana Namazu | yes | yes | yes |
| Ternary | `emis/ternary-bonsai-2-27b` | Ternary Bonsai 2 27B | yes | yes | yes |
| Trinity | `emis/trinity-large-thinking` | Trinity Large Thinking | yes | yes | no |
| Voxtral | `emis/voxtral-small-24b-2507` | Voxtral Small 24B 2507 | yes | no | no |
| Xing | `emis/xing4.0-29b-a4b-free` | Xing4.0 29B A4B Free | yes | yes | no |

Capability flags are the catalog's; MetaCode doesn't guess missing ones.

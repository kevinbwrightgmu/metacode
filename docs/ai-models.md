# AI models: what MetaCode can use

Every AI feature (AI Coding, Ask MetaCode, Import Data, Analyze CSV, the AI
Scraper, the desktop app and the AI Coding Lab) reaches models through
providers configured **on the server**; keys never reach the browser. This
page lists the providers, how the model list is built and checked, and the
models in the current catalog.

## Providers

| Provider | Used by | Needs | Formats and capabilities |
|---|---|---|---|
| **MetaCode AI service** (EMIS, an OpenAI-compatible gateway) | every AI feature; the Lab's `metacode` provider | `EMIS_API_KEY` (one or several, rotated), `EMIS_BASE_URL` | OpenAI chat format; Anthropic Messages format (translated by MetaCode's server — the service itself has `GET /v1/models` and `POST /v1/chat/completions`); streaming (SSE); tool calling and attachments per model (catalog flags); no embeddings, no fine-tuning |
| **OpenAI / OpenAI-compatible API** | the AI Coding Lab only (`openai` provider) | `AI_LAB_OPENAI_API_KEY`; optional `AI_LAB_OPENAI_BASE_URL` (https), `AI_LAB_OPENAI_MODELS` | chat, streaming, JSON mode when asked; fine-tuning only with `AI_LAB_FINE_TUNING=on` and `AI_LAB_FINE_TUNE_MODELS` |

No embeddings provider and no native Anthropic or Google API adapter are
integrated (Anthropic-format requests are translated by MetaCode's server and
sent to the AI service as chat completions).

## How the list is built and checked

1. **The catalog**: `emis-models.json` (or the file `EMIS_MODELS_FILE` names)
   — the AI service's OpenCode config, `https://emis.zxs-is-very.cool/cli/opencode.json`,
   generated live from its catalog and filtered to models with tool calling —
   in OpenCode's format: ids, names and capability flags (`tool_call`,
   `reasoning`, `attachment`, optional `limit.context` / `limit.output`).
   Edits apply without a restart. Without the file, the service's live list
   (`GET {EMIS_BASE_URL}/models`) is the catalog. Download the file again to update it.
2. **Checked against the service's own list.** When the catalog file is used,
   MetaCode also reads the service's live list (cached 5 minutes) and marks
   each model: offered now, **not offered now**, or unknown (the list couldn't
   be read). Models are marked, not hidden: the catalog is the operator's
   choice, and a service may answer models it leaves out of its list.
   Settings → AI models shows *"— not offered by the AI service now"* and a
   summary; the Lab's Models page has an **Offered now** column. AI requests
   never wait for this check (the Lab uses the cached result).
3. **Validation.** A request for a model id that isn't in the catalog never
   reaches the service: the main AI routes use the default model instead (and
   log it once); the Lab refuses it (`model_unavailable`). A request needing a
   capability the catalog says a model lacks (tools, attachments) is refused
   before it's sent. Ids are sanitized; names are shown as plain text.
4. **Failures.** A used-up budget (429; prompts and/or tokens per day, week or
   month) rests the key until the window rolls over; a 429 while the budget
   lasts, or a model the service can't run right now, switches to the closest
   similar model (`model-match.js`, on by default, switchable in Settings); a missing key, a wrong address or a rejected key
   give a clear message naming the setting to fix; unknown capabilities are
   shown as unknown, never assumed. Context windows are unknown unless the
   catalog states them (the Lab then uses a conservative budget).

## Models by status

| Status | Which | What it takes |
|---|---|---|
| Integrated and usable | the catalog's models that the service lists (Settings shows them unmarked) | `EMIS_API_KEY` set |
| Listed in the catalog but not offered now | marked in Settings and the Lab | nothing to configure; check with the service's operator, or remove them from `emis-models.json` |
| Offered by the service but not in the catalog | anything `GET /models` lists beyond the file — models without tool calling, which `/cli/opencode.json` leaves out (e.g. `gpt-oss-120b`, the example in the service's documentation) | add it to `emis-models.json` with `"tool_call": false` (or remove the file to use the live list as is) |
| Need more credentials | the Lab's OpenAI-compatible provider; fine-tuning | `AI_LAB_OPENAI_API_KEY` (+ base URL, model list); `AI_LAB_FINE_TUNING=on` |
| Not supported | embeddings; images and videos in answers (the service makes them inside a chat completion; MetaCode's features use the text and show `[image omitted]`); image, audio and video models (filtered out of chat pickers); native Anthropic/Google APIs as separate providers | new provider adapters |

**Supportable without architectural changes:** any OpenAI-compatible
endpoint, through the Lab's `openai` provider (`AI_LAB_OPENAI_BASE_URL`), one
at a time — for example OpenRouter, Groq, Together, Mistral, DeepSeek,
Google's OpenAI-compatible Gemini endpoint, or a local vLLM / Ollama /
LM Studio server. `EMIS_BASE_URL` can likewise point at another
OpenAI-compatible gateway for the whole app.

## The current catalog

`emis-models.json` as committed in `378c897` (2026-10-22): **347 models**, all
with tool calling (the AI service's `/cli/opencode.json`, which the file is,
lists only those), 266 with reasoning, 213 accepting attachments; none states a
context window or output limit. With `EMIS_MODEL` empty the default is
`claude-opus-5.5` (`PREFERRED_DEFAULT_MODELS` in `server.js`); the file's first
entry, `flint-v1.0-free`, would be used only without it — the file's order is
the service's.

Twelve ids of the previous catalog are now spelled with dots: `claude-opus-5-5`
→ `claude-opus-5.5`, `claude-sonnet-5-5` → `claude-sonnet-5.5`,
`claude-opus-4-6` → `claude-opus-4.6`, `gpt-6-1-sol` → `gpt-6.1-sol`, `gpt-5-6`
→ `gpt-5.6-sol`, `gpt-5-5` → `gpt-5.5`, `gemini-3-8-flash` → `gemini-3.8-flash`,
`kimi-k2-6` → `kimi-k2.6`, `grok-4-7` → `grok-4.7`, `qwen-3-7-max` →
`qwen-3.7-max`, `glm-5-3` → `glm-5.3`, `glm-5-3-flash` → `glm-5.3-flash`. A
model picked under an old spelling is still that model (`renamedModel()` in
`model-match.js`: "-" or "_" between two digits reads as "."), in Settings,
the Lab and `EMIS_MODEL`. Some models are listed under both spellings
(`claude-opus-4.8` / `claude-opus-4-8`, `claude-opus-4.7` / `claude-opus-4-7`,
`claude-fable-5.1` / `claude-fable-5-1`, `deepseek-v4.1-flash` /
`deepseek-v4-1-flash`), and two different ids share the name "Deepseek V4
Flash" (`deepseek-v4-flash`, `deepseek-v4-flash-latest`); pickers add the id
to tell them apart, and a rate-limited model is answered by a similar model
before its other spelling. `openai`, `openai-fast` and the `…-latest` ids are
aliases whose underlying model the service chooses.

Families (by id): OpenAI GPT 65, Alibaba Qwen 54, Anthropic Claude 22,
DeepSeek 19, Zhipu GLM 18, Google Gemini 17, Mistral 17, xAI Grok 12, NVIDIA
Nemotron 10, Moonshot Kimi 8, Muse 8, MiniMax 7, ByteDance Seed 6, Xiaomi
MiMo 6, and fewer than 6 each for the rest.

Whether each model is offered **right now** can only be read from the service
with the server's key: open **Settings → AI models → ↻ Refresh list** (or the
Lab's **Models** page) on the server. The list below is the catalog, not a
verified availability list. To update it, download
`https://emis.zxs-is-very.cool/cli/opencode.json` again and save it as
`emis-models.json`.

| Family (by id) | Id | Name | Tools | Reasoning | Attachments |
|---|---|---|---|---|---|
| OpenAI GPT | `gpt-6.1-sol-pro` | GPT-6.1 Sol Pro | yes | yes | yes |
| OpenAI GPT | `gpt-6.1-sol` | GPT-6.1 Sol | yes | yes | yes |
| OpenAI GPT | `gpt-6-luna-pro` | GPT-6 Luna Pro | yes | yes | yes |
| OpenAI GPT | `gpt-6-luna` | GPT-6 Luna | yes | yes | yes |
| OpenAI GPT | `gpt-6-sol-pro` | GPT-6 Sol Pro | yes | yes | yes |
| OpenAI GPT | `gpt-6-sol` | GPT-6 Sol | yes | yes | yes |
| OpenAI GPT | `gpt-astra-latest` | GPT Astra | yes | yes | yes |
| OpenAI GPT | `gpt-sol-latest` | GPT Sol | yes | yes | yes |
| OpenAI GPT | `gpt-terra-latest` | GPT Terra | yes | yes | yes |
| OpenAI GPT | `gpt-luna-latest` | GPT Luna | yes | yes | yes |
| OpenAI GPT | `gpt-6-astra` | GPT-6 Astra | yes | yes | yes |
| OpenAI GPT | `gpt-6-astra-pro` | GPT-6 Astra Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5.6-luna-pro` | GPT-5.6 Luna Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5.6-terra-pro` | GPT-5.6 Terra Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5.6-terra` | GPT-5.6 Terra | yes | yes | yes |
| OpenAI GPT | `gpt-5.6-sol-pro` | GPT-5.6 Sol Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5.6-sol` | GPT-5.6 Sol | yes | yes | yes |
| OpenAI GPT | `gpt-chat-latest` | GPT Chat | yes | no | yes |
| OpenAI GPT | `gpt-mini-latest` | GPT Mini | yes | yes | yes |
| OpenAI GPT | `gpt-5.5-pro` | GPT-5.5 Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5.5` | GPT-5.5 | yes | yes | yes |
| OpenAI GPT | `gpt-5.4-nano` | GPT-5.4 Nano | yes | yes | yes |
| OpenAI GPT | `gpt-5.4-pro` | GPT-5.4 Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5.4` | GPT-5.4 | yes | yes | yes |
| OpenAI GPT | `gpt-5.3-codex` | GPT-5.3 Codex | yes | yes | yes |
| OpenAI GPT | `gpt-5.2-codex` | GPT-5.2 Codex | yes | yes | yes |
| OpenAI GPT | `gpt-5.2-chat` | GPT-5.2 Chat | yes | no | yes |
| OpenAI GPT | `gpt-5.2-pro` | GPT-5.2 Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5.2` | GPT-5.2 | yes | yes | yes |
| OpenAI GPT | `gpt-5.1-codex-max` | GPT-5.1 Codex Max | yes | yes | yes |
| OpenAI GPT | `gpt-5.1` | GPT-5.1 | yes | yes | yes |
| OpenAI GPT | `gpt-5.1-codex` | GPT-5.1 Codex | yes | yes | yes |
| OpenAI GPT | `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini | yes | yes | yes |
| OpenAI GPT | `gpt-5-pro` | GPT-5 Pro | yes | yes | yes |
| OpenAI GPT | `gpt-5` | GPT-5 | yes | yes | yes |
| OpenAI GPT | `gpt-5-mini` | GPT-5 Mini | yes | yes | yes |
| OpenAI GPT | `gpt-5-nano` | GPT-5 Nano | yes | yes | yes |
| OpenAI GPT | `gpt-oss-20b` | GPT-OSS 20B | yes | yes | no |
| OpenAI GPT | `o3-pro` | O3 Pro | yes | yes | yes |
| OpenAI GPT | `o4-mini-high` | O4 Mini High | yes | yes | yes |
| OpenAI GPT | `o3` | O3 | yes | yes | yes |
| OpenAI GPT | `o4-mini` | O4 Mini | yes | yes | yes |
| OpenAI GPT | `gpt-4.1` | GPT-4.1 | yes | no | yes |
| OpenAI GPT | `gpt-4.1-mini` | GPT-4.1 Mini | yes | no | yes |
| OpenAI GPT | `gpt-4.1-nano` | GPT-4.1 Nano | yes | no | yes |
| OpenAI GPT | `o3-mini-high` | O3 Mini High | yes | yes | no |
| OpenAI GPT | `o3-mini` | O3 Mini | yes | yes | no |
| OpenAI GPT | `o1` | O1 | yes | yes | yes |
| OpenAI GPT | `gpt-4o-2024-11-20` | GPT 4o 2024 11 20 | yes | no | yes |
| OpenAI GPT | `gpt-4o-2024-08-06` | GPT 4o 2024 08 06 | yes | no | yes |
| OpenAI GPT | `gpt-4o-mini` | GPT 4o Mini | yes | no | yes |
| OpenAI GPT | `gpt-4o-mini-2024-07-18` | GPT 4o Mini 2024 07 18 | yes | no | yes |
| OpenAI GPT | `gpt-4o` | GPT 4o | yes | no | yes |
| OpenAI GPT | `gpt-4o-2024-05-13` | GPT 4o 2024 05 13 | yes | no | yes |
| OpenAI GPT | `gpt-4-turbo` | GPT-4 Turbo | yes | no | yes |
| OpenAI GPT | `gpt-3.5-turbo-0613` | GPT-3.5 Turbo 0613 | yes | no | no |
| OpenAI GPT | `gpt-3.5-turbo-16k` | GPT-3.5 Turbo 16k | yes | no | no |
| OpenAI GPT | `gpt-3.5-turbo` | GPT-3.5 Turbo | yes | no | no |
| OpenAI GPT | `gpt-4` | GPT-4 | yes | no | no |
| OpenAI GPT | `gpt-5-chat-2` | GPT 5 Chat 2 | yes | yes | yes |
| OpenAI GPT | `gpt-5.4-mini-kb-curate` | GPT 5.4 Mini Kb Curate | yes | yes | yes |
| OpenAI GPT | `gpt-5.2_critique` | GPT 5.2 Critique | yes | yes | yes |
| OpenAI GPT | `gpt-5-chat` | GPT-5 Chat | yes | yes | yes |
| OpenAI GPT | `gpt-5-kiara` | GPT 5 Kiara | yes | yes | yes |
| OpenAI GPT | `gpt-oss` | GPT OSS | yes | yes | no |
| Alibaba Qwen | `qwen-3.8-max-prime` | Qwen 3.8 Max Prime | yes | yes | yes |
| Alibaba Qwen | `qwen-3.8-omni-flash` | Qwen 3.8 Omni Flash | yes | yes | yes |
| Alibaba Qwen | `qwen-3.8-max-0902` | Qwen 3.8 Max 0902 | yes | yes | yes |
| Alibaba Qwen | `qwen-3.8-flash` | Qwen 3.8 Flash | yes | yes | yes |
| Alibaba Qwen | `qwen-3.8-27b` | Qwen 3.8 27B | yes | yes | yes |
| Alibaba Qwen | `qwen-3.8-2.4t-a95b` | Qwen 3.8 2.4t A95B | yes | yes | no |
| Alibaba Qwen | `qwen-3.7-flash` | Qwen 3.7 Flash | yes | yes | yes |
| Alibaba Qwen | `qwen-3.7-plus` | Qwen 3.7 Plus | yes | yes | yes |
| Alibaba Qwen | `qwen-3.7-max` | Qwen 3.7 Max | yes | yes | no |
| Alibaba Qwen | `qwen-3.5-plus-20260420` | Qwen 3.5 Plus 20260420 | yes | yes | yes |
| Alibaba Qwen | `qwen-3.6-flash` | Qwen 3.6 Flash | yes | yes | yes |
| Alibaba Qwen | `qwen-3.6-35b-a3b` | Qwen 3.6 35B A3B | yes | yes | yes |
| Alibaba Qwen | `qwen-3.6-27b` | Qwen 3.6 27B | yes | yes | yes |
| Alibaba Qwen | `qwen-3.6-plus` | Qwen 3.6 Plus | yes | yes | yes |
| Alibaba Qwen | `qwen-3.5-9b` | Qwen 3.5 9B | yes | yes | yes |
| Alibaba Qwen | `qwen-3.5-35b-a3b` | Qwen 3.5 35B A3B | yes | yes | yes |
| Alibaba Qwen | `qwen-3.5-27b` | Qwen 3.5 27B | yes | yes | yes |
| Alibaba Qwen | `qwen-3.5-122b-a10b` | Qwen 3.5 122B A10B | yes | yes | yes |
| Alibaba Qwen | `qwen-3.5-flash-02-23` | Qwen 3.5 Flash 02 23 | yes | yes | yes |
| Alibaba Qwen | `qwen-3.5-plus-02-15` | Qwen 3.5 Plus 02 15 | yes | yes | yes |
| Alibaba Qwen | `qwen-3.5-397b-a17b` | Qwen 3.5 397B A17B | yes | yes | yes |
| Alibaba Qwen | `qwen-3-coder-next` | Qwen 3 Coder Next | yes | no | no |
| Alibaba Qwen | `qwen-3-vl-8b-instruct` | Qwen 3 VL 8B | yes | no | yes |
| Alibaba Qwen | `qwen-3-vl-30b-a3b-thinking` | Qwen 3 VL 30B A3B Thinking | yes | yes | yes |
| Alibaba Qwen | `qwen-3-vl-30b-a3b-instruct` | Qwen 3 VL 30B A3B | yes | no | yes |
| Alibaba Qwen | `qwen-3-vl-235b-a22b-instruct` | Qwen 3 VL 235B A22B | yes | no | yes |
| Alibaba Qwen | `qwen-3-coder-flash` | Qwen 3 Coder Flash | yes | no | no |
| Alibaba Qwen | `qwen-3-next-80b-a3b-thinking` | Qwen 3 Next 80B A3B Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3-next-80b-a3b-instruct` | Qwen 3 Next 80B A3B | yes | no | no |
| Alibaba Qwen | `qwen-3-coder-30b-a3b-instruct` | Qwen 3 Coder 30B A3B | yes | no | no |
| Alibaba Qwen | `qwen-3-30b-a3b-instruct-2507` | Qwen 3 30B A3B 2507 | yes | no | no |
| Alibaba Qwen | `qwen-3-235b-a22b-thinking-2507` | Qwen 3 235B A22B Thinking 2507 | yes | yes | no |
| Alibaba Qwen | `qwen-3-coder` | Qwen 3 Coder | yes | no | no |
| Alibaba Qwen | `qwen-3-235b-a22b-2507` | Qwen 3 235B A22B 2507 | yes | no | no |
| Alibaba Qwen | `qwen-3-30b-a3b` | Qwen 3 30B A3B | yes | yes | no |
| Alibaba Qwen | `qwen-3-14b` | Qwen 3 14B | yes | yes | no |
| Alibaba Qwen | `qwen-3-32b` | Qwen 3 32B | yes | yes | no |
| Alibaba Qwen | `qwen-plus` | Qwen Plus | yes | no | no |
| Alibaba Qwen | `qwen-2.5-7b-instruct` | Qwen 2.5 7B | yes | no | no |
| Alibaba Qwen | `qwen-2.5-72b-instruct` | Qwen 2.5 72B | yes | no | no |
| Alibaba Qwen | `qwen-3.5-plus` | Qwen 3.5 Plus | yes | yes | no |
| Alibaba Qwen | `qwen-3.5-plus-thinking` | Qwen 3.5 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.6-plus-thinking` | Qwen 3.6 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.7-plus-thinking` | Qwen 3.7 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.6-max-preview` | Qwen 3.6 Max Preview | yes | yes | no |
| Alibaba Qwen | `qwen-3.6-max-preview-thinking` | Qwen 3.6 Max Preview Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.7-max-thinking` | Qwen 3.7 Max Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.8-max` | Qwen 3.8 Max | yes | yes | no |
| Alibaba Qwen | `qwen-3.8-max-thinking` | Qwen 3.8 Max Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.5-omni-plus` | Qwen 3.5 Omni Plus | yes | yes | yes |
| Alibaba Qwen | `qwen3.5-397b-a17b` | Qwen3.5 397b A17b | yes | yes | no |
| Alibaba Qwen | `qwen3.6-27b` | Qwen3.6 27b | yes | yes | no |
| Alibaba Qwen | `qwen3.5-9b` | Qwen3.5 9b | yes | yes | no |
| Alibaba Qwen | `qwen2.5-vl-72b-instruct` | Qwen2.5 VL 72b Instruct | yes | no | yes |
| Anthropic Claude | `claude-haiku-5.5` | Claude Haiku 5.5 | yes | yes | yes |
| Anthropic Claude | `claude-sonnet-5.5` | Claude Sonnet 5.5 | yes | yes | yes |
| Anthropic Claude | `claude-opus-5.5` | Claude Opus 5.5 | yes | yes | yes |
| Anthropic Claude | `claude-fable-5.1` | Claude Fable 5.1 | yes | yes | yes |
| Anthropic Claude | `claude-opus-5` | Claude Opus 5 | yes | yes | yes |
| Anthropic Claude | `claude-sonnet-5` | Claude Sonnet 5 | yes | yes | yes |
| Anthropic Claude | `claude-fable-latest` | Claude Fable | yes | yes | yes |
| Anthropic Claude | `claude-fable-5` | Claude Fable 5 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4.8` | Claude Opus 4.8 | yes | yes | yes |
| Anthropic Claude | `claude-haiku-latest` | Claude Haiku | yes | yes | yes |
| Anthropic Claude | `claude-sonnet-latest` | Claude Sonnet | yes | yes | yes |
| Anthropic Claude | `claude-opus-latest` | Claude Opus | yes | yes | yes |
| Anthropic Claude | `claude-opus-4.7` | Claude Opus 4.7 | yes | yes | yes |
| Anthropic Claude | `claude-sonnet-4.6` | Claude Sonnet 4.6 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4.6` | Claude Opus 4.6 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4.5` | Claude Opus 4.5 | yes | yes | yes |
| Anthropic Claude | `claude-haiku-4.5` | Claude Haiku 4.5 | yes | yes | yes |
| Anthropic Claude | `claude-sonnet-4.5` | Claude Sonnet 4.5 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4.1` | Claude Opus 4.1 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4-8` | Claude Opus 4.8 | yes | yes | yes |
| Anthropic Claude | `claude-fable-5-1` | Claude Fable 5.1 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4-7` | Claude Opus 4.7 | yes | yes | yes |
| DeepSeek | `deepseek-v4.1-flash-1017` | Deepseek V4.1 Flash 1017 | yes | yes | yes |
| DeepSeek | `deepseek-pro-latest` | Deepseek Pro | yes | yes | no |
| DeepSeek | `deepseek-flash-latest` | Deepseek Flash | yes | yes | yes |
| DeepSeek | `deepseek-v4.1-flash` | Deepseek V4.1 Flash | yes | yes | yes |
| DeepSeek | `deepseek-v4-flash-vision-exp` | Deepseek V4 Flash Vision Exp | yes | yes | yes |
| DeepSeek | `deepseek-v4-pro-0813` | Deepseek V4 Pro 0813 | yes | yes | no |
| DeepSeek | `deepseek-v4-flash-latest` | Deepseek V4 Flash | yes | yes | no |
| DeepSeek | `deepseek-v4-flash-0731` | Deepseek V4 Flash 0731 | yes | yes | no |
| DeepSeek | `deepseek-v4-pro` | Deepseek V4 Pro | yes | yes | no |
| DeepSeek | `deepseek-v4-flash` | Deepseek V4 Flash | yes | yes | no |
| DeepSeek | `deepseek-v3.2` | Deepseek V3.2 | yes | yes | no |
| DeepSeek | `deepseek-v3.2-exp` | Deepseek V3.2 Exp | yes | yes | no |
| DeepSeek | `deepseek-v3.1-terminus` | Deepseek V3.1 Terminus | yes | yes | no |
| DeepSeek | `deepseek-chat-v3.1` | Deepseek Chat V3.1 | yes | yes | no |
| DeepSeek | `deepseek-r1-0528` | Deepseek R1 0528 | yes | yes | no |
| DeepSeek | `deepseek-chat-v3-0324` | Deepseek Chat V3 0324 | yes | no | no |
| DeepSeek | `deepseek-chat` | Deepseek Chat | yes | no | no |
| DeepSeek | `deepseek-v4-1-flash` | Deepseek V4 1 Flash | yes | yes | no |
| DeepSeek | `deepseek-v4-flash-0731-turbo` | DeepSeek V4 Flash (0731) | yes | yes | no |
| Zhipu GLM | `glm-5.3-prime` | GLM 5.3 Prime | yes | yes | no |
| Zhipu GLM | `glm-5.3-flashx` | GLM 5.3 Flashx | yes | yes | yes |
| Zhipu GLM | `glm-flash-latest` | GLM Flash | yes | yes | yes |
| Zhipu GLM | `glm-5.3-flash` | GLM 5.3 Flash | yes | yes | yes |
| Zhipu GLM | `glm-latest` | GLM | yes | yes | no |
| Zhipu GLM | `glm-5.3` | GLM 5.3 | yes | yes | no |
| Zhipu GLM | `glm-5.2` | GLM 5.2 | yes | yes | no |
| Zhipu GLM | `glm-5.1` | GLM 5.1 | yes | yes | no |
| Zhipu GLM | `glm-5v-turbo` | GLM 5v Turbo | yes | yes | yes |
| Zhipu GLM | `glm-5-turbo` | GLM 5 Turbo | yes | yes | no |
| Zhipu GLM | `glm-5` | GLM 5 | yes | yes | no |
| Zhipu GLM | `glm-4.7-flash` | GLM 4.7 Flash | yes | yes | no |
| Zhipu GLM | `glm-4.7` | GLM 4.7 | yes | yes | no |
| Zhipu GLM | `glm-4.6v` | GLM 4.6v | yes | yes | yes |
| Zhipu GLM | `glm-4.6` | GLM 4.6 | yes | yes | no |
| Zhipu GLM | `glm-4.5v` | GLM 4.5v | yes | yes | yes |
| Zhipu GLM | `glm-4.5` | GLM 4.5 | yes | yes | no |
| Zhipu GLM | `glm-4.5-air` | GLM 4.5 Air | yes | yes | no |
| Google Gemini | `gemini-4-argon` | Gemini 4 Argon | yes | yes | yes |
| Google Gemini | `gemini-3.8-flash` | Gemini 3.8 Flash | yes | yes | yes |
| Google Gemini | `gemini-3.7-flash` | Gemini 3.7 Flash | yes | yes | yes |
| Google Gemini | `gemini-3.6-flash` | Gemini 3.6 Flash | yes | yes | yes |
| Google Gemini | `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | yes | yes | yes |
| Google Gemini | `gemini-3.5-flash` | Gemini 3.5 Flash | yes | yes | yes |
| Google Gemini | `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | yes | yes | yes |
| Google Gemini | `gemini-pro-latest` | Gemini Pro | yes | yes | yes |
| Google Gemini | `gemini-flash-latest` | Gemini Flash | yes | yes | yes |
| Google Gemini | `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | yes | yes | yes |
| Google Gemini | `gemini-3.1-pro-preview-customtools` | Gemini 3.1 Pro Preview Customtools | yes | yes | yes |
| Google Gemini | `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | yes | yes | yes |
| Google Gemini | `gemini-3-flash-preview` | Gemini 3 Flash Preview | yes | yes | yes |
| Google Gemini | `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | yes | yes | yes |
| Google Gemini | `gemini-2.5-flash` | Gemini 2.5 Flash | yes | yes | yes |
| Google Gemini | `gemini-2.5-pro` | Gemini 2.5 Pro | yes | yes | yes |
| Google Gemini | `gemini-2.5-pro-preview` | Gemini 2.5 Pro Preview | yes | yes | yes |
| Mistral | `mistral-large-4-0` | Mistral Large 4.0 | yes | yes | yes |
| Mistral | `mistral-medium-3-5` | Mistral Medium 3.5 | yes | yes | yes |
| Mistral | `ministral-14b-2512` | Ministral 14B 2512 | yes | no | yes |
| Mistral | `ministral-8b-2512` | Ministral 8B 2512 | yes | no | yes |
| Mistral | `ministral-3b-2512` | Ministral 3B 2512 | yes | no | yes |
| Mistral | `mistral-medium-3.1` | Mistral Medium 3.1 | yes | no | yes |
| Mistral | `codestral-2508` | Codestral 2508 | yes | no | no |
| Mistral | `mistral-small-3.2-24b-instruct` | Mistral Small 3.2 24B | yes | no | yes |
| Mistral | `mistral-medium-3` | Mistral Medium 3 | yes | no | yes |
| Mistral | `mistral-small-3.1-24b-instruct` | Mistral Small 3.1 24B | yes | no | yes |
| Mistral | `mistral-large-2407` | Mistral Large 2407 | yes | no | no |
| Mistral | `mistral-nemo` | Mistral Nemo | yes | no | no |
| Mistral | `mistral-large` | Mistral Large | yes | no | no |
| Mistral | `codestral-latest` | Codestral Latest | yes | no | no |
| Mistral | `mistral-small-3.2-24b-instruct-2506` | Mistral Small 3.2 24b Instruct 2506 | yes | no | no |
| Mistral | `mistral-nemo-instruct-2407` | Mistral Nemo Instruct 2407 | yes | no | no |
| Mistral | `mistral-7b-instruct-v0.3` | Mistral 7b Instruct V0.3 | yes | no | no |
| xAI Grok | `grok-4.7` | Grok 4.7 | yes | yes | yes |
| xAI Grok | `grok-4.6` | Grok 4.6 | yes | yes | yes |
| xAI Grok | `grok-4.5` | Grok 4.5 | yes | yes | yes |
| xAI Grok | `grok-latest` | Grok | yes | yes | yes |
| xAI Grok | `grok-build-0.1` | Grok Build 0.1 | yes | yes | yes |
| xAI Grok | `grok-4.3` | Grok 4.3 | yes | yes | yes |
| xAI Grok | `grok-4.20` | Grok 4.20 | yes | yes | yes |
| xAI Grok | `grok-4` | Grok 4 | yes | yes | yes |
| xAI Grok | `grok-4-fast` | Grok 4 Fast | yes | yes | yes |
| xAI Grok | `grok-3` | Grok 3 | yes | no | yes |
| xAI Grok | `grok-3-mini` | Grok 3 Mini | yes | yes | yes |
| xAI Grok | `grok-code-fast-1` | Grok Code Fast 1 | yes | no | yes |
| NVIDIA Nemotron | `nemotron-3.5-super-vl` | Nemotron 3.5 Super VL | yes | yes | yes |
| NVIDIA Nemotron | `nemotron-3.5-lightning` | Nemotron 3.5 Lightning | yes | yes | no |
| NVIDIA Nemotron | `nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra 550B A55B | yes | yes | no |
| NVIDIA Nemotron | `nemotron-3-nano-omni-30b-a3b-reasoning-free` | Nemotron 3 Nano Omni 30B A3B Reasoning Free | yes | yes | yes |
| NVIDIA Nemotron | `nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B A12B | yes | yes | no |
| NVIDIA Nemotron | `nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B A3B | yes | yes | no |
| NVIDIA Nemotron | `nvidia-nemotron-3-nano-omni-30b-a3b-reasoning` | Nvidia Nemotron 3 Nano Omni 30b A3b Reasoning | yes | yes | yes |
| NVIDIA Nemotron | `nvidia-nemotron-3-super-120b-a12b` | Nvidia Nemotron 3 Super 120b A12b | yes | yes | no |
| NVIDIA Nemotron | `nvidia-nemotron-3-ultra-550b-a55b` | Nvidia Nemotron 3 Ultra 550b A55b | yes | yes | no |
| NVIDIA Nemotron | `nvidia-nemotron-3.5-lightning` | Nvidia Nemotron 3.5 Lightning | yes | yes | no |
| Moonshot Kimi | `kimi-k3` | Kimi K3 | yes | yes | yes |
| Moonshot Kimi | `kimi-k2.7-code` | Kimi K2.7 Code | yes | yes | yes |
| Moonshot Kimi | `kimi-latest` | Kimi | yes | yes | yes |
| Moonshot Kimi | `kimi-k2.6` | Kimi K2.6 | yes | yes | yes |
| Moonshot Kimi | `kimi-k2.5` | Kimi K2.5 | yes | yes | yes |
| Moonshot Kimi | `kimi-k2-thinking` | Kimi K2 Thinking | yes | yes | no |
| Moonshot Kimi | `kimi-k2-0905` | Kimi K2 0905 | yes | no | no |
| Moonshot Kimi | `kimi-k2` | Kimi K2 | yes | no | no |
| Muse | `muse-spark-open` | Muse Spark Open | yes | yes | yes |
| Muse | `muse-wonder` | Muse Wonder | yes | yes | yes |
| Muse | `muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | yes | yes | yes |
| Muse | `muse-spark-1.3` | Muse Spark 1.3 | yes | yes | yes |
| Muse | `muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | yes | yes | yes |
| Muse | `muse-glimmer-30b` | Muse Glimmer 30B | yes | yes | yes |
| Muse | `muse-spark-1.2` | Muse Spark 1.2 | yes | yes | yes |
| Muse | `muse-spark-1.1` | Muse Spark 1.1 | yes | yes | yes |
| MiniMax | `minimax-m3.1-flash` | Minimax M3.1 Flash | yes | yes | yes |
| MiniMax | `minimax-m3` | Minimax M3 | yes | yes | yes |
| MiniMax | `minimax-m2.7` | Minimax M2.7 | yes | yes | no |
| MiniMax | `minimax-m2.5` | Minimax M2.5 | yes | yes | no |
| MiniMax | `minimax-m2.1` | Minimax M2.1 | yes | yes | no |
| MiniMax | `minimax-m2` | Minimax M2 | yes | yes | no |
| MiniMax | `minimax-m1` | Minimax M1 | yes | yes | no |
| ByteDance Seed | `seed-2-1-turbo` | Seed 2.1 Turbo | yes | yes | yes |
| ByteDance Seed | `seed-2.0-code` | Seed 2.0 Code | yes | yes | yes |
| ByteDance Seed | `seed-2.0-lite` | Seed 2.0 Lite | yes | yes | yes |
| ByteDance Seed | `seed-2.0-mini` | Seed 2.0 Mini | yes | yes | yes |
| ByteDance Seed | `seed-1.6-flash` | Seed 1.6 Flash | yes | yes | yes |
| ByteDance Seed | `seed-1.6` | Seed 1.6 | yes | yes | yes |
| Xiaomi MiMo | `mimo-v2.6-pro-ultraspeed` | Mimo V2.6 Pro Ultraspeed | yes | yes | yes |
| Xiaomi MiMo | `mimo-v2.6-flash` | Mimo V2.6 Flash | yes | yes | yes |
| Xiaomi MiMo | `mimo-v2.6-pro` | Mimo V2.6 Pro | yes | yes | yes |
| Xiaomi MiMo | `mimo-v2.5-pro` | Mimo V2.5 Pro | yes | yes | no |
| Xiaomi MiMo | `mimo-v2.5` | Mimo V2.5 | yes | yes | yes |
| Xiaomi MiMo | `xiaomi-mimo-2.5` | Xiaomi MiMo 2.5 | yes | yes | yes |
| Aion | `aion-3.5-mini` | Aion 3.5 Mini | yes | yes | no |
| Aion | `aion-3.5` | Aion 3.5 | yes | yes | no |
| Aion | `aion-3.0-mini` | Aion 3.0 Mini | yes | yes | no |
| Aion | `aion-3.0` | Aion 3.0 | yes | yes | no |
| Aion | `aion-2.0` | Aion 2.0 | yes | yes | no |
| Amazon Nova | `nova-2-lite-v1` | Nova 2 Lite V1 | yes | yes | yes |
| Amazon Nova | `nova-premier-v1` | Nova Premier V1 | yes | no | yes |
| Amazon Nova | `nova-lite-v1` | Nova Lite V1 | yes | no | yes |
| Amazon Nova | `nova-micro-v1` | Nova Micro V1 | yes | no | no |
| Amazon Nova | `nova-pro-v1` | Nova Pro V1 | yes | no | yes |
| Google Gemma | `gemma-4-26b-a4b-it` | Gemma 4 26B A4B | yes | yes | yes |
| Google Gemma | `gemma-4-31b-it` | Gemma 4 31B | yes | yes | yes |
| Google Gemma | `gemma-3-12b-it` | Gemma 3 12B | yes | no | yes |
| Google Gemma | `gemma-3-27b-it` | Gemma 3 27B | yes | no | yes |
| Google Gemma | `gemma-4-26b` | Gemma 4 26B | yes | no | yes |
| Meta Llama | `llama-4-maverick` | Llama 4 Maverick | yes | no | yes |
| Meta Llama | `llama-4-scout` | Llama 4 Scout | yes | no | yes |
| Meta Llama | `llama-3.1-70b-instruct` | Llama 3.1 70B | yes | no | no |
| Meta Llama | `llama-3.1-8b-instruct` | Llama 3.1 8B | yes | no | no |
| Meta Llama | `meta-llama-3_3-70b-instruct` | Meta Llama 3 3 70b Instruct | yes | no | no |
| Laguna | `laguna-s-2.1` | Laguna S 2.1 | yes | yes | no |
| Laguna | `laguna-xs-2.1` | Laguna Xs 2.1 | yes | yes | no |
| Laguna | `poolside-laguna-xs-2.1` | Poolside Laguna XS 2.1 | yes | no | no |
| Laguna | `poolside-laguna-s-2.1` | Poolside Laguna S 2.1 | yes | no | no |
| Cohere Command | `command-a-plus` | Command A Plus | yes | yes | yes |
| Cohere Command | `command-r-08-2024` | Command R 08 2024 | yes | no | no |
| Cohere Command | `command-r-plus-08-2024` | Command R Plus 08 2024 | yes | no | no |
| Fugu | `fugu-ultra-v2` | Fugu Ultra V2 | yes | yes | yes |
| Fugu | `fugu-max` | Fugu Max | yes | yes | yes |
| Fugu | `fugu-ultra` | Fugu Ultra | yes | yes | yes |
| Hy | `hy4-preview` | Hy4 Preview | yes | yes | no |
| Hy | `hy3` | Hy3 | yes | yes | no |
| Hy | `hy3-preview` | Hy3 Preview | yes | yes | no |
| inclusionAI Ling | `ling-3.1-flash` | Ling 3.1 Flash | yes | yes | no |
| inclusionAI Ling | `ling-3.0-flash-vl` | Ling 3.0 Flash VL | yes | yes | yes |
| inclusionAI Ling | `ling-3.0-flash` | Ling 3.0 Flash | yes | yes | no |
| Liquid LFM | `lfm-2.5-24b-a2b` | LFM 2.5 24B A2B | yes | yes | no |
| Liquid LFM | `lfm-2.5-2.6b-free` | LFM 2.5 2.6B Free | yes | yes | no |
| Liquid LFM | `liquid-lfm-2.5-2.6b` | Liquid Lfm 2.5 2.6b | yes | no | no |
| Mercury | `mercury-3` | Mercury 3 | yes | yes | no |
| Mercury | `mercury-2.5` | Mercury 2.5 | yes | yes | no |
| Mercury | `mercury-2` | Mercury 2 | yes | yes | no |
| Pareto | `pareto-26.10` | Pareto 26.10 | yes | no | yes |
| Pareto | `pareto-latest` | Pareto | yes | no | yes |
| Pareto | `pareto-26.9` | Pareto 26.9 | yes | no | yes |
| StepFun Step | `step-5-preview` | Step 5 Preview | yes | yes | yes |
| StepFun Step | `step-3.7-flash` | Step 3.7 Flash | yes | yes | yes |
| StepFun Step | `step-3.5-flash` | Step 3.5 Flash | yes | yes | no |
| Upstage Solar | `solar-mini4` | Solar Mini4 | yes | yes | no |
| Upstage Solar | `solar-pro4` | Solar Pro4 | yes | yes | no |
| Upstage Solar | `solar-pro-3` | Solar Pro 3 | yes | yes | no |
| Dots | `dots-3-note-preview-free` | Dots 3 Note Preview Free | yes | yes | yes |
| Dots | `dots-studio-dots-3-note-preview` | Dots Studio Dots 3 Note Preview | yes | no | no |
| Inkling | `inkling-small` | Inkling Small | yes | yes | yes |
| Inkling | `inkling` | Inkling | yes | yes | yes |
| Noctis | `noctis-auto-paid` | Noctis Auto Paid | yes | no | no |
| Noctis | `noctis-auto` | Noctis Auto | yes | no | no |
| OpenAI (alias) | `openai` | OpenAI | yes | no | no |
| OpenAI (alias) | `openai-fast` | OpenAI Fast | yes | no | no |
| Beam | `beam-1.0-501b-a23b` | Beam 1.0 501B A23B | yes | yes | no |
| Devstral | `devstral-2512` | Devstral 2512 | yes | no | no |
| Ember | `ember-1` | Ember 1 | yes | yes | yes |
| Flint | `flint-v1.0-free` | Flint V1.0 Free | yes | yes | no |
| Glimpse | `glimpse` | Glimpse | yes | yes | yes |
| IBM Granite | `granite-4.2-8b` | Granite 4.2 8B | yes | yes | no |
| Jev | `jev-router` | Jev Router | yes | yes | yes |
| Longcat | `longcat-2.0` | Longcat 2.0 | yes | yes | no |
| Nex | `nex-n2.5-pro` | Nex N2.5 Pro | yes | yes | yes |
| Nexum | `nexum-router` | Nexum Router | yes | no | no |
| North | `north-mini-code-free` | North Mini Code Free | yes | yes | no |
| Perceptron | `perceptron-mk1.5` | Perceptron Mk1.5 | yes | yes | yes |
| Reka | `reka-edge` | Reka Edge | yes | no | yes |
| Relace | `relace-search` | Relace Search | yes | no | no |
| Sakana | `sakana-namazu` | Sakana Namazu | yes | yes | yes |
| Ternary | `ternary-bonsai-2-27b` | Ternary Bonsai 2 27B | yes | yes | yes |
| Trinity | `trinity-large-thinking` | Trinity Large Thinking | yes | yes | no |
| Voxtral | `voxtral-small-24b-2507` | Voxtral Small 24B 2507 | yes | no | no |
| Xing | `xing4.0-29b-a4b-free` | Xing4.0 29B A4B Free | yes | yes | no |

Capability flags are the catalog's; MetaCode doesn't guess missing ones.

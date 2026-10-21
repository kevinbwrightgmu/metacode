# AI models: what MetaCode can use

Every AI feature (AI Coding, Ask MetaCode, Import Data, Analyze CSV, the AI
Scraper, the desktop app and the AI Coding Lab) reaches models through
providers configured **on the server**; keys never reach the browser. This
page lists the providers, how the model list is built and checked, and the
models in the current catalog.

## Providers

| Provider | Used by | Needs | Formats and capabilities |
|---|---|---|---|
| **MetaCode AI service** (EMIS, an OpenAI-compatible gateway) | every AI feature; the Lab's `metacode` provider | `EMIS_API_KEY` (one or several, rotated), `EMIS_BASE_URL` | OpenAI chat format; Anthropic Messages format (translated by the service); streaming (SSE); tool calling and attachments per model (catalog flags); no embeddings, no fine-tuning |
| **OpenAI / OpenAI-compatible API** | the AI Coding Lab only (`openai` provider) | `AI_LAB_OPENAI_API_KEY`; optional `AI_LAB_OPENAI_BASE_URL` (https), `AI_LAB_OPENAI_MODELS` | chat, streaming, JSON mode when asked; fine-tuning only with `AI_LAB_FINE_TUNING=on` and `AI_LAB_FINE_TUNE_MODELS` |

No embeddings provider and no native Anthropic or Google API adapter are
integrated (Anthropic-format requests go through the AI service).

## How the list is built and checked

1. **The catalog**: `emis-models.json` (or the file `EMIS_MODELS_FILE` names),
   in OpenCode's format: ids, names and capability flags (`tool_call`,
   `reasoning`, `attachment`, optional `limit.context` / `limit.output`).
   Edits apply without a restart. Without the file, the service's live list
   (`GET {EMIS_BASE_URL}/models`) is the catalog.
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
4. **Failures.** Rate limits (429, with the service's quota headers) pause the
   key or switch to the closest similar model (`model-match.js`, on by default,
   switchable in Settings); a missing key, a wrong address or a rejected key
   give a clear message naming the setting to fix; unknown capabilities are
   shown as unknown, never assumed. Context windows are unknown unless the
   catalog states them (the Lab then uses a conservative budget).

## Models by status

| Status | Which | What it takes |
|---|---|---|
| Integrated and usable | the catalog's models that the service lists (Settings shows them unmarked) | `EMIS_API_KEY` set |
| Listed in the catalog but not offered now | marked in Settings and the Lab | nothing to configure; check with the service's operator, or remove them from `emis-models.json` |
| Offered by the service but not in the catalog | anything `GET /models` lists beyond the file | add it to `emis-models.json` (or remove the file to use the live list as is) |
| Need more credentials | the Lab's OpenAI-compatible provider; fine-tuning | `AI_LAB_OPENAI_API_KEY` (+ base URL, model list); `AI_LAB_FINE_TUNING=on` |
| Not supported | embeddings; image, audio and video models (filtered out of chat pickers); native Anthropic/Google APIs as separate providers | new provider adapters |

**Supportable without architectural changes:** any OpenAI-compatible
endpoint, through the Lab's `openai` provider (`AI_LAB_OPENAI_BASE_URL`), one
at a time — for example OpenRouter, Groq, Together, Mistral, DeepSeek,
Google's OpenAI-compatible Gemini endpoint, or a local vLLM / Ollama /
LM Studio server. `EMIS_BASE_URL` can likewise point at another
OpenAI-compatible gateway for the whole app.

## The current catalog

`emis-models.json` as committed in `f924aa6` (2026-10-17): **64 models**, all
with tool calling, 50 with reasoning, 14 accepting attachments; none states a
context window or output limit. Three display names appear twice
(`GPT-5.6 Sol`: `gpt-5-6` and `gpt-5.6-sol`; `Qwen 3.7 Max`: `qwen-3-7-max`
and `qwen-3.7-max`; `GLM 5.3`: `glm-5-3` and `glm-5.3`) — likely aliases;
pickers add the id to tell them apart. `openai` and `openai-fast` are aliases
whose underlying model the service chooses.

Whether each model is offered **right now** can only be read from the service
with the server's key: open **Settings → AI models → Fetch Models** (or the
Lab's **Models** page) on the server. This audit could not reach the service
(no key in the audit environment), so the list below is the catalog, not a
verified availability list.

| Family (by id) | Id | Name | Tools | Reasoning | Attachments |
|---|---|---|---|---|---|
| Anthropic Claude | `claude-opus-5-5` | Claude Opus 5.5 | yes | yes | no |
| Anthropic Claude | `claude-sonnet-5-5` | Claude Sonnet 5.5 | yes | yes | no |
| Anthropic Claude | `claude-fable-5-1` | Claude Fable 5.1 | yes | yes | no |
| Anthropic Claude | `claude-sonnet-5` | Claude Sonnet 5 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4-8` | Claude Opus 4.8 | yes | yes | yes |
| Anthropic Claude | `claude-opus-5` | Claude Opus 5 | yes | yes | yes |
| Anthropic Claude | `claude-fable-5` | Claude Fable 5 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4-6` | Claude Opus 4.6 | yes | yes | yes |
| Anthropic Claude | `claude-opus-4-7` | Claude Opus 4.7 | yes | yes | yes |
| OpenAI GPT | `gpt-6-1-sol` | GPT-6.1 Sol | yes | yes | no |
| OpenAI GPT | `gpt-5-6` | GPT-5.6 Sol | yes | yes | no |
| OpenAI GPT | `gpt-5-5` | GPT-5.5 | yes | yes | no |
| OpenAI GPT | `gpt-6-astra` | GPT-6 Astra | yes | yes | no |
| OpenAI GPT | `gpt-5.6-sol` | GPT-5.6 Sol | yes | yes | yes |
| OpenAI GPT | `gpt-5.4-nano` | GPT-5.4 nano | yes | yes | yes |
| OpenAI GPT | `gpt-4.1` | GPT-4.1 | yes | no | yes |
| OpenAI GPT | `gpt-4o` | GPT-4o | yes | no | yes |
| Google Gemini | `gemini-3-8-flash` | Gemini 3.8 Flash | yes | yes | no |
| DeepSeek | `deepseek-v4-pro` | DeepSeek V4 Pro | yes | yes | no |
| DeepSeek | `deepseek-v4-flash` | Deepseek V4 Flash | yes | yes | no |
| DeepSeek | `deepseek-v4-1-flash` | Deepseek V4 1 Flash | yes | yes | no |
| DeepSeek | `deepseek-v4-flash-0731-turbo` | DeepSeek V4 Flash (0731) | yes | yes | no |
| Moonshot Kimi | `kimi-k3` | Kimi K3 | yes | yes | no |
| Moonshot Kimi | `kimi-k2-6` | Kimi K2.6 | yes | yes | no |
| xAI Grok | `grok-4-7` | Grok 4.7 | yes | yes | no |
| Alibaba Qwen | `qwen-3-7-max` | Qwen 3.7 Max | yes | yes | no |
| Alibaba Qwen | `qwen-3.5-plus` | Qwen 3.5 Plus | yes | yes | no |
| Alibaba Qwen | `qwen-3.5-plus-thinking` | Qwen 3.5 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.6-plus` | Qwen 3.6 Plus | yes | yes | no |
| Alibaba Qwen | `qwen-3.6-plus-thinking` | Qwen 3.6 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.7-plus` | Qwen 3.7 Plus | yes | yes | no |
| Alibaba Qwen | `qwen-3.7-plus-thinking` | Qwen 3.7 Plus Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.6-max-preview` | Qwen 3.6 Max Preview | yes | yes | no |
| Alibaba Qwen | `qwen-3.6-max-preview-thinking` | Qwen 3.6 Max Preview Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.7-max` | Qwen 3.7 Max | yes | yes | no |
| Alibaba Qwen | `qwen-3.7-max-thinking` | Qwen 3.7 Max Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.8-max` | Qwen 3.8 Max | yes | yes | no |
| Alibaba Qwen | `qwen-3.8-max-thinking` | Qwen 3.8 Max Thinking | yes | yes | no |
| Alibaba Qwen | `qwen-3.5-omni-plus` | Qwen 3.5 Omni Plus | yes | yes | yes |
| Alibaba Qwen | `qwen3.5-397b-a17b` | Qwen3.5 397b A17b | yes | yes | no |
| Alibaba Qwen | `qwen3.6-27b` | Qwen3.6 27b | yes | yes | no |
| Alibaba Qwen | `qwen3.5-9b` | Qwen3.5 9b | yes | yes | no |
| Alibaba Qwen | `qwen2.5-vl-72b-instruct` | Qwen2.5 VL 72b Instruct | yes | no | yes |
| Zhipu GLM | `glm-5-3` | GLM 5.3 | yes | yes | no |
| Zhipu GLM | `glm-5-3-flash` | GLM 5.3 Flash | yes | yes | no |
| Zhipu GLM | `glm-5.3` | GLM 5.3 | yes | yes | no |
| Xiaomi MiMo | `xiaomi-mimo-2.5` | Xiaomi MiMo 2.5 | yes | yes | yes |
| OpenAI (alias) | `openai` | OpenAI | yes | no | no |
| OpenAI (alias) | `openai-fast` | OpenAI Fast | yes | no | no |
| OpenAI open-weight | `gpt-oss` | GPT OSS | yes | yes | no |
| OpenAI open-weight | `gpt-oss-20b` | GPT OSS 20b | yes | yes | no |
| Mistral | `codestral-latest` | Codestral Latest | yes | no | no |
| Mistral | `mistral-small-3.2-24b-instruct-2506` | Mistral Small 3.2 24b Instruct 2506 | yes | no | no |
| Mistral | `mistral-nemo-instruct-2407` | Mistral Nemo Instruct 2407 | yes | no | no |
| Mistral | `mistral-7b-instruct-v0.3` | Mistral 7b Instruct V0.3 | yes | no | no |
| Meta Llama | `meta-llama-3_3-70b-instruct` | Meta Llama 3 3 70b Instruct | yes | no | no |
| Poolside | `poolside-laguna-xs-2.1` | Poolside Laguna XS 2.1 | yes | no | no |
| Poolside | `poolside-laguna-s-2.1` | Poolside Laguna S 2.1 | yes | no | no |
| NVIDIA Nemotron | `nvidia-nemotron-3-nano-omni-30b-a3b-reasoning` | Nvidia Nemotron 3 Nano Omni 30b A3b Reasoning | yes | yes | yes |
| NVIDIA Nemotron | `nvidia-nemotron-3-super-120b-a12b` | Nvidia Nemotron 3 Super 120b A12b | yes | yes | no |
| NVIDIA Nemotron | `nvidia-nemotron-3-ultra-550b-a55b` | Nvidia Nemotron 3 Ultra 550b A55b | yes | yes | no |
| NVIDIA Nemotron | `nvidia-nemotron-3.5-lightning` | Nvidia Nemotron 3.5 Lightning | yes | yes | no |
| Dots Studio | `dots-studio-dots-3-note-preview` | Dots Studio Dots 3 Note Preview | yes | no | no |
| Liquid AI | `liquid-lfm-2.5-2.6b` | Liquid Lfm 2.5 2.6b | yes | no | no |

Capability flags are the catalog's; MetaCode doesn't guess missing ones.

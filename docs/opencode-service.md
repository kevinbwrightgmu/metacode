# MetaCode's OpenCode service

Every AI feature (AI Coding, Ask MetaCode, Import Data, Analyze CSV, the AI
Scraper, the desktop app and the AI Coding Lab) reaches its models through
**MetaCode's OpenCode service**: a small program in `opencode/` that runs
beside MetaCode on the same computer. It is built on OpenCode's published npm
package `@opencode/ai` (2.1.4) and talks to two providers, **OpenCode Zen**
and the **AI gateway** (EMIS). MetaCode asks it for the model list and sends it
chat requests; everything that depends on a provider (keys, quotas, protocols,
the model catalog) lives in the service.

```
browser ─▶ MetaCode server.js (port 3000) ──http, access token──▶ OpenCode service (127.0.0.1:4097, opencode/server.mjs)
                                                                    ├─ OpenCode Zen ("opencode") ─▶ https://opencode.ai/inference/…
                                                                    └─ AI gateway ("emis")       ─▶ EMIS_BASE_URL/chat/completions
```

What the service does **not** do: it only lists models and answers chat
requests (OpenAI's chat format). It has no agent tools, files, shell or
sessions, and it doesn't run OpenCode's CLI or server. Tool definitions in a
request go to the model, and the model's tool calls come back to MetaCode; the
service never runs them.

MetaCode keeps what doesn't depend on a provider: checking requests, reading
answers, relaying streams, the default model, switching to the closest similar
model, model resting, AI Coding's batches, usage limits, the status page and
the Settings page.

- [1. Running it](#1-running-it)
- [2. Providers](#2-providers)
- [3. Model ids and the default model](#3-model-ids-and-the-default-model)
- [4. Settings](#4-settings)
- [5. The config file](#5-the-config-file)
- [6. The Zen model catalog](#6-the-zen-model-catalog)
- [7. HTTP API](#7-http-api)
- [8. Security](#8-security)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Files](#10-files)

## 1. Running it

| How | When | Who starts it |
|---|---|---|
| **pm2, two apps** | on a server ([deploy-vps.md](deploy-vps.md)) | `pm2 start ecosystem.config.cjs` starts `metacode` and `metacode-opencode`; the file sets `OPENCODE_SERVICE_MANAGED=off` for MetaCode |
| **Started by MetaCode** | `npm start` / `node server.js` | MetaCode, as a child process, when nothing answers at the default address within 1 second |
| **By hand** | development, tests | `node opencode/server.mjs` |

Its packages (`@opencode/ai`, `effect`) come with MetaCode's own `npm install`;
there is nothing else to install.

`OPENCODE_SERVICE_MANAGED` decides whether MetaCode starts it:

| Value | MetaCode starts the service… |
|---|---|
| `auto` (default) | only when `OPENCODE_SERVICE_URL` is unset (the default address) and `GET /health` doesn't answer within 1 second |
| `on` | also when `OPENCODE_SERVICE_URL` points at this computer |
| `off` | never: pm2 (or something else) runs it |

A service started by MetaCode writes to MetaCode's log, each line starting with
`[opencode]`. If it stops unexpectedly it is started again after 1 second,
then 2, 4… up to 60 seconds, and the last lines it printed say why (for
example *"The AI service couldn't start: its packages aren't installed. Run
"npm install" and restart MetaCode."*). It stops with MetaCode. The startup
banner's AI line says which kind is running: `AI → OpenCode service at
127.0.0.1:4097 (started by MetaCode) — …` or `(external)`.

When its port is taken, the service prints one line (*"port 4097 is in use —
another MetaCode OpenCode service is probably running …"*) and exits with code
1. Under pm2 that is retried, waiting a little longer each time, which covers a
previous copy that's still stopping.

**One `.env` for both.** The service reads MetaCode's `.env`, found the same
way MetaCode finds it (next to `server.js` first; `METACODE_ENV_FILE` is
honoured). **Settings → AI connection → Reload .env** reloads MetaCode's
settings and asks the service to reload too (`POST /v1/reload`): `.env`, the
config file, the gateway's models file and the catalog cache are read again,
key states are reset, and the Python worker is restarted once its requests
have finished. A service MetaCode started is restarted when its own settings
(`OPENCODE_SERVICE_*`) changed; under pm2, restart both apps for those:
`pm2 restart metacode metacode-opencode`.

**The access token.** MetaCode sends a token with every request, and the
service refuses requests without it. It is `OPENCODE_SERVICE_TOKEN` when that
is set (the same value for both), otherwise the file `opencode-data/token`
(`OPENCODE_SERVICE_DATA_DIR`), which whichever of the two starts first creates:
32 random bytes in hex, readable only by the user that runs them.

## 2. Providers

The two providers are set up in `opencode/opencode.json` ([section 5](#5-the-config-file)).
Only a provider that is **ready** (set up, with at least one model) offers
models. Settings → **AI providers** shows each one: ready or what's missing,
its keys and their quotas.

### OpenCode Zen (`opencode`)

The models the OpenCode team offers, at `https://opencode.ai/inference/…`.
Each model is reached the way OpenCode reaches it: OpenAI chat completions,
OpenAI Responses, Anthropic Messages, Gemini or Mistral, as its catalog entry
says ([section 6](#6-the-zen-model-catalog)).

- **Without a key** only the free models are offered (sent with the key
  `public`, as OpenCode does); the paid ones are hidden. In the catalog bundled
  on 2026-10-26 that is 9 models: Big Pickle, DeepSeek V4.1 Flash Free,
  GLM-5.3-Flash Free and six more ([ai-models.md](ai-models.md)). Settings shows
  *"Free models only — add OPENCODE_API_KEY for the others."*
- **With a key** (`OPENCODE_API_KEY`) all its models are offered (82 in the
  bundled catalog) and paid ones are billed to the key's account. To get one,
  sign in at <https://opencode.ai/auth>, add billing details and create an API
  key. The key is always passed explicitly, so an `OPENAI_API_KEY` or
  `ANTHROPIC_API_KEY` in the environment is never sent to Zen.
- **`OPENCODE_DISABLE_FREE_MODELS=1`** (or `true`, OpenCode's own setting)
  removes the free models. Without a key Zen then offers nothing, and Settings
  says *"Add OPENCODE_API_KEY to use OpenCode Zen (free models are switched off
  by OPENCODE_DISABLE_FREE_MODELS)."*
- **Limits.** When Zen says the free usage limit or the account's budget is
  reached (HTTP 429 `FreeUsageLimitError` / `BudgetLimitError`, or insufficient
  quota), the service rests the whole provider until the time Zen gave (at most
  an hour) and answers at once meanwhile, without calling Zen. MetaCode then
  answers with the closest similar model from the gateway, if the gateway is
  set up and switching is on.
  Any other 429 rate-limits just that model, and MetaCode rests that model.
- Every request carries `x-opencode-session` (a new `ses_…` id each time),
  `x-opencode-client: metacode` and `User-Agent: opencode/metacode/2.1.4/metacode`.

> **Privacy.** Free Zen models are rate-limited, and their providers may use
> prompts to improve their models during the free period. AI Coding sends the
> text of the posts it codes. Researchers working with sensitive posts should
> use paid models or the gateway, and switch the free models off with
> `OPENCODE_DISABLE_FREE_MODELS=1`. Without a gateway key and without
> `OPENCODE_MODEL`, the default model is Zen's first: a free model when there's
> no Zen key, and with a key the newest model, which can be a free one too.

### The AI gateway (`emis`, EMIS)

An OpenAI-compatible gateway (`https://emis.zxs-is-very.cool/v1`), shown as
"AI gateway".

- **Keys.** `EMIS_API_KEY`, starting with `emis-`. Keys are issued by hand:
  message @kawaii_zxs on Discord (user ID 1079096114273320971) and say what you
  need it for. Each key has a budget — a number of prompts and/or tokens it may
  spend per day, week or month; when it runs out the gateway answers 429 until
  the window rolls over. Several keys can be listed, comma-separated: they are
  used in turn, a key whose budget is used up rests until the reset time the
  gateway gave, and a rejected key is tried last. Placeholders such as
  `emis-...` or `your-key` are ignored with a warning. Without a key the
  gateway isn't offered (*"Add the gateway key to EMIS_API_KEY in .env, then
  Reload .env."*).
- **Quotas.** Every answer carries the key's standing (`X-RateLimit-Window`,
  `X-RateLimit-Limit-Prompts` / `-Tokens`, `X-RateLimit-Remaining-Prompts` /
  `-Tokens`, `X-RateLimit-Reset`), shown per key in Settings → AI providers. A
  429 that applies to the whole key (budget used up, or the key paused) moves
  on to the next key; a 429 for one model rate-limits that model. When every
  key is resting, the service answers at once, without calling the gateway,
  that the quota is used up (or that the gateway asked to pause) and when that
  ends.
- **Address.** `EMIS_BASE_URL` (default above): http(s), no user name or
  password in it; Settings warns when it doesn't end in `/v1` or uses plain
  http. When a web page answers at an address without `/v1`, the service tries
  once more with `/v1` added and, if that works, keeps it (with a warning).
- **Models.** `emis-models.json` in the MetaCode folder (or the file
  `EMIS_MODELS_FILE` or the config's `options.models_file` names;
  `EMIS_MODELS_FILE=none` means no file) — the
  gateway's OpenCode config, `https://emis.zxs-is-very.cool/cli/opencode.json`,
  which lists only models with tool calling. Download it again to update it;
  changes are picked up without a restart. Without the file the gateway's live
  list (`GET {EMIS_BASE_URL}/models`) is used, without image-, audio- and
  video-only models. The live list is also checked (every 5 minutes): models the
  file lists but the gateway doesn't offer right now are marked *"— not offered
  now"*. Until the first list has arrived, `/v1/status` says the gateway is
  *"still loading its model list"*.
- **Transport.** `EMIS_TRANSPORT`: `auto` (default) sends non-streamed requests
  from Python (`python/emis_fetch.py`) and falls back to Node.js without
  Python; `python` always uses Python; `node` never does. Streamed requests
  always go from Node.js. The worker asks for a streamed answer and reads it
  whole, with `httpx` when it's installed (it comes with the `openai` package
  in `requirements.txt`), else Python's own `urllib`; the `openai` package
  itself is only used for the model list. The config's `options.headers` are
  sent from Python too, and the worker doesn't get MetaCode's `OPENAI_*`
  variables (the `openai` package would send some of them as headers).
  `EMIS_PYTHON` (or `SCRAPER_PYTHON`) sets the Python command.
- **Proxy.** `EMIS_PROXY` for the gateway only; otherwise `HTTPS_PROXY` /
  `HTTP_PROXY` / `NO_PROXY`, like Zen.

**Other OpenAI-compatible providers.** Any other provider in the config file
with `"npm": "@ai-sdk/openai-compatible"` works the same way (keys, quota
headers, models file or live list). The EMIS defaults (address, models file,
transport) apply only to the provider whose id is `emis`.

## 3. Model ids and the default model

Model ids name the provider: `provider/model`, for example
`opencode/big-pickle` or `emis/claude-opus-5.5`. A Zen model can add a
reasoning variant from its catalog entry after `#`
(`opencode/glm-5.3-flash-free#high`); a `reasoning_effort` in the request picks
the variant of that name when the model has one. An unknown variant is refused.

**Ids without a provider** (saved by earlier versions, e.g. in Settings, the AI
Coding Lab or `EMIS_MODEL`) still work: the service uses the first provider —
OpenAI-compatible providers first, in config order, then Zen — that lists the
model, either under exactly that id or under another spelling of it
(`claude-opus-5-5` for `claude-opus-5.5`; `model-match.js`). So an old id stays
with the gateway even when Zen spells the same model exactly that way. MetaCode
and the browser map saved ids to the new ones the same way.

**The default model** is the first of these that is offered and usable:

1. `OPENCODE_MODEL`
2. the config file's `model`
3. `EMIS_MODEL`, from earlier versions, as `emis/<id>`
4. `emis/claude-opus-5.5`, when the gateway is ready and lists it
5. Zen's first model: without a key `big-pickle`, `deepseek-v4.1-flash-free`,
   `glm-5.3-flash-free`, `muse-spark-1.3-contributor-free` in that order, then
   the other free ones; with a key the newest release
6. the first model listed

A setting that names a model nobody offers is skipped with a warning. The model
list (`GET /v1/models`) has the providers in config order (the gateway first,
then Zen), each provider's models in its own order.

When a model is rate-limited, failing or its provider is resting, MetaCode
answers with the closest similar model (`model-match.js`, on by default; off
with `AI_MODEL_SWITCH=off` or per browser in Settings → AI models). The same
model from the other provider counts as the closest. More in
[ai-models.md](ai-models.md).

## 4. Settings

All in MetaCode's `.env` ([.env.example](../.env.example)).

**Read by the service:**

| Variable | Meaning |
|---|---|
| `OPENCODE_SERVICE_HOST` | Address it listens on, default `127.0.0.1` (an address other machines can reach gets a warning) |
| `OPENCODE_SERVICE_PORT` | Port, default `4097` (OpenCode's own `opencode serve` uses 4096) |
| `OPENCODE_SERVICE_TOKEN` | Access token, at least 16 visible characters without spaces; unset: the token file |
| `OPENCODE_SERVICE_DATA_DIR` | Folder for the token file and the catalog cache, default `opencode-data/` in the MetaCode folder |
| `OPENCODE_CONFIG` | An operator config file merged over `opencode/opencode.json` |
| `OPENCODE_MODEL` | Default model (`provider/model[#variant]` or an id without a provider) |
| `OPENCODE_DISABLED_PROVIDERS` | Comma list of provider ids to switch off, e.g. `opencode` |
| `OPENCODE_API_KEY` | Zen key. Optional: without it only the free models are offered |
| `OPENCODE_DISABLE_FREE_MODELS` | `1` / `true`: don't offer Zen's free models |
| `OPENCODE_MODELS_URL` | Where the catalog comes from instead of `https://models.opencode.ai` (`<url>/api.json`) |
| `OPENCODE_MODELS_PATH` | A local models.dev JSON file that wins over everything |
| `OPENCODE_DISABLE_MODELS_FETCH` | `1` / `true`: never refresh the catalog over the network |
| `OPENCODE_INFERENCE_URL` | Replaces the `https://opencode.ai/inference` start of Zen's model addresses (tests, proxies) |
| `EMIS_API_KEY`, `EMIS_BASE_URL`, `EMIS_MODELS_FILE`, `EMIS_TRANSPORT`, `EMIS_PYTHON`, `EMIS_PROXY` | The gateway ([section 2](#the-ai-gateway-emis-emis)) |
| `EMIS_MODEL` | From earlier versions: the default model `emis/<id>` when `OPENCODE_MODEL` and the config's `model` are unset |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Proxy for both providers; `EMIS_PROXY` replaces it for the gateway |

**Read by MetaCode:**

| Variable | Meaning |
|---|---|
| `OPENCODE_SERVICE_URL` | The service's address, default `http://127.0.0.1:4097/v1` (from the host and port above); `off` switches MetaCode's AI off |
| `OPENCODE_SERVICE_TOKEN` / `OPENCODE_SERVICE_DATA_DIR` | The same as the service's: the token from the setting, otherwise from the token file |
| `OPENCODE_SERVICE_MANAGED` | `auto` (default) / `on` / `off` ([section 1](#1-running-it)) |
| `OPENCODE_MODEL` | Default model (also read by the service); `EMIS_MODEL` is used when it's unset |
| `AI_MODEL_SWITCH` | `off` turns switching to the closest similar model off (older name: `EMIS_MODEL_SWITCH`) |
| `AI_TIMEOUT_MS` | How long one AI request may take, 1000–600000 ms, default 120000 (older name: `EMIS_TIMEOUT_MS`) |
| `AI_MAX_PARALLEL`, `AI_BATCH_PAUSE_SECONDS` | AI Coding's copies at once and its pause after server errors (unchanged) |

## 5. The config file

`opencode/opencode.json` is MetaCode's OpenCode config, in OpenCode's (v1)
config format — the same format as `emis-models.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "emis": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AI gateway",
      "options": { "baseURL": "{env:EMIS_BASE_URL}", "apiKey": "{env:EMIS_API_KEY}" }
    },
    "opencode": {
      "name": "OpenCode Zen",
      "options": { "apiKey": "{env:OPENCODE_API_KEY}" }
    }
  }
}
```

- `{env:VAR}` becomes the variable's value (or nothing); `{file:path}` becomes
  the file's text (relative to the config file, `~/` expanded, trimmed). Both
  work only inside string values. An empty `baseURL` means the provider's
  default; an empty `apiKey` means no key.
- **Your own changes** go in a separate file named by `OPENCODE_CONFIG`, not in
  `opencode/opencode.json` (that file is part of MetaCode and changes with
  updates). It is merged over the committed one: each `provider.<id>` object
  is merged key by key, while `model`, `enabled_providers` and
  `disabled_providers` replace. A file that can't be read or isn't valid JSON
  is ignored with a warning.
- **Supported keys:** `provider.<id>.{npm, name, options{baseURL, apiKey,
  headers, transport, models_file}, models{<id>: {name, tool_call, reasoning,
  attachment, temperature, limit{context, output}, status}}, whitelist[],
  blacklist[]}`, `model`, `enabled_providers[]`, `disabled_providers[]`. Any
  other key gets a warning (*"…isn't supported by MetaCode's OpenCode service
  and is ignored"*).
- **Kinds of provider:** the id `opencode` is Zen. Any other id with `"npm":
  "@ai-sdk/openai-compatible"` is an OpenAI-compatible provider. Other packages
  are skipped with a warning (*"only OpenCode Zen and OpenAI-compatible
  providers are supported"*).
- `enabled_providers` (an allow-list) and `disabled_providers` work as in
  OpenCode; `OPENCODE_DISABLED_PROVIDERS` in `.env` adds to the deny list.

For example, to offer only five of the gateway's models and no Zen models:

```json
{
  "provider": { "emis": { "whitelist": ["claude-opus-5.5", "claude-sonnet-5.5", "gpt-6.1-sol", "gemini-3.8-flash", "glm-5.3"] } },
  "disabled_providers": ["opencode"]
}
```

saved as, say, `/etc/metacode/opencode.json`, with
`OPENCODE_CONFIG=/etc/metacode/opencode.json` in `.env`, then **Reload .env**.

## 6. The Zen model catalog

Zen's models come from OpenCode's catalog ([models.dev](https://models.dev)),
not from Zen itself. The service loads the first of:

1. the file `OPENCODE_MODELS_PATH` names;
2. its cache, `opencode-data/models-catalog.json`;
3. the bundled copy, `opencode/zen-models.json` (the Zen part of the catalog
   bundled in OpenCode 2.1.4, 2026-10-26).

Unless `OPENCODE_DISABLE_MODELS_FETCH` is set, it then refreshes the catalog in
the background, at start and every hour, from
`https://models.opencode.ai/api.json` (or `OPENCODE_MODELS_URL` + `/api.json`;
10-second timeout; with its ETag, so an unchanged catalog isn't downloaded
again). A new catalog is cached and used at once; a failed refresh keeps the
current one and is logged at most once an hour. `GET /v1/status` says which
catalog is in use (`bundled`, `cache`, `remote` or `file`) and from when.

As in OpenCode, deprecated models, models without text in and out, and
realtime, embedding and reranking models are left out. Each model's protocol,
address, capabilities (tool calling, attachments, reasoning, temperature),
limits, prices (free = no input cost in any tier) and reasoning variants come
from its entry.

**Updating the bundled copy** (for a server that can't reach
`models.opencode.ai`, or before a release):

```bash
node opencode/scripts/update-zen-models.mjs --from <file|url>
```

with a models.dev `api.json` saved to a file, or its URL
(`https://models.opencode.ai/api.json`). `--label "<text>"` sets what the
file's `_source` says (default: where it came from; the date is added), and
`--out <file>` writes somewhere else than `opencode/zen-models.json`.

## 7. HTTP API

The service listens on `OPENCODE_SERVICE_HOST:OPENCODE_SERVICE_PORT`
(`127.0.0.1:4097`). MetaCode is its only intended client.

- Every `/v1/*` route needs `Authorization: Bearer <token>`; without the right
  token the answer is `401` with
  `{"error":{"type":"authentication_error","message":"MetaCode's OpenCode service needs its access token…"}}`.
- JSON bodies up to 32 MB (`413 request_too_large` above that). Unknown routes
  answer `404` `{"error":{"type":"not_found"}}`.
- `GET /health` needs no token and shows nothing secret:
  `{"ok":true,"service":"metacode-opencode","version":"<MetaCode's version>","opencode":"2.1.4","startedAt":"…","pid":123}`.

### `GET /v1/models`

```json
{ "object": "list", "default": "opencode/big-pickle",
  "providers": [ {"id":"opencode","name":"OpenCode Zen","ready":true}, {"id":"emis","name":"AI gateway","ready":false} ],
  "data": [ { "id":"opencode/big-pickle", "object":"model", "created":1760659200, "owned_by":"opencode",
              "provider":"opencode", "provider_name":"OpenCode Zen", "model":"big-pickle", "name":"Big Pickle",
              "free":true, "available":true, "default":true,
              "tool_call":true, "reasoning":true, "attachment":false, "temperature":true,
              "context_window":200000, "max_output":32000, "variants":["low","high","max"], "release_date":"2025-10-17" } ] }
```

- Only ready providers contribute models; Zen without a key only its free ones.
- `available`: `true`, `false` (the gateway's live list doesn't have it now) or
  `null` (unknown). `created` is the release date in Unix seconds (0 if
  unknown). Other missing values are left out.

### `POST /v1/chat/completions`

OpenAI's Chat Completions format: `model`, `messages` (roles `system`,
`developer`, `user`, `assistant`, `tool`), `max_tokens` /
`max_completion_tokens`, `temperature`, `top_p`, `presence_penalty`,
`frequency_penalty`, `seed`, `stop`, `tools`, `tool_choice`,
`parallel_tool_calls`, `response_format`, `reasoning_effort`, `stream`,
`stream_options`, `n` (only 1). Other fields are ignored. Without `model` the
default model answers.

- `X-Request-Timeout-Ms` (sent by MetaCode, from `AI_TIMEOUT_MS`): the service
  gives up on the provider 3 seconds earlier (at least 1 second; 115 seconds
  without the header) — waiting for the first answer, between two streamed
  pieces, and for a whole non-streamed answer.
- Not streamed: `200` with a `chat.completion` (`model` is the full id used;
  `message.reasoning_content` and `tool_calls` when there are any; `usage`).
- `"stream": true`: `200 text/event-stream` with `chat.completion.chunk`
  events, a usage chunk when `stream_options.include_usage` is set, then
  `data: [DONE]`. The status line is sent only after the provider's first
  event, so an early failure is still a real HTTP error; a failure after that
  is a last `data: {"error":{…}}` event, and the stream ends without
  `[DONE]`.
- Successful answers carry `X-OpenCode-Provider` and `X-OpenCode-Model`.
- When the caller goes away, the request to the provider is cancelled.

Errors are `{"error":{"message","type","code"?,"provider"?,"model"?,"scope"?,"upstream_status"?,"retry_after_seconds"?,"reset_at"?,"window"?}}`
with a `Retry-After` header when `retry_after_seconds` is set. Messages are
written for MetaCode's operator: they say what happened and which setting to
check, name the provider, and never contain keys, tokens or full addresses.

| `type` | Status | When |
|---|---|---|
| `invalid_request` | 400 | a bad request (`n` > 1, unknown role, bad image data, unknown variant…); the provider said 400/422 |
| `unsupported_feature` | 400 | tools for a model without tool calling; images or files for a model without attachments |
| `authentication_error` | 401 | wrong service token; the provider refused the key (gateway: every key) |
| `permission_error` | 403 | the provider refused (e.g. a key that may not use that model) |
| `blocked` | 403 | a web page answered with 403 instead of the provider's API |
| `model_not_found` | 404 | an unknown model id; the provider doesn't have the model |
| `not_configured` | 503 | the model's provider isn't set up (no key, switched off, config problem), or a paid Zen model without `OPENCODE_API_KEY` |
| `request_too_large` | 413 | over 32 MB; the provider said 413 |
| `rate_limited` | 429 | `scope:"model"`: only this model is throttled (MetaCode rests it); `scope:"provider"`: the provider asked to pause |
| `quota_exceeded` | 429 | `scope:"provider"`: the provider's budget is used up (gateway: every key's; Zen: free limit or budget), with `reset_at` and `window` when known |
| `cancelled` | 499 | the caller went away |
| `upstream_error` | 502 | the provider had a server error (`upstream_status`) |
| `malformed_response` | 502 | the provider's answer couldn't be read |
| `network` | 502 | the provider couldn't be reached (`code`: `ENOTFOUND`, `ECONNREFUSED`, …) |
| `timeout` | 504 | the provider took too long |
| `internal_error` | 500 | a bug in the service (details in its log) |

**Retries happen in one place: MetaCode** (2 more tries on 408, 5xx and
passing network failures). The service never repeats a failed call, apart from
moving on to the next gateway key and the `/v1` fix above, which aren't
repeats of the same request.

### `GET /v1/status` and `POST /v1/reload`

`GET /v1/status` is what Settings → AI connection and AI providers show:

```json
{ "service": {"name":"metacode-opencode","version":"…","opencode":"2.1.4","startedAt":"…","pid":123,"host":"127.0.0.1","port":4097},
  "ready": true, "default": "opencode/big-pickle", "warnings": [],
  "providers": [
    { "id":"opencode", "name":"OpenCode Zen", "kind":"zen", "ready":true, "problem":null, "warnings":[],
      "keyCount":0, "free":true, "note":"Free models only — add OPENCODE_API_KEY for the others.",
      "models":{"listed":9, "available":9}, "catalog":{"source":"bundled", "updatedAt":"…", "models":130},
      "resting":null, "keys":[] },
    { "id":"emis", "name":"AI gateway", "kind":"openai-compatible", "ready":true, "problem":null, "warnings":[],
      "keyCount":2, "baseHost":"emis.zxs-is-very.cool", "proxy":null, "transport":"Python 3.13 (urllib)",
      "models":{"listed":347, "available":340, "source":"emis-models.json", "checkedAt":"…"},
      "resting":{"until":"…","reason":"quota","window":"week"},
      "keys":[ {"masked":"…6789","status":"cooling_down","cooldownSecondsLeft":0,"requestCount":3,
                "quota":{"window":"week","limitPrompts":100,"limitTokens":0,"remainingPrompts":42,"remainingTokens":0,"resetAt":"…","updatedAt":"…"}} ] } ] }
```

`ready` is true when at least one provider is ready with a model. A provider's
`resting` says it can't be used until `until` (every key resting, or Zen's free
limit reached). Keys are only ever shown masked (`…6789`).

`POST /v1/reload` reads `.env`, the config, the gateway's models file and the
catalog cache again, resets key states and caches, restarts the Python worker
once its requests have finished, and answers with the status.

## 8. Security

- **This computer only.** The service listens on `127.0.0.1` unless
  `OPENCODE_SERVICE_HOST` says otherwise (which gets a warning). Don't open its
  port (4097) in a firewall: only MetaCode needs to reach it, and MetaCode
  connects to it directly, never through a proxy.
- **An access token on every request** (compared in constant time). The token
  file `opencode-data/token` is readable only by its owner, and
  `opencode-data/` is in `.gitignore`. `GET /health` needs no token and reveals
  nothing secret.
- **Keys stay in `.env`.** The gateway and Zen keys are read only by the
  service. They are never sent to the browser, logged, returned by an endpoint
  or put in an error message: provider messages are cleaned of keys, tokens and
  addresses (only the host name is kept) before they're logged or passed on.
  Rotating them: [security.md](security.md).
- **No tools, files or shell.** The service lists models and answers chat
  requests. Tool calls a model makes are returned to MetaCode, never run.
- Request bodies are limited to 32 MB.

## 9. Troubleshooting

**"MetaCode's AI service (OpenCode) isn't running at 127.0.0.1:4097…"**
Under pm2: `pm2 status` should list `metacode-opencode` as online; if it's
missing, `pm2 start ecosystem.config.cjs && pm2 save`; if it keeps restarting,
`pm2 logs metacode-opencode --lines 50` says why. Without pm2, MetaCode starts
it itself; its log lines start with `[opencode]`.

**"The AI service couldn't start: its packages aren't installed"**
Run `npm install` in the MetaCode folder, then restart MetaCode (or
`pm2 restart metacode-opencode`).

**"port 4097 is in use"**
Another copy is running — for example one MetaCode started itself before pm2
ran the service. Under pm2, make sure MetaCode has `OPENCODE_SERVICE_MANAGED=off`
(`pm2 startOrReload ecosystem.config.cjs --update-env`). If another program
uses the port, set `OPENCODE_SERVICE_PORT` in `.env` (both read it) and restart
both apps.

**"…needs its access token" (401)**
MetaCode and the service don't share a token: both must read the same `.env`
(the same `OPENCODE_SERVICE_TOKEN`, or the same `OPENCODE_SERVICE_DATA_DIR`).
Restart both after changing it.

**Only free models / "Free models only — add OPENCODE_API_KEY for the others."**
Add `OPENCODE_API_KEY` to `.env` and click **Reload .env**. If Zen offers no
models at all, `OPENCODE_DISABLE_FREE_MODELS` is set and there's no key.

**A quota or free-limit message naming OpenCode Zen**
Zen's free limit or the account's budget is reached; the message says when it
resets. Meanwhile MetaCode uses a similar gateway model, if the gateway is set
up and switching is on. Add a key with budget, or wait.

**"Couldn't reach OpenCode Zen…" / "Couldn't reach the AI gateway…"**
The server can't reach the provider. On a network that only reaches the
internet through a proxy, set `HTTPS_PROXY=http://proxy:port` in `.env` (or
`EMIS_PROXY` for the gateway only) and click **Reload .env**.

**The gateway: "A web page answered (HTTP 403)…", a rejected key, a used-up quota**
A web page means the request didn't reach the gateway's API with your key:
check that `EMIS_BASE_URL` is `https://emis.zxs-is-very.cool/v1` (or leave it
out) and that `EMIS_API_KEY` holds your key (`emis-…`), then **Reload .env**. A
proxy or firewall on your network may be answering instead. A used-up quota
resets when the message says; another key can be added to `EMIS_API_KEY`
(comma-separated).

**The Zen catalog never refreshes (the service's log says the refresh failed)**
The server can't reach `models.opencode.ai`. The bundled or cached catalog
keeps working; set `OPENCODE_DISABLE_MODELS_FETCH=1` to stop trying, and update
the bundled copy as in [section 6](#6-the-zen-model-catalog).

**Checking it by hand** (on the server, in the MetaCode folder):

```bash
curl -s http://127.0.0.1:4097/health
curl -s -H "Authorization: Bearer $(cat opencode-data/token)" http://127.0.0.1:4097/v1/status
```

(with `OPENCODE_SERVICE_TOKEN` set, use that instead of the file).

## 10. Files

| File | What it is |
|---|---|
| `opencode/server.mjs` | The service: HTTP server, routes, access token; `node opencode/server.mjs` |
| `opencode/config.mjs` | Reads `.env` and the config files |
| `opencode/opencode.json` | MetaCode's OpenCode config (the two providers) |
| `opencode/catalog.mjs`, `opencode/zen-models.json` | The Zen catalog and its bundled copy |
| `opencode/scripts/update-zen-models.mjs` | Regenerates `zen-models.json` |
| `opencode/providers/zen.mjs` | OpenCode Zen |
| `opencode/providers/openai-compatible.mjs`, `opencode/emis-python.js`, `python/emis_fetch.py` | The gateway (and other OpenAI-compatible providers), its Python transport |
| `opencode/openai.mjs`, `opencode/errors.mjs`, `opencode/http.mjs` | OpenAI chat format ⇄ `@opencode/ai`, errors, outgoing requests |
| `opencode/shared.js` | Address, port, data folder and token, shared with MetaCode |
| `opencode/supervisor.js` | MetaCode starting and stopping the service |
| `emis-models.json` | The gateway's model list |
| `opencode-data/` | The token file and the catalog cache (not in Git) |
| `ecosystem.config.cjs` | pm2: `metacode` and `metacode-opencode` |
| `test/opencode-service.test.js`, `test/opencode-openai.test.js`, `test/opencode-emis.test.js`, `test/opencode-supervisor.test.js` | Tests, against local stand-ins for the providers |

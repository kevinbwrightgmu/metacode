# Free, cheap and self-hosted AI for MetaCode

Research notes (November 2026) on where MetaCode can get AI models for little
or no money when its current providers run out — free tiers, nearly-free paid
routes, academic programs, and running or training our own model. Written
after the gateway paused its key for 22 hours in the middle of a run.

> **How sure are these facts?** Free tiers and prices change every few weeks.
> Each fact below says where it came from:
> **checked** = read on the provider's own page or announcement in November
> 2026; **catalog** = a dated third-party catalog or price list (the
> models.dev snapshot of 2026-10-26 bundled with OpenCode, LiteLLM's price
> list of 2026-11-07, or similar); **last known** = the provider's 2025 docs or
> memory, not re-checked — confirm it before you rely on it. The research
> method and its limits are at the [end](#how-this-was-researched).

## In short

1. **Cheapest reliable route, no code changes: pay a few cents per run.** A
   whole AI Coding run of 2,000 posts costs about **$0.30–0.60** on today's
   small models (GPT-6 Luna, Claude Haiku 5.5, GPT-5 nano) through OpenCode
   Zen's pay-as-you-go, which MetaCode already speaks: put credit on
   `OPENCODE_API_KEY`. $20 of credit covers roughly 40–50 runs. Their providers
   don't train on API data. ([§4](#4-nearly-free-the-cheapest-paid-routes))
2. **Don't build on Zen's free models.** OpenCode's own docs now say free-tier
   models are "only available from within OpenCode; other clients receive
   HTTP 403". MetaCode gets them today, but that can stop without notice, and
   their providers may use the prompts. ([§2](#2-opencode-zens-free-models-metacodes-current-default))
3. **The best truly free API for a full run is Google's Gemini API free tier
   with Gemma 4** (about 30 requests/min, 14,400/day): one run in about
   3–4 hours. The catch: Google may use free-tier prompts to improve its
   products, and humans may read them — fine for public, non-sensitive posts,
   not for anything else. ([§3](#3-free-hosted-apis))
4. **Several free providers together are more than any one of them.** Add one
   account each at a few providers (Gemini, Groq, Mistral, OpenRouter,
   Inception, OVHcloud); MetaCode already switches to another provider's
   closest model when one is rate-limited or paused. Never open several
   accounts at the same provider to get around its limits — that breaks their
   terms. ([§3](#3-free-hosted-apis), [§8](#8-adding-a-provider-to-metacode))
5. **"Making our own" is realistic, but not on MetaCode's small VPS.** An
   open model (Gemma 4, Qwen 3.6/3.8, gpt-oss) on one rented or campus GPU
   codes a run in well under an hour for cents, with no limits and nothing
   leaving our machines; a Mac with 32 GB or a gaming PC does it for free.
   Even better in the long run: **train our own small coder** on
   human-checked posts — it then codes 2,000 posts in about a minute on a CPU.
   ([§6](#6-making-our-own))
6. **Researchers can get it free.** University GPU clusters, NSF ACCESS
   (Jetstream2 can host a model endpoint), the NAIRR Pilot and company research
   credits (OpenAI, Anthropic, Google) cover hundreds of runs.
   ([§5](#5-free-for-researchers))
7. **Mind the data.** Free tiers are often paid for with your data, and
   social-media posts are personal data. Check what the IRB approved; for
   anything sensitive use a no-training paid tier, the university's licensed
   AI services, or a local model. ([§7](#7-privacy-terms-and-research-ethics))

## 1. What MetaCode needs

An AI Coding run sends **one chat request per post**: the codebook as the
system message (about 500–2,000 tokens), the post with its author, date and
engagement (50–300 tokens), `temperature` 0.1 and `max_tokens` 1000, and
expects a short JSON answer (100–400 tokens). It sends up to 16 requests at
once.

For comparisons this page uses a **standard run**: **2,000 posts, 3.0 million
input tokens and 0.6 million output tokens**.

What decides whether a provider works for it:

- **The OpenAI Chat Completions format.** MetaCode's AI service takes any
  provider that speaks it ([§8](#8-adding-a-provider-to-metacode)); almost all
  of the providers below do.
- **Limits.** How long a run takes is set by the tightest one:

  | Limit | Standard run needs |
  |---|---|
  | Requests per day (RPD) | 2,000 ÷ RPD days (500/day → 4 days; 14,400/day → under a day) |
  | Tokens per day (TPD) | 3.6M ÷ TPD days (200,000/day → 18 days) |
  | Requests per minute (RPM) | at least 2,000 ÷ RPM minutes (30 RPM → 67 min) |
  | Tokens per minute (TPM) | at least 3.6M ÷ TPM minutes (16,000 TPM → about 3¾ h) |

- **Reasoning ("thinking") models.** Many current models think before they
  answer. With `max_tokens` 1000 the thinking can use up the budget and cut
  the JSON off. Turn thinking off or low where the provider allows it (Zen's
  model variants such as `#none` do), or give such models a bigger
  `max_tokens`.
- **JSON.** Most providers can force valid JSON (`response_format` with a JSON
  schema); MetaCode doesn't ask for that yet, which matters most for small
  models.
- **Data use.** Whether the provider trains on or keeps the posts
  ([§7](#7-privacy-terms-and-research-ethics)).
- **One model per run.** MetaCode's automatic switching (and "Keep going if
  the model runs out") can mix models within a run. For a study, pick one
  model, check it against human coders, and report it.

## 2. OpenCode Zen's free models (MetaCode's current default)

MetaCode's AI service offers Zen's free models by default (Big Pickle,
GLM-5.3-Flash Free, DeepSeek V4.1 Flash Free and others, each "free for a
limited time"). Three things make them a poor base for research runs:

- **They're meant for OpenCode itself.** OpenCode's Console docs (source dated
  2026-10-26) say: *"Free-tier chat models are only available from within
  OpenCode; other clients receive HTTP 403, even with an API key. Use paid
  models or a Go subscription from other clients."* MetaCode is built on
  OpenCode's packages and identifies itself as `metacode`; it gets through
  today, but this can end at any time. **checked** (OpenCode's docs source)
- **Unpublished, daily limits.** Zen answers `429 FreeUsageLimitError` when
  the day's allowance is used up and MetaCode then rests Zen for up to an hour.
  A run can't be planned around that. **checked** (OpenCode's docs and code)
- **Data.** Zen's docs say its providers follow a zero-retention policy, but
  free models may be used to improve the models during their free period
  (MetaCode's own docs already warn about this). **catalog**

**OpenCode Go** ($10/month, large allowances) is described as "designed for
OpenCode and other coding agents" and is monitored for abuse — ask OpenCode
before using it for bulk classification. **Zen pay-as-you-go** has no such
rule and is the recommended route in [§4](#4-nearly-free-the-cheapest-paid-routes).

## 3. Free hosted APIs

Ranked for MetaCode's job (one legitimate account per provider):

| Provider | What's free | Limits (as published) | Standard run | Data use on the free tier | Sure? |
|---|---|---|---|---|---|
| **Google Gemini API** (AI Studio key, no billing linked) — **Gemma 4 31B / 26B-A4B** | Gemma 4 models | about 30 RPM, 14,400 RPD, ~15–16K TPM | about 3–4 h (TPM is the limit) | **used to improve Google's products; human reviewers may read it**; don't send personal data | catalog |
| Google Gemini API — Gemini 3.5 / 3.1 Flash-Lite | the Flash-Lite models | ~10–15 RPM, 500 RPD each | 4 days on one model | as above | catalog |
| Google Gemini API — Gemini 3.8 Flash | the newest Flash | ~5 RPM, 20 RPD | not viable (100 days); for testing a codebook | as above | catalog |
| **Mistral La Plateforme** — free "Experiment" plan | Mistral's API models (phone check) | 1 request/s, 500K TPM, 1 billion tokens/month | about 35–60 min; ~270 runs a month | may be used for training (opt-out in settings) | last known |
| **Inception** (Mercury 3) | one-time 100 million tokens per new account | 1,000 RPM, 1M input / 100K output TPM | about 27 runs from the credit | **trains by default** — switch off "Improve the model for everyone" | catalog |
| **Groq** (no card) | gpt-oss-120b, gpt-oss-20b, a Qwen model (Llama left the free plan in Aug 2026) | per model about 30 RPM, 1,000 RPD, 8K TPM, 200K TPD | about 18 model-days; 2–6 days across its models | doesn't keep prompts by default | catalog |
| **OpenRouter** `:free` models | many open models (Gemma 4 31B, Nemotron, GLM, Qwen…) | 20 RPM; 50 requests/day, or 1,000/day after a one-time $10 credit purchase | 40 days, or 2 days after the $10 | depends on the model's host; free hosts often log or train — restrict routing in account settings | last known |
| **OVHcloud AI Endpoints** (no key at all) | every catalog model, anonymously | 2 requests/min per IP per model | about 17 h on one model, ~4 h across 4 | EU-hosted, not stored, not used for training | catalog |
| **NVIDIA build.nvidia.com** | trial endpoints for 30+ open models (Gemma 4 31B, DeepSeek V4.1 Flash, GLM…) | about 40 RPM, unpublished caps | about 50 min | **trial use only**, logged; not for personal data | last known |
| **Cloudflare Workers AI** | 10,000 Neurons/day | 300 RPM | about 3 days (qwen3-30b) | doesn't train on prompts | checked* |
| **Scaleway Generative APIs** | 1 million tokens once (card needed) | per-model TPM | covers about a third of a run | zero data retention by default | catalog |
| **SambaNova Cloud** | all models, small caps | about 20 RPM / 20 RPD per model | about 17 days across 6 models | says it doesn't store prompts | catalog |
| **Cerebras** | one-time $5 trial for 30 days (card needed) — the old 1M tokens/day free tier ended around July 2026 | 5 RPM on the trial | about 3 runs | doesn't keep prompts | catalog |
| **Z.ai (Zhipu)** | free GLM-4.7-Flash / GLM-4.5-Flash | 1–2 requests at a time | a few hours (estimate) | China-based; Zhipu is on the US Entity List | last known |
| **Alibaba Model Studio** (international) | about 1M tokens per model, once, 90 days | not found | a quarter of a run per model | Alibaba Cloud International terms | catalog |
| **OpenAI** — complimentary tokens for data sharing | about 2.5M tokens/day on small models (tiers 1–2), 10M at tiers 3–5, for orgs that opt in | daily | 1–3 runs a day | **your data trains OpenAI's models** | last known |
| Cohere trial key | 1,000 calls/month | not for production | not viable | — | last known |

\* checked on Cloudflare's pages by the research agents; the run time depends
on the model's Neuron price.

**Gone in 2026** (don't plan on them): GitHub Models (retired 30 July 2026),
Gemini CLI's free tier (ended June 2026), Meta's Llama API preview (retired
July 2026), Hugging Face's monthly free credit, Cerebras' daily free tier,
Groq's free Llama models, Chutes' free access, kluster.ai (shut down June
2026), Lambda's Inference API and Hyperbolic's old API. **catalog**

**Stacking free tiers.** Each provider's limit counts per account (Google's per
project). One account each at Gemini, Groq, Mistral, Inception, OpenRouter and
OVHcloud, all added to MetaCode, gives several free runs a week: MetaCode
moves to another provider's closest model when one answers 429. Free tiers
with 5–30 requests a minute need AI Coding's **at once** box set to 1–4, or
most requests come back rate-limited at first. What isn't allowed: several
accounts or projects at the same provider to multiply its quota (Google's
terms forbid getting around quotas, and OpenRouter says extra keys don't raise
limits).

### Not recommended: "unlimited" and no-key services

- **No-key "free unlimited" APIs** (Pollinations, LLM7, Puter's user-pays
  model): no service terms you can rely on, unknown hosts behind them,
  unknown logging. Not for research data.
- **Chat websites** (Duck.ai, HuggingChat, the vendors' own chat apps): no API;
  scripting them breaks their terms.
- **Reverse-engineered wrappers** (gpt4free and similar) and relays that
  offer "free GPT/Claude": they ride on other people's accounts or break the
  vendors' terms, break often, and send your data to unknown parties.

## 4. Nearly free: the cheapest paid routes

Paying is often the better "free": a standard run costs well under a dollar,
the providers don't train on API data, limits are high, and nothing pauses
for 22 hours. Prices per million tokens (input / output); standard run =
3.0M in + 0.6M out:

| Model (where) | Price in / out | Standard run | With the codebook cached | Notes | Sure? |
|---|---|---|---|---|---|
| **GPT-6 Luna** (Zen pay-as-you-go, or OpenAI) | $0.10 / $0.50 | $0.60 | ~$0.39 | **recommended**; use the `#none` variant (reasoning off); OpenAI keeps API data 30 days, doesn't train on it | catalog |
| **Claude Haiku 5.5** (Zen, or Anthropic) | $0.10 / $0.50 | $0.60 | — (needs `cache_control`, which MetaCode doesn't send) | backup with another company behind it; `#none` turns thinking off; may refuse to code some harmful posts | checked |
| **GPT-5 nano** (Zen, or OpenAI) | $0.05 / $0.40 | $0.39 | ~$0.28 | cheapest big-lab model; weaker on subtle codebooks | catalog |
| gpt-oss-120b (DeepInfra) | $0.037 / $0.17 | $0.21 | — | open model; reasons by default (adds output tokens) | catalog |
| Gemma 4 31B (DeepInfra; LLM Gateway) | $0.13 / $0.38; $0.10 / $0.25 | $0.62; $0.45 | — | the same model as the free Gemini tier, without the data catch | catalog |
| Qwen3.7 Flash (Alibaba international) | $0.03 / $0.13 | $0.17 | ~$0.11 | Alibaba Cloud terms | catalog |
| Mistral Small 4 (Mistral) | $0.15 / $0.60 | $0.81 | ~$0.49 | EU company | catalog |
| gpt-oss-20b / 120b (Groq) | $0.075 / $0.30; $0.15 / $0.60 | $0.41; $0.81 | ~$0.32; ~$0.63 | very fast | catalog |
| Gemini 3.1 Flash-Lite (Google, paid tier) | $0.25 / $1.50 | $1.65 | ~$1.11 | paid tier isn't used for training; Flex/Batch halve it | catalog |
| DeepSeek V4.1 Flash (DeepSeek) | $0.30 / $1.20 peak, half off-peak | $1.62 peak, $0.81 off-peak | cheaper | **data stored in China**; banned on Virginia state devices | catalog |
| Workers AI qwen3-30b (Cloudflare) | Neurons | about $0.35 | — | no training | catalog |

What lowers the cost more than the list price:

- **Reasoning off.** Every extra 100 reasoning tokens per post adds
  $0.08–0.30 to a run. Zen's `#none` / `#minimal` variants turn it off.
- **The same codebook prefix on every request.** OpenAI, Gemini, DeepSeek,
  Qwen and Groq cache a repeated prompt start automatically (OpenAI from 1,024
  tokens); MetaCode already sends the codebook as an identical system message.
- **Batch APIs** halve OpenAI's, Anthropic's and Google's prices for runs that
  can wait, but need an asynchronous path MetaCode doesn't have (saves ~$0.30
  a run).

Zen's pay-as-you-go adds a card fee per purchase (4.6% + $0.31), so buy credit
in larger amounts. **catalog** (OpenCode's docs)

**Pick by testing, not by price.** Code 100–200 posts by hand, run them
through two or three of these models in the AI Coding Lab (cents each), and
keep the cheapest model that reaches your agreement threshold (Cohen's kappa
or Krippendorff's alpha, which MetaCode computes).

## 5. Free for researchers

| Program | What it gives | Fit | Sure? |
|---|---|---|---|
| **University research computing** (for example George Mason's ORC Hopper cluster) | GPU time (A100-class), free for the university's researchers; data stays on campus | best for sensitive data; run vLLM as a batch job (export the requests, import the codes) or a session endpoint over VPN | last known |
| **NSF ACCESS** — Explore allocation (up to ~400,000 credits, days to approve), Discover for more | GPU time on Delta, DeltaAI, Anvil, and **Jetstream2** cloud VMs with A100s and public IPs | Jetstream2 can host an always-on OpenAI-compatible endpoint MetaCode can reach directly | last known |
| **NAIRR Pilot** (NSF-led) | per-project allocations of GPU time and API credits from model companies (OpenAI, Anthropic, Microsoft and others) for US researchers and educators | free frontier models; apply per project, review takes weeks | last known |
| **OpenAI Researcher Access Program** | up to $1,000 in API credits, reviewed quarterly | ~1,500+ standard runs on small models | last known |
| **Anthropic AI for Science** | up to $20,000 in API credits (aimed at the sciences) | if the project fits | last known |
| **Google Cloud research credits / Gemini academic program** | about $1,000–5,000 of credits | paid-tier Gemini (no training) | last known |
| Cohere Labs research grants; cloud credits (AWS up to ~$200 for new accounts, Oracle $300 for 30 days, Azure for Students $100) | credits | small but easy | last known |
| GitHub Education | free Copilot Pro for verified students and teachers | no help for MetaCode now that GitHub Models is retired | last known |

At $0.30–1.65 a run, even $1,000 of credits is hundreds to thousands of runs.

**At George Mason specifically** (from the research; confirm with ORC, IT and
the IRB): ORC's Hopper cluster has A100-class GPUs free for Mason researchers;
Mason's chat services (Copilot Chat, Gemini for Education where enabled) have
no API keys, so they only help for trying prompts by hand; Mason classifies
data as Public / Restricted / Highly Sensitive, and that class plus the IRB's
decision govern whether posts may go to any third party; Virginia's Executive
Order 46 (February 2025) bans DeepSeek on state devices and networks, so for
Mason work avoid DeepSeek's own API (and, to be safe, other China-based APIs).
**last known**

## 6. Making our own

### 6a. Host an open model ourselves

Every serious model server speaks the OpenAI Chat Completions format, so it
plugs into MetaCode as one more provider ([§8](#8-adding-a-provider-to-metacode))
— no limits, no pauses, nothing leaves our machines, and the model never
changes under us (good for reproducibility).

**Server software** **checked** (their GitHub repositories and package
registries, November 2026):

| Software | Best for | Notes |
|---|---|---|
| **vLLM** (0.33) or **SGLang** (0.5.23) | an NVIDIA GPU | continuous batching (16 posts at once is easy), prefix caching for the codebook, `response_format` JSON schema |
| **llama.cpp `llama-server`** | CPUs, Macs, small GPUs | parallel slots, prompt cache, JSON-schema/grammar output; MIT licence |
| **Ollama** (0.40) | the easiest setup | its defaults throttle batch jobs (1 request at a time, 4K context on GPUs under 24 GB): raise `OLLAMA_NUM_PARALLEL` and the context length |
| LM Studio (headless) | a Mac or desktop | GUI plus server |
| Hugging Face TGI | — | archived in March 2026; don't use |

**Models** (open weights, late 2026):

| Size | Models | Runs on |
|---|---|---|
| Laptop (4–9B) | Qwen3.5-4B / 9B, Gemma 4 E4B | 8–16 GB; good for simple codebooks only |
| Best value (MoE, ~3–4B active) | **Qwen3.6-35B-A3B**, **Gemma 4 26B-A4B**, Nemotron 3.5 30B-A3B, **gpt-oss-20b** | a 24–48 GB GPU, or a 32 GB Mac |
| Best quality on one 24 GB card | Qwen3.8-27B, **Gemma 4 31B** (about 20 GB at 4-bit) | RTX 3090/4090/5090 |
| Strongest on one 80 GB GPU | **gpt-oss-120b** | A100/H100 80 GB |

Most of these think before answering (Qwen 3.5 does by default): turn thinking
off on the server, or MetaCode's `max_tokens` of 1000 can cut the JSON off.
Published studies find open models approach frontier models but often trail
them zero-shot, and 7–12B models struggle with long codebooks — always check
against a human-coded sample.

**Where to run it** (standard run):

| Where | Cost | Time | Sure? |
|---|---|---|---|
| MetaCode's own VPS (CPU, ~1 GB RAM for the app) | — | **not practical**: 13–40 h or more for an 8B model, and it would starve the web app | estimate |
| Your own Mac (32 GB+) or a PC with an RTX 3090/4090 | free | about 10 min – 2 h | checked (llama.cpp benchmarks) |
| Oracle Cloud Always Free Arm VM (4 cores, 24 GB) | free | half a day to 2 days (overnight runs, MoE models) | last known |
| **Modal** — $30/month free credit, vLLM that scales to zero | free up to the credit | ~30–60 runs a month with an 8B model (estimate) | last known |
| RunPod / Vast.ai RTX 4090 (~$0.35–0.70/h), RunPod Serverless vLLM | cents per run | under an hour | last known |
| Datacenter GPU (H100 ~$1.60–4/h, L40S ~$0.50/h spot) | $0.10–2.50 per run | 5–70 GPU-minutes | estimate |
| Kaggle (~30 GPU-hours/week on 2×T4), Colab free | free | 30–75 min on a T4 — **offline batch only** (their terms don't allow serving an API): export the requests, run them in a notebook, import the codes | last known |
| University cluster / Jetstream2 | free for researchers | under an hour per GPU | last known |

### 6b. Train our own coder

The only route that removes per-post costs, rate limits and provider pauses
entirely — and the best fit for a fixed codebook:

1. A strong model (Zen pay-as-you-go, the gateway, credits) codes 600–1,000
   posts once per codebook version; humans check them.
2. Humans also code a separate random test set of 200–300 posts.
3. Fine-tune a small classifier per codebook dimension: **ModernBERT or
   DeBERTa-v3** with a few hundred examples per dimension, or **SetFit** with
   only 8–64 checked examples per code. Training takes minutes on free
   Colab/Kaggle GPUs (30–60 min on a CPU).
4. Run it on everything: an int8 ModernBERT-base-size model coded 2,000 posts
   in about **1 minute on a 4-vCPU CPU** (measured during this research), and
   could run inside MetaCode's own Node process (Transformers.js).
5. Check it against the human test set with kappa/alpha (MetaCode computes
   both) and use estimators that correct for model errors (DSL,
   prediction-powered inference) in the analysis.

If reasoning text matters or the codebook changes often, QLoRA-tune a 4–9B
open model instead (Unsloth's free notebooks) on the chat-format JSONL the AI
Coding Lab already exports, and serve it like [§6a](#6a-host-an-open-model-ourselves).
The research supports this: fine-tuned small models match or beat zero-shot
LLMs on fixed classification tasks (Ziems et al. 2024; Bucher & Martini
2024), and classifiers trained on LLM labels did about as well as ones
trained on human labels (Pangakis & Wolken 2024) — but LLM label quality
varies by task and can flip conclusions (Pangakis et al. 2023), so the human
check stays. The AI Coding Lab can already fine-tune through an
OpenAI-compatible provider that supports it (`AI_LAB_FINE_TUNING=on`,
[ai-lab.md](ai-lab.md)).

### 6c. Our own gateway

MetaCode's AI service already is one: several providers, key rotation,
fallback to another provider's closest model. A self-hosted **LiteLLM** proxy
is only worth adding for providers that don't speak the OpenAI format, or to
pace requests per key; one-api/new-api are built for reselling keys and are
overkill.

## 7. Privacy, terms and research ethics

- **Free tiers that pay with your data:** Gemini's free tier (used to improve
  products, human review, "do not submit sensitive, confidential, or personal
  information"), Mistral's Experiment plan, many OpenRouter `:free` hosts,
  Inception (by default), Zen's free models, NVIDIA's trial, and the
  data-for-credits programs (OpenAI, xAI). Use them only for public,
  de-identified, non-sensitive text, if at all. Training on posts may also
  clash with Reddit's and X's terms, which forbid letting others train models
  on their content.
- **Better terms, still free or cheap:** Groq, Cerebras, Cloudflare Workers AI,
  OVHcloud and Scaleway say they don't keep or train on prompts; OpenRouter can
  be restricted to zero-retention hosts in its settings; paid tiers with a data
  processing agreement (OpenAI, Anthropic, Gemini paid, Mistral paid, Azure,
  Vertex, Bedrock).
- **Sensitive or human-subjects data** (Survey Studio answers, interviews,
  vulnerable communities): a local model ([§6](#6-making-our-own)) or the AI
  services the university licenses. A self-hosted LiteLLM proxy can mask
  personal data (Presidio) before anything leaves.
- **China-based APIs** (DeepSeek, Zhipu/Z.ai, Moonshot, Alibaba's own): data
  held in the PRC, Zhipu is on the US Entity List, and Virginia bans DeepSeek
  on state devices. Use the same open models from US/EU hosts or locally.
- **The IRB** expects the protocol to name the provider, what is sent and how
  long it is kept. Note that **AI Coding sends the author's @handle, the date
  and engagement counts with every post** (`public/js/ai-coding.js`) — leave
  them out of the data if the protocol requires de-identification.
- **GDPR** (EU users or EU-based posts): public posts are still personal data,
  often special-category; a research legal basis, a processor contract and
  probably a DPIA are needed.
- **MetaCode detail:** a provider added through the config counts as *paid*
  for the switching rules (only Zen marks free models), so a free tier that
  trains could receive stand-in requests meant for a no-training model. Use
  `enabled_providers` / `whitelist` ([§8](#8-adding-a-provider-to-metacode))
  so a run can only reach the providers you approved.
- The gateway (EMIS) publishes no data policy that this research could find;
  MetaCode's older advice to use it for sensitive posts isn't backed by one.

## 8. Adding a provider to MetaCode

Providers go in a file of your own, named by `OPENCODE_CONFIG` in `.env`; it
is merged over `opencode/opencode.json` ([opencode-service.md
§5](opencode-service.md#5-the-config-file)). Each provider needs `"npm":
"@ai-sdk/openai-compatible"`, its `baseURL` and an `apiKey` — keys stay in
`.env` and are referenced as `{env:NAME}`. Models come from the provider's
`/models` list, or from `models` in the file (then only those are offered);
`whitelist` keeps only the listed ids. Model ids may contain `/` and `:`.

```json
{
  "provider": {
    "gemini": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Google Gemini (free tier)",
      "options": { "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai", "apiKey": "{env:GEMINI_API_KEY}" },
      "models": { "gemma-4-31b-it": { "name": "Gemma 4 31B" }, "gemini-3.1-flash-lite": { "name": "Gemini 3.1 Flash-Lite" } }
    },
    "groq": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Groq",
      "options": { "baseURL": "https://api.groq.com/openai/v1", "apiKey": "{env:GROQ_API_KEY}" },
      "whitelist": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
    },
    "mistral": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Mistral",
      "options": { "baseURL": "https://api.mistral.ai/v1", "apiKey": "{env:MISTRAL_API_KEY}" }
    },
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter (free models)",
      "options": { "baseURL": "https://openrouter.ai/api/v1", "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": { "google/gemma-4-31b-it:free": { "name": "Gemma 4 31B (free)" } }
    },
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Our own model",
      "options": { "baseURL": "http://127.0.0.1:11434/v1", "apiKey": "local" },
      "models": { "gemma4:26b": { "name": "Gemma 4 26B (local)" } }
    }
  }
}
```

```dotenv
OPENCODE_CONFIG=/etc/metacode/providers.json
GEMINI_API_KEY=...
GROQ_API_KEY=...
MISTRAL_API_KEY=...
OPENROUTER_API_KEY=...
```

Then click **Reload .env** in Settings; the new providers appear in Settings →
AI providers and their models in Settings → AI models.

- **Local servers need a key too:** MetaCode refuses a provider without one, so
  give Ollama any placeholder (`"local"`); start vLLM / llama-server with
  `--api-key` and use that value.
- **The model must be reachable from the server running MetaCode's AI
  service** — `127.0.0.1` only if the model runs on the same machine; a
  campus GPU behind a VPN needs a tunnel, or use the offline batch route.
- **Cloudflare's** base URL includes your account id:
  `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`.
- **Free tiers with low per-minute limits:** set AI Coding's **at once** box to
  1–4 for runs on them.
- **Only the providers you approved:** `"enabled_providers": ["gemini",
  "local"]` in the same file limits every feature to those
  ([§7](#7-privacy-terms-and-research-ethics)).
- **Model ids and base URLs** above were checked against the providers' docs
  where possible; confirm the current model ids in each provider's console.

## 9. What would help MetaCode use these better

Not built yet — ideas that came out of this research:

- **A per-provider request pace** (requests per minute) so free tiers with
  5–30 RPM aren't flooded by 16 parallel requests.
- **Reasoning control for any provider** (`reasoning_effort` / thinking off),
  not only Zen's variants.
- **`response_format` JSON schema built from the codebook**, so small and
  local models always return valid JSON.
- **A "free" flag for configured providers**, so the rule that free models
  don't stand in for paid ones (privacy) covers them too.
- **Pin one model for a run** (switching off for that run), for
  reproducibility.
- **Batch export/import** of AI Coding requests (JSONL), for Kaggle, a campus
  cluster or the providers' half-price batch APIs.
- **A built-in local classifier** ([§6b](#6b-train-our-own-coder)) running in
  Node with Transformers.js.

## How this was researched

On 2026-11-08 a set of research agents covered ten areas in parallel (big-tech
free tiers, inference startups, aggregators and no-key services, model makers'
own APIs, cheap paid models, self-hosting software and models, hardware and
GPUs, academic programs, training our own model, privacy and ethics),
reviewing about 250 options; fact-checkers then re-read the most important
claims; a critic looked for gaps, and four more agents filled them.

Limits of this research: the session's network blocks most provider websites
(only package registries such as npm and PyPI, GitHub, and web search were
reachable), and the web-search budget ran out partway through. The first areas
(big-tech, inference startups) come from live searches; much of the rest comes
from dated catalogs (the models.dev snapshot bundled with OpenCode, 2026-10-26;
LiteLLM's price list, 2026-11-07), OpenCode's own docs source (2026-10-26),
the package registries, and earlier knowledge — hence the **last known**
labels. Re-check a number on the provider's page before you budget or plan a
study around it.

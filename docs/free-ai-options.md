# Free, cheap and self-hosted AI for MetaCode

Research notes (November 2026) on where MetaCode can get AI models for little
or no money when its current providers run out — free tiers, nearly-free paid
routes, programs for researchers, and running or training our own model.
Written after the gateway paused its key for 22 hours in the middle of a run.

> **How sure are these facts?** Free tiers and prices change every few weeks
> (several changed during 2026, listed below). Each fact says where it came
> from: **checked** = confirmed on the provider's own pages, docs, terms or
> announcements, or on its developer forum, on 2026-11-08; **reading** = a
> dated third-party reading of the provider's console or docs (October–
> November 2026); **catalog** = a dated catalog or price list (the models.dev
> snapshot of 2026-10-26 bundled with OpenCode, LiteLLM's price list of
> 2026-11-07); **last known** = earlier docs or memory, not re-checked. Check
> the provider's page before you budget or plan a study. How the research was
> done: [at the end](#how-this-was-researched).

## In short

1. **Cheapest reliable route, no code changes: pay well under a dollar a
   run.** A whole AI Coding run of 2,000 posts costs about **$0.40–0.60** on
   GPT-6 Luna or Claude Haiku 5.5 through OpenCode Zen's pay-as-you-go, which
   MetaCode already speaks: put credit on `OPENCODE_API_KEY`. $20 covers
   roughly 35–50 runs; OpenAI and Anthropic don't train on API data.
   ([§4](#4-nearly-free-the-cheapest-paid-routes))
2. **Don't build on Zen's free models.** Since September 2026 OpenCode
   restricts them to its own app: other clients get *"403 FreeTierError:
   OpenCode's free tier can only be used from within OpenCode"*. MetaCode may
   still get through, but that can stop any day, and some free models'
   providers keep and train on prompts.
   ([§2](#2-opencode-zens-free-models-metacodes-current-default))
3. **Truly free full runs exist, with catches.** Google's Gemini API free tier
   with **Gemma 4** (30 requests/min, 14,400/day) does a run in about 3–4
   hours, but Google may use free-tier prompts and humans may read them — only
   for public, non-sensitive posts. **Hetzner's experimental inference API**
   (free while it's an experiment, EU, 10 requests/min) does one in about
   3½ hours. **Inception** gives 100 million tokens once (about 27 runs).
   ([§3](#3-free-hosted-apis))
4. **Several free providers together beat any one of them.** One account
   each at a few providers, all added to MetaCode, and MetaCode moves to
   another provider's closest model whenever one is rate-limited or paused.
   Never open several accounts at the same provider to get around its limits —
   that breaks their terms. ([§3](#3-free-hosted-apis), [§8](#8-adding-a-provider-to-metacode))
5. **"Making our own" is realistic, but not on MetaCode's small VPS.** An
   open model (Gemma 4, Qwen 3.6/3.8, gpt-oss) on one rented or campus GPU
   codes a run in under an hour for cents, with no limits and nothing leaving
   our machines; a Mac with 32 GB or a gaming PC does it for free. Best in the
   long run: **train our own small coder** on human-checked posts — it then
   codes 2,000 posts in about a minute on a CPU. ([§6](#6-making-our-own))
6. **Researchers can get it free.** George Mason's ORC cluster (152 GPUs),
   NSF ACCESS (Jetstream2 can host a model endpoint), the NAIRR program and
   company research credits (OpenAI up to $1,000, Anthropic up to
   $20,000–50,000, Google up to $5,000). ([§5](#5-free-for-researchers))
7. **Mind the data.** Free tiers are often paid for with your data, and
   social-media posts are personal data. For anything sensitive use a
   no-training paid tier, the university's licensed services (Mason ITS offers
   Azure AI Foundry API access to research teams) or a local model.
   ([§7](#7-privacy-terms-and-research-ethics))

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
  provider that speaks it ([§8](#8-adding-a-provider-to-metacode)); almost
  every provider below does.
- **Limits.** The tightest one sets how long a run takes:

  | Limit | Standard run needs |
  |---|---|
  | Requests per day (RPD) | 2,000 ÷ RPD days (500/day → 4 days; 14,400/day → under a day) |
  | Tokens per day (TPD) | 3.6M ÷ TPD days (200,000/day → 18 days) |
  | Requests per minute (RPM) | at least 2,000 ÷ RPM minutes (30 RPM → 67 min; 10 RPM → 3⅓ h) |
  | Tokens per minute (TPM) | at least 3.6M ÷ TPM minutes (16,000 TPM → about 3¾ h) |

- **Reasoning ("thinking") models.** Many current models think before they
  answer (Claude Haiku 5.5 does by default, gpt-oss and Qwen too). With
  `max_tokens` 1000 the thinking can use up the budget and cut the JSON off,
  and thinking tokens are billed as output. Turn it off or low where the
  provider allows (Zen's `#none` / `#low` variants do).
- **JSON.** Most providers can force valid JSON (`response_format` with a JSON
  schema); MetaCode doesn't ask for it yet, which matters most for small
  models.
- **Data use** — whether the provider trains on or keeps the posts
  ([§7](#7-privacy-terms-and-research-ethics)).
- **One model per run.** MetaCode's automatic switching (and "Keep going if
  the model runs out") can mix models within a run. For a study, pick one
  model, check it against human coders and report it.

## 2. OpenCode Zen's free models (MetaCode's current default)

MetaCode's AI service offers Zen's free models by default (Big Pickle,
GLM-5.3-Flash Free, DeepSeek V4.1 Flash Free and others, each "free for a
limited time"). They are a poor base for research runs:

- **They're meant for OpenCode itself.** Since about 2026-09-17 OpenCode
  restricts free-tier models to its own app and CLI. Its docs: *"Free-tier
  chat models are only available from within OpenCode; other clients receive
  HTTP 403, even with an API key. Use paid models or a Go subscription from
  other clients."* The error is `403 FreeTierError` (older OpenCode builds get
  426). MetaCode is built on OpenCode's packages and may still get through,
  but this can end at any time. **checked**
- **Unpublished daily limits.** Over the day's allowance Zen answers
  `429 FreeUsageLimitError`, and MetaCode then rests Zen for up to an hour; a
  run can't be planned around that. **checked**
- **Data.** Zen's docs say that during the free period some free models'
  providers may keep prompts and use them for training. **checked**

**OpenCode Go** ($10/month; Go Plus $40; Go Teams $20 per member) has monthly
allowances per model and, unlike the free tier, may be used from other
clients — but it's built for coding agents and watched for abuse, so check
with OpenCode before using it for bulk classification. **checked**
**Zen pay-as-you-go** is the recommended route ([§4](#4-nearly-free-the-cheapest-paid-routes)).

## 3. Free hosted APIs

Ranked for MetaCode's job (one legitimate account per provider):

| Provider | What's free | Limits | Standard run | Data use on the free tier | Sure? |
|---|---|---|---|---|---|
| **Google Gemini API** (AI Studio key, no billing linked) — **Gemma 4 31B / 26B-A4B** | the Gemma 4 models (they have no paid tier on this API) | 30 RPM, 14,400 RPD, ~16K TPM, per project | about 3–4 h | **used to improve Google's products; human reviewers may read it** ("do not submit sensitive, confidential, or personal information") | checked terms; reading/forum for limits |
| Google Gemini API — Gemini 3.5 / 3.1 Flash-Lite | the Flash-Lite models | 15 RPM, 500 RPD per project per model | 4 days on one model | as above | reading, confirmed by a Nov 2026 quota error |
| Google Gemini API — Gemini 3.8 Flash | the newest Flash | 5 RPM, 20 RPD | not viable (100 days); for trying a codebook | as above | reading, forum |
| **Hetzner Experiments — Inference API** | Qwen3.6-35B-A3B (FP8) and Qwen3.8-27B, free while experimental | per key: 10 requests, 4M input and 100K output tokens per 60 s | about 3½ h | EU (Germany); not for production, no guarantees; data terms not found | checked |
| **Inception** (Mercury 3, 2.5, 2) | one-time 100 million tokens per new account, no card | 1,000 RPM; 1M input / 100K output TPM | about 27 runs from the credit | **trains by default** — switch off "Improve the model for everyone" | checked |
| **Mistral La Plateforme** — "Experiment" plan | Mistral's API models; phone check, no card | ~1 request/s, 500K TPM, 1 billion tokens/month per model (third-party; Mistral doesn't publish them) | about 35–60 min; ~270 runs a month | **may be used for training**; opt out with "Anonymous improvement data" in the Admin panel | checked plan and data; limits third-party |
| **Groq** (no card) | gpt-oss-120b, gpt-oss-20b, qwen3.6-27b, qwen3.8-27b (preview) | per model per organization: 30 RPM, 1,000 RPD, 8K TPM, 200K TPD | 18 days on one model; about 4½ days using all four | doesn't keep prompts by default | checked |
| **OpenRouter** `:free` models | many open models (Gemma 4 31B/26B, Nemotron, GLM, Qwen…); `openrouter/free` picks one that's up | 20 RPM; 50 requests/day, or 1,000/day once you've bought $10 of credits (UTC reset; failed calls count) | 40 days, or 2 days after the $10 | **depends on the host**: about half the free models run on hosts that may train (Oct 2026 analysis); Gemma 4 free is served by Google AI Studio | checked limits; free Gemma 4 got only 429s in an early-November test |
| **OVHcloud AI Endpoints** (no key, no account) | every catalog model, anonymously | 2 requests/min per IP per model | about 17 h on one model, ~4 h across four | EU (France); "never stored or used for training" (marketing page) | checked |
| **NVIDIA build.nvidia.com** | trial endpoints for 30+ open models (Gemma 4 31B, DeepSeek V4.1 Flash, GLM…); developer account and phone check | up to 40 RPM; daily caps unpublished | about 50 min | **trial terms: internal testing and evaluation only, no production; inputs and outputs are recorded and used to improve NVIDIA's products, including AI models** | checked |
| **Cloudflare Workers AI** | 10,000 Neurons/day (some models need the paid plan since July 2026) | 300 RPM per model | about 3 days (qwen3-30b); paid ~$0.35 a run | doesn't train on prompts or keep them | checked |
| **Scaleway Generative APIs** | 1 million tokens once (payment method needed) | per-model TPM | a third of a run, then ~€0.81 a run | zero data retention by default; EU | checked |
| **Cerebras** | a one-time $5 credit after adding a card, 30 days (the free tier ended 2026-07-21) | trial: 5 RPM, 30K uncached TPM | about 3 runs (gpt-oss-120b) | doesn't keep prompts | checked |
| **Z.ai** (Zhipu) | GLM-4.7-Flash and GLM-4.5-Flash free (GLM-5.3-Flash is paid) | concurrency set per user, unpublished | a few hours (estimate) | China-based; **Zhipu is on the US Entity List** (Jan 2025) | checked |
| **Alibaba Model Studio** (international, Singapore) | ~1M tokens per model, once, 90 days | not found | a quarter of a run per model | Alibaba Cloud International terms | checked |
| **Vercel AI Gateway** | $5 every 30 days on the free tier (stops once you buy credits) | lower per-model limits | about 8 runs a month on GPT-6 Luna / Haiku 5.5 | the upstream provider's policy | checked |
| **OpenAI** — complimentary tokens for data sharing | Build tier ($5 paid): 250K tokens/day on the GPT-6 group (incl. GPT-6 Luna), 2.5M/day on smaller models; Launch/Grow tiers: 1M and 10M | daily, UTC reset | a run every ~2 weeks (Luna, Build) up to ~3 a day (small models, Launch) | **your data is used to train OpenAI's models** | checked |

**Gone or shrunk in 2026** (don't plan on them): GitHub Models (retired
2026-07-30; its endpoints now fail) **checked**; Cerebras' daily free tier
(ended 2026-07-21) **checked**; Groq's Llama models (shut down 2026-08-16 for
free and Developer accounts, now Enterprise-only) **checked**; Chutes' free
access (retired 2026-03-15; subscriptions no longer sold) **checked**;
Hugging Face's free monthly credit (free accounts now get none; PRO $9/month
includes $2) **checked**; SambaNova (its plans page now needs a payment method
and purchased credits) **checked**; Gemini's free Pro models (gone since
April 2026) **checked**; the Gemini CLI free tier, Meta's Llama API preview,
kluster.ai, Lambda's Inference API and Hyperbolic's old API **catalog**.

**Stacking free tiers.** Limits count per account (Google's per project and
model). One account each at Gemini, Hetzner, Inception, Mistral, Groq,
OpenRouter and OVHcloud, all added to MetaCode, covers several free runs a
week: MetaCode moves to another provider's closest model when one answers
429. Free tiers with 5–30 requests a minute need AI Coding's **at once** box
set to 1–4, or most requests come back rate-limited at first. What isn't
allowed: several accounts or projects at one provider to multiply its quota —
Google's terms forbid getting around quotas, and OpenRouter says extra
accounts or keys don't raise limits.

### Not recommended: "unlimited" and no-key services

- **"Free unlimited" APIs** (Pollinations — its main API now needs a free key
  and credits, the old keyless one allows one request every 30 s; LLM7;
  Puter's user-pays model): no terms you can rely on, unknown hosts and
  logging. Not for research data.
- **Chat websites** (Duck.ai, HuggingChat, the vendors' chat apps, Mason's
  PatriotAI): no API; scripting them breaks their terms.
- **Reverse-engineered wrappers** (gpt4free and similar) and relays offering
  "free GPT/Claude": they ride on other people's accounts or break the
  vendors' terms, break often, and send your data to unknown parties.

## 4. Nearly free: the cheapest paid routes

Paying is often the better "free": a standard run costs well under a dollar,
the big providers don't train on API data, limits are high, and nothing
pauses for 22 hours. Prices per million tokens (input / output); standard run
= 3.0M in + 0.6M out; "cached" assumes the codebook (about 80% of the input)
is read from the provider's prompt cache:

| Model (where) | Price in / out | Standard run | Cached | Notes | Sure? |
|---|---|---|---|---|---|
| **GPT-6 Luna** (Zen pay-as-you-go, or OpenAI) | $0.10 / $0.50 (cached input $0.01) | $0.60 | ~$0.38 | **recommended**; `#none` turns reasoning off; Batch/Flex halve it on OpenAI directly; OpenAI doesn't train on API data | checked |
| **Claude Haiku 5.5** (Zen, or Anthropic) | $0.10 / $0.50 (prompts up to 100K) | $0.60 | needs `cache_control`, which MetaCode doesn't send | backup from another company; thinks by default — use `#none`; may refuse to code some harmful posts | checked |
| gpt-oss-120b (DeepInfra) | $0.037 / $0.17 | $0.21 | — | open model; reasons by default (more output tokens) | checked |
| gpt-oss-120b (OVHcloud, with a key) | €0.08 / €0.40 | ~€0.48 | — | EU; structured output | checked |
| Gemma 4 31B (DeepInfra; LLM Gateway) | $0.13 / $0.38; $0.10 / $0.25 | $0.62; $0.45 | — | the free Gemini tier's model, without its data terms | catalog |
| Qwen3.7 Flash (Alibaba international) | $0.03 / $0.13 | $0.17 | ~$0.11 | Alibaba Cloud terms | catalog |
| **DeepSeek Flash** (`deepseek-flash`, DeepSeek) | off-peak $0.15 / $0.60 (US daytime is off-peak); peak double | $0.81 off-peak | ~$0.46 | **data stored in China, used for training unless you opt out; DeepSeek is banned on Virginia state devices and networks** | checked |
| Mistral Small 4 (Mistral) | $0.15 / $0.60 | $0.81 | ~$0.49 | EU company | catalog |
| gpt-oss-20b / 120b (Groq) | $0.075 / $0.30; $0.15 / $0.60 | $0.41; $0.81 | ~$0.32; ~$0.63 | very fast | catalog |
| Gemini 3.1 Flash-Lite (Google, paid tier) | $0.25 / $1.50 | $1.65 | ~$1.11 | paid tier isn't used for training; Batch halves it; shuts down 2027-05-07 (successor 3.5 Flash-Lite: $0.30 / $2.50) | checked |

Not recommended any more: **GPT-5 nano** ($0.05 / $0.40) shuts down on
2026-12-11 **checked**; Claude Haiku 4.5 is legacy at $1 / $5 **checked**.

What lowers the cost more than the list price:

- **Reasoning off.** Every extra 100 thinking tokens per post adds
  $0.08–0.30 to a run.
- **The same codebook prefix on every request.** OpenAI, Gemini, DeepSeek,
  Qwen and Groq cache a repeated prompt start automatically (OpenAI from 1,024
  tokens); MetaCode already sends the codebook as an identical system message.
- **Batch APIs** halve OpenAI's, Anthropic's and Google's prices for runs that
  can wait, but need an asynchronous path MetaCode doesn't have.

Zen's pay-as-you-go adds a card fee per purchase (4.6% + $0.31), so buy credit
in larger amounts. **catalog** (OpenCode's docs)

**Pick by testing, not by price.** Code 100–200 posts by hand, run them
through two or three of these models in the AI Coding Lab (cents each), and
keep the cheapest model that reaches your agreement threshold (Cohen's kappa
or Krippendorff's alpha, which MetaCode computes).

## 5. Free for researchers

| Program | What it gives | Fit | Sure? |
|---|---|---|---|
| **University research computing** — at Mason, **ORC's Hopper cluster**: 35 GPU nodes with 152 NVIDIA GPUs (A100, H100, B200) | free for faculty and faculty-sponsored students (accounts in about 3 working days); data stays on campus | best for sensitive data: run vLLM as a batch job (export the requests, import the codes) or a session endpoint over VPN | checked |
| **Mason ITS — Azure AI Foundry** | a dedicated Azure subscription for a department, college or research team, with API endpoints and keys for OpenAI, Claude and Llama models | an OpenAI-compatible API under Mason's own contract; usage is billed to the requesting unit | checked |
| **NSF ACCESS** — Explore (400,000 credits), Discover (1.5M), Accelerate (3M) | GPU time on NCSA Delta (A100, A40, H200), DeltaAI (GH200), Purdue Anvil (A100, H100), and **Jetstream2 GPU** VMs (A100, L40S, H100; a separate allocation) | Jetstream2 can host an always-on OpenAI-compatible endpoint MetaCode reaches directly (public IPs can run short) | checked |
| **NAIRR** (pilot, moving into the NSF NAIRR Operations Center since Sept 2026) | per-project allocations of GPU time and model companies' API credits for US researchers and educators | apply on nairrpilot.org any time (about 3 pages; students need an advisor's letter) | checked |
| **OpenAI Researcher Access Program** | up to $1,000 in API credits, valid 12 months | reviewed in March, June, September, December (next: December 2026); credits 4–6 weeks later | checked |
| **Anthropic AI for Science** | up to $20,000 over six months; since August 2026 up to $50,000 per project, open to any field; since October also through 20 foundations and institutions (including NSF) | if the project fits | checked |
| **Google Cloud research credits / Gemini for Research** | faculty and postdocs up to $5,000 once, PhD students up to $1,000 a year (not master's students); Gemini API credits and higher limits, reviewed monthly | paid-tier Gemini (no training) | checked |
| Chat plans for researchers: OpenAI's ChatGPT for Academic Researchers (free for 12 months for faculty and postdocs), Anthropic's free Claude Team seats for scientists | chat workspaces | **no API credits** — no use to MetaCode itself | checked |
| GitHub Education | Copilot Pro for teachers, a "Copilot Student" plan for students | no use to MetaCode now that GitHub Models is retired | checked |

At $0.40–1.65 a run, $1,000 of credits is hundreds to thousands of runs.

**At George Mason, also** (confirm with ITS and the IRB): Copilot Chat (with
enterprise data protection) is open to all, but ITS limits it to public or
general internal data; PatriotAI is chat-only with no API keys and isn't meant
for app integration; Mason classifies data (Public / Restricted / Highly
Sensitive), and that class plus the IRB's decision govern whether posts may go
to any third party; Virginia's Executive Order 46 (February 2025) bans
DeepSeek on state devices and networks, and ITS applies it to university
networks (eduroam, ResNet) even on personal devices — so for Mason work avoid
DeepSeek's own API, and to be safe other China-based APIs. **checked**

## 6. Making our own

### 6a. Host an open model ourselves

Every serious model server speaks the OpenAI Chat Completions format, so it
plugs into MetaCode as one more provider ([§8](#8-adding-a-provider-to-metacode))
— no limits, no pauses, nothing leaves our machines, and the model never
changes under us (good for reproducibility).

**Server software** **checked** (releases, docs and repositories, November
2026):

| Software | Best for | Notes |
|---|---|---|
| **vLLM** (v0.33.0, 2026-11-03) or **SGLang** | an NVIDIA GPU | continuous batching (16 posts at once is easy), prefix caching for the codebook, `response_format` JSON schema on by default |
| **llama.cpp `llama-server`** | CPUs, Macs, small GPUs | parallel slots, prompt cache, JSON-schema output (enforced with a grammar; part of JSON Schema); MIT licence |
| **Ollama** | the easiest setup | defaults throttle batch jobs: 1 request at a time and a 4K context on GPUs under 24 GB — set `OLLAMA_NUM_PARALLEL` and `OLLAMA_CONTEXT_LENGTH`; it silently drops to 1 slot when VRAM is short |
| LM Studio (headless) | a Mac or desktop | GUI plus server |
| Hugging Face TGI | — | archived in March 2026; don't use |

**Models** (open weights, late 2026) **catalog**:

| Size | Models | Runs on |
|---|---|---|
| Laptop (4–9B) | Qwen3.5-4B / 9B, Gemma 4 E4B | 8–16 GB; simple codebooks only |
| Best value (MoE, ~3–4B active) | **Qwen3.6-35B-A3B**, **Gemma 4 26B-A4B**, Nemotron 3.5 30B-A3B, **gpt-oss-20b** | a 24–48 GB GPU, or a 32 GB Mac |
| Best quality on one 24 GB card | Qwen3.8-27B, **Gemma 4 31B** (about 20 GB at 4-bit) | RTX 3090/4090/5090 |
| Strongest on one 80 GB GPU | **gpt-oss-120b** | A100/H100 80 GB |

Most of these think before answering: turn thinking off on the server, or
MetaCode's `max_tokens` of 1000 can cut the JSON off. Published studies find
open models approach frontier models but often trail them zero-shot, and
7–12B models struggle with long codebooks — check against a human-coded
sample first.

**Where to run it** (standard run):

| Where | Cost | Time | Sure? |
|---|---|---|---|
| MetaCode's own VPS (CPU, sized for the web app) | — | **not practical**: 13–40 h or more for an 8B model, and it starves the web app | estimate |
| Your own Mac (32 GB+) or a PC with an RTX 3090/4090 | free | about 10 min – 2 h | checked (llama.cpp benchmarks) |
| **Modal** — $30 of free credit every month; vLLM that scales to zero (H100 ~$3.95/h, A100 80 GB ~$2.50/h) | free up to the credit | ~30–60 runs a month with an 8B model (estimate) | checked prices |
| RunPod RTX 4090 ($0.34/h community, $0.69/h secure); RunPod Serverless vLLM (OpenAI-compatible at `api.runpod.ai/v2/<id>/openai/v1`) | cents per run | under an hour | checked |
| Datacenter GPU (H100 ~$1.60–4/h, L40S ~$0.50/h spot) | $0.10–2.50 per run | 5–70 GPU-minutes | estimate |
| **Kaggle** (30 GPU-hours a week, resets Saturday; use **T4 ×2** — current PyTorch fails on its P100), **Colab** free (T4, unpublished limits) | free | 30–75 min on a T4 — **offline batch only**: export the requests, run them in a notebook, import the codes (Colab's terms forbid web services and proxies; Kaggle's forbid compute abuse such as "server farming") | checked |
| Oracle Cloud Always Free Arm VM — **halved in 2026 to 2 cores and 12 GB** | free | small models only, very slow | checked |
| Mason's Hopper / ACCESS / Jetstream2 | free for researchers | under an hour per GPU | checked ([§5](#5-free-for-researchers)) |

### 6b. Train our own coder

The only route that removes per-post costs, rate limits and provider pauses
entirely — and the best fit for a fixed codebook:

1. A strong model (Zen pay-as-you-go, research credits) codes 600–1,000 posts
   once per codebook version; humans check them.
2. Humans also code a separate random test set of 200–300 posts.
3. Fine-tune a small classifier per codebook dimension: **ModernBERT or
   DeBERTa-v3** with a few hundred examples per dimension, or **SetFit** with
   only 8–64 checked examples per code. Training takes minutes on a free
   Kaggle/Colab GPU (30–60 min on a CPU).
4. Run it on everything: an int8 ModernBERT-base-size model coded 2,000 posts
   in about **1 minute on a 4-vCPU CPU** (measured during this research), and
   could run inside MetaCode's own Node process (Transformers.js).
5. Check it against the human test set with kappa/alpha (MetaCode computes
   both), and use estimators that correct for model errors (DSL,
   prediction-powered inference) in the analysis.

If reasoning text matters or the codebook changes often, QLoRA-tune a 4–9B
open model (Unsloth's free notebooks) on the chat-format JSONL the AI Coding
Lab already exports, and serve it as in [§6a](#6a-host-an-open-model-ourselves).
The literature backs this: fine-tuned small models match or beat zero-shot
LLMs on fixed classification tasks (Ziems et al. 2024; Bucher & Martini 2024),
and classifiers trained on LLM labels did about as well as ones trained on
human labels (Pangakis & Wolken 2024) — but LLM label quality varies by task
and can flip conclusions (Pangakis et al. 2023), so the human check stays.
**last known** (papers from memory). The AI Coding Lab can already fine-tune
through an OpenAI-compatible provider that supports it
(`AI_LAB_FINE_TUNING=on`, [ai-lab.md](ai-lab.md)).

### 6c. Our own gateway

MetaCode's AI service already is one: several providers, key rotation,
fallback to another provider's closest model. A self-hosted **LiteLLM** proxy
is worth adding only for providers that don't speak the OpenAI format, or to
pace requests per key; one-api/new-api are built for reselling keys and are
overkill.

## 7. Privacy, terms and research ethics

- **Free tiers that pay with your data:** Gemini's free tier (used to improve
  products, human review), Mistral's Experiment plan, NVIDIA's trial (records
  inputs and outputs to improve its models), Inception (by default), about
  half of OpenRouter's `:free` hosts, some of Zen's free models, Google's
  "Contributor" discount tier, and the data-for-credits programs (OpenAI's
  complimentary tokens). Use them only for public, de-identified,
  non-sensitive text, if at all. Training on posts may also clash with
  Reddit's and X's terms, which restrict letting others train models on their
  content.
- **Better terms, still free or cheap:** Groq, Cerebras, Cloudflare Workers AI,
  OVHcloud and Scaleway say they don't keep or train on prompts; OpenRouter
  can be restricted to zero-data-retention hosts per model group in its
  privacy settings (then some free models have no host left); paid tiers with
  a data processing agreement (OpenAI, Anthropic, Gemini paid, Mistral paid,
  Azure, Vertex, Bedrock).
- **Sensitive or human-subjects data** (Survey Studio answers, interviews,
  vulnerable communities): a local or campus model ([§6](#6-making-our-own)),
  or the university's licensed services (Mason ITS's Azure AI Foundry). A
  self-hosted LiteLLM proxy can mask personal data (Presidio) before anything
  leaves.
- **China-based APIs** (DeepSeek, Zhipu/Z.ai, Moonshot, Alibaba's own):
  DeepSeek stores data in China and may train on it; Zhipu is on the US Entity
  List; Virginia bans DeepSeek on state devices and networks. Use the same
  open models from US/EU hosts or locally instead.
- **The IRB** expects the protocol to name the provider, what is sent and how
  long it is kept. Note that **AI Coding sends the author's @handle, the date
  and engagement counts with every post** (`public/js/ai-coding.js`) — remove
  them from the data if the protocol requires de-identification.
- **GDPR** (EU users or EU-based posts): public posts are still personal data,
  often special-category; a research legal basis, a processor contract and
  probably a DPIA are needed. Google's terms also allow only its paid services
  for apps serving users in the EEA, Switzerland or the UK.
- **MetaCode detail:** a provider added through the config counts as *paid*
  for the switching rules (only Zen marks free models), so a free tier that
  trains could receive stand-in requests meant for a no-training model. Use
  `enabled_providers` / `whitelist` ([§8](#8-adding-a-provider-to-metacode))
  so a run can only reach the providers you approved.
- The gateway (EMIS) publishes no data policy this research could find, so
  MetaCode's older advice to use it for sensitive posts has nothing behind it.

## 8. Adding a provider to MetaCode

Providers go in a file of your own, named by `OPENCODE_CONFIG` in `.env`; it
is merged over `opencode/opencode.json` ([opencode-service.md
§5](opencode-service.md#5-the-config-file)). Each provider needs `"npm":
"@ai-sdk/openai-compatible"`, its `baseURL` and an `apiKey` — keys stay in
`.env`, referenced as `{env:NAME}`. Models come from the provider's `/models`
list, or from `models` in the file (then only those are offered); `whitelist`
keeps only the listed ids. Model ids may contain `/` and `:`.

```json
{
  "provider": {
    "gemini": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Google Gemini (free tier)",
      "options": { "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai", "apiKey": "{env:GEMINI_API_KEY}" },
      "models": { "gemma-4-31b-it": { "name": "Gemma 4 31B" }, "gemini-3.5-flash-lite": { "name": "Gemini 3.5 Flash-Lite" } }
    },
    "hetzner": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Hetzner (experimental)",
      "options": { "baseURL": "https://inference.hetzner.com/api/v1", "apiKey": "{env:HETZNER_INFERENCE_KEY}" }
    },
    "groq": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Groq",
      "options": { "baseURL": "https://api.groq.com/openai/v1", "apiKey": "{env:GROQ_API_KEY}" },
      "whitelist": ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"]
    },
    "mistral": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Mistral",
      "options": { "baseURL": "https://api.mistral.ai/v1", "apiKey": "{env:MISTRAL_API_KEY}" }
    },
    "inception": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Inception",
      "options": { "baseURL": "https://api.inceptionlabs.ai/v1", "apiKey": "{env:INCEPTION_API_KEY}" },
      "models": { "mercury-3": { "name": "Mercury 3" } }
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
HETZNER_INFERENCE_KEY=...
GROQ_API_KEY=...
MISTRAL_API_KEY=...
INCEPTION_API_KEY=...
OPENROUTER_API_KEY=...
```

Then click **Reload .env** in Settings; the new providers appear in Settings →
AI providers and their models in Settings → AI models.

- **Local servers need a key too:** MetaCode refuses a provider without one,
  so give Ollama any placeholder (`"local"`); start vLLM or llama-server with
  `--api-key` and use that value. OVHcloud's keyless mode expects no key at
  all — try it, and if a placeholder is refused, create an OVHcloud key (then
  it's paid per token).
- **The model must be reachable from the server running MetaCode's AI
  service** — `127.0.0.1` only when it runs on the same machine; a campus GPU
  behind a VPN needs a tunnel, or use the offline batch route.
- **Cloudflare's** base URL includes your account id:
  `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`.
- **Free tiers with low per-minute limits:** set AI Coding's **at once** box to
  1–4 for runs on them.
- **Only the providers you approved:** `"enabled_providers": ["gemini",
  "local"]` in the same file limits every feature to those
  ([§7](#7-privacy-terms-and-research-ethics)).
- The base URLs above come from the providers' docs (November 2026); confirm
  the current model ids in each provider's console.

## 9. What would help MetaCode use these better

Not built yet — ideas that came out of this research:

- **A per-provider request pace** (requests per minute), so free tiers with
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

On 2026-11-08 research agents covered ten areas in parallel — big-tech free
tiers, inference startups, aggregators and no-key services, model makers' own
APIs, cheap paid models, self-hosting software and models, hardware and GPUs,
academic programs, training our own model, privacy and ethics — reviewing
about 250 options. A critic looked for gaps, four more agents filled them,
and five fact-checkers then re-checked the facts the recommendations rest on
with live web searches (about 160 searches against the providers' own pages,
docs, terms, announcements and developer forums).

Limits: this session's network blocks most provider websites (only web
search, GitHub and package registries such as npm and PyPI were reachable),
so pages were read through search results; some limits are published only in
each account's console and come from dated third-party readings; and much of
the open-model and literature detail comes from catalogs, package metadata
and earlier knowledge. Hence the labels — check a number on the provider's
page before relying on it.

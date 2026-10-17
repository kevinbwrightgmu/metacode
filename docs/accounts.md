# Accounts, plans and limits

MetaCode can run with accounts: people sign in, their work is saved to their account, and what they can
do depends on their plan (Free, Pro, Max or Ultra), with usage limits and request rate limits enforced by
the server. Accounts are **off** unless the server has Supabase settings; without them MetaCode works as it
always has (no sign-in, no plans, no limits, work kept in the browser).

- **Sign-in:** [Supabase Auth](https://supabase.com/docs/guides/auth) (email + password, email
  confirmation, password reset, email sign-in links).
- **Saved work:** each account's projects and surveys, in a Supabase table protected by Row Level Security.
- **Plans:** [Stripe](https://stripe.com) subscriptions to three products.
- **Limits:** counted and enforced by the MetaCode server.

## Contents

1. [Plans](#plans)
2. [Setting it up](#setting-it-up)
3. [How it works](#how-it-works)
4. [Your work in your account](#your-work-in-your-account)
5. [Security](#security)
6. [Limitations](#limitations)
7. [File map](#file-map)

---

## Plans

The table lives in one file, `public/js/plans.js`. The server enforces it and the pages show it, so
changing a number there changes it everywhere.

| | Free | Pro | Max | Ultra |
|---|---|---|---|---|
| **AI coding** (posts coded by the AI, per week — resets Monday 00:00 UTC) | 850 | 2,300 | 4,000 | 100,000 |
| Other AI requests per day (assistant, column detection, Test connection) | 40 | 150 | 500 | 5,000 |
| AI requests per minute · AI coding runs at once | 20 · 1 | 40 · 2 | 80 · 3 | 200 · 6 |
| **Survey Studio** | — | Basic | Full | Full |
| Live surveys at once · responses per month | — | 3 · 300 | 25 · 5,000 | 250 · 100,000 |
| IP address, location and session timelines in surveys | — | — | ✓ | ✓ |
| **Reddit Scraper** (jobs per day · items per job · items per month) | — | 3 · 100 · 1,000 | 100 · 5,000 · 100,000 | 1,000 · 25,000 · 2,000,000 |
| Scrapes at once | — | 1 | 3 | 5 |
| AI Scraper (beta) and custom scraper code | — | — | ✓ | ✓ |
| **Social network analysis** (Analyze CSV / NetworkX runs per day; Network Graph) | — | — | ✓ (100) | ✓ (1,000) |
| **AI Coding Lab** (model calls per day · tokens per month · evaluation runs per day · storage) — [docs/ai-lab.md](ai-lab.md) | — | — | — | 2,000 · 50M · 50 · 500 MB |

Every account, Free included, can import data, build codebooks, code by hand, compute reliability, see
metrics and export.

- **Periods:** "Per week" (AI coding posts) runs Monday to Sunday and resets every Monday at 00:00 UTC.
  "Per month" is the calendar month in UTC (limits reset on the 1st); "per day" ends at
  midnight UTC.
- **Free has no subscription:** it's simply a signed-in account.
- **Ultra's numbers are fair-use ceilings:** they stop runaway use, not normal work.

**What counts:**

- **AI coding:** each post sent for AI coding, whether in a batch or a single retry.
  - When a run needs more posts than are left, MetaCode asks first and codes what's left.
  - The rest of the batch gets a "limit reached" answer.
- **Failed AI answers:** given back.
- **Scrapes:**
  - A scrape's item limit is lowered to what the plan allows per job and what's left that month.
  - It's charged for what it actually collected.
- **Survey responses:** counted against the survey owner's plan when a respondent starts one. A survey
  whose owner has no allowance left stops accepting responses. Respondents only see "This survey isn't
  accepting responses right now"; nothing about the owner's plan is shown to them.
- **Downgrades:**
  - What you already made stays reachable: published surveys, their responses and exports.
  - What needs the plan stops: publishing more, new responses, new scrapes.

---

## Setting it up

### 1. Supabase

1. **Create the table.** In the Supabase dashboard open **SQL Editor → New query**. Paste
   `supabase/migrations/20261012000000_metacode_accounts.sql` and click **Run**. (Or use the Supabase CLI:
   `supabase db push`.) It creates `public.metacode_data` with Row Level Security, so each signed-in user
   can read and write only their own rows. Running it again is safe.
2. **Set the Auth URLs.** Go to **Authentication → URL Configuration**.
   - **Site URL:** your MetaCode address, e.g. `https://metac0.de`.
   - **Redirect URLs:** add `https://metac0.de/app.html`. This is where confirmation, password-reset and
     sign-in links return.
3. **Email.** **Authentication → Providers → Email** should be on.
   - Keep **Confirm email** on: an account has to own its address.
   - For real use, set up **custom SMTP** (Authentication → Emails). Supabase's built-in sender is meant for
     testing and sends only a few emails an hour.
4. **Copy the keys.** Under **Project Settings → API Keys**, copy the **publishable** key
   (`sb_publishable_…`).
   - **Never** use the secret (`sb_secret_…`) or `service_role` key. MetaCode sends this key to browsers,
     so it refuses a secret one.

### 2. Stripe

1. **Products.** The three products already exist: Pro `prod_VQeJh2lPqfmae9`, Max `prod_VQeK26tKchu1VI`
   and Ultra `prod_VQeKXAJtQQLKqm`.
   - Each needs a **default price** that is **recurring** (e.g. monthly). MetaCode sells the default price
     unless you set `STRIPE_PRICE_PRO` / `_MAX` / `_ULTRA`.
   - The plan cards show the price's amount and interval.
2. **Customer portal.** In **Settings → Billing → Customer portal**:
   - Turn on cancellations and **switching plans**.
   - Add the three products' prices.

   "Manage subscription" opens this page, and a subscriber who chooses another plan is sent there, so no
   second subscription is created.
3. **Webhook.** In **Developers → Webhooks → Add endpoint**:
   - **URL:** `https://metac0.de/api/billing/webhook`.
   - **Events:** `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`.
   - Copy its **Signing secret** (`whsec_…`).

   Without a webhook, plan changes still arrive, just later. MetaCode re-checks Stripe every five minutes,
   on return from checkout, and when the person clicks Refresh on the Account page.
4. **Secret key.** Copy it (`sk_live_…`). A restricted key works if it has these permissions:
   - Customers: write
   - Checkout Sessions: write
   - Subscriptions: read
   - Products and Prices: read
   - Customer portal: write

### 3. MetaCode's `.env`

```ini
SUPABASE_URL=https://rebxueqhguxicpazvjdv.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
PUBLIC_URL=https://metac0.de            # Stripe's return links (otherwise taken from the request)
# ACCOUNT_PLAN_OVERRIDES=you@example.edu=ultra   # staff / testers; verified emails or user ids
```

Then run `npm install` (it adds `@supabase/supabase-js`, which MetaCode serves to browsers at
`/vendor/supabase.js`) and restart: `pm2 reload metacode`.

- **Check it:** Settings → AI connection's status data (`GET /api/settings/status`) includes
  `accounts: { enabled, billing, webhook, problems }`.
- **Check Stripe:** `npm run billing:check` asks Stripe, with the server's own `.env`, whether each plan's
  product exists in the key's mode and has an active recurring default price, whether the customer portal
  is set up, and whether a webhook endpoint sends the needed events. It prints what to fix, and it's
  read-only: nothing in Stripe is changed.
- **"Billing isn't set up correctly":** this message means Stripe refused a request. The server log
  (`pm2 logs metacode`) has a `[billing]` line with Stripe's reason. The usual causes are products made in
  test mode while the key is live (or the other way round), and a default price that's one-time instead
  of monthly.
- **Behind nginx:** also set `TRUST_PROXY` (see `docs/deploy-vps.md`), so per-account limits and logs see
  real addresses.

---

## How it works

```
browser ── sign in ──▶ Supabase Auth            (supabase-js, publishable key)
browser ── its work ─▶ Supabase metacode_data   (Row Level Security: own rows only)
browser ── mc_session cookie (access token) ──▶ MetaCode server
                                                   ├─ GET /auth/v1/user  → who it is (Supabase)
                                                   ├─ Stripe subscriptions → which plan
                                                   └─ usage counters → allowed? count it
```

- **The session token:** after sign-in, the page puts the Supabase access token in the `mc_session` cookie
  (`SameSite=Strict`; `Secure` on https). It expires with the token, and supabase-js refreshes it before
  then.
- **Checking the token:** the server never trusts what a token claims. It asks Supabase Auth
  (`GET /auth/v1/user`) whether the token is valid and whose it is, and remembers the answer for a minute.
- **The plan:** the server takes it from the account's Stripe subscription.
  - An active, trialing or past-due subscription to one of the three products counts; the highest one
    wins.
  - The answer is remembered for five minutes, or until a webhook says it changed.
  - The browser never says which plan it has.
- **Usage counters:** kept in `ACCOUNT_DATA_DIR/usage.json` (with the Stripe customer of each account),
  written atomically. Work is reserved before it starts and settled afterwards, so two runs at once can't
  overshoot a limit, and failures are given back.
- **Errors:** answers use the usual `{ error: { type, message } }`. The pages turn them into the right
  dialog.

  | Status | `type` | When |
  |---|---|---|
  | 401 | `sign_in_required` | Needs an account (or the sign-in expired) |
  | 402 | `plan_required` | Not in this plan — `requiredPlan`, `feature` say what would include it |
  | 429 | `limit_reached` | A weekly, monthly or daily allowance is used up — `meter`, `used`, `limit`, `resetsAt`, `upgradeTo` |
  | 429 | `account_rate_limited` | Too many requests a minute, or too many runs at once (`Retry-After`) |
  | 503 | `account_unavailable` | Supabase or Stripe couldn't be reached just now |

### What is enforced where

| Feature | Server route | Rule |
|---|---|---|
| AI (all features) | `POST /api/ai`, `POST /api/ai/batch` | Signed in; per-minute rate; AI coding posts per week (batch requests and `X-MetaCode-Feature: coding`); other AI requests per day; AI coding runs at once |
| Reddit Scraper | `/api/scraper/*` except `GET /status` | Pro+; custom code and AI mode Max+; scrapes at once; jobs per day; items per job and per month |
| In-app Reddit browser | WebSocket `/wisp/` | Pro+ (the server's own connection from this machine is exempt) |
| Network analysis | `POST /api/network/analyze` | Max+; runs per day |
| Survey Studio | `POST /api/surveys`, `PUT`, duplicate, library, publish, reopen | Pro+; live surveys at once; IP / location / session timelines Max+ |
| Survey responses | `POST /api/public/surveys/:id/responses` | Counted against the owner's plan |

- **Gated pages:** Scraper, AI Scraper, Analyze CSV and Network Graph show what plan they need instead of
  their content, and the sidebar marks them PRO / MAX.
- **The Network Graph is browser-only:** it runs entirely in the browser, so for it this page gate is the
  whole restriction.
- **Everything else is enforced twice:** the page explains it, and the server enforces it.

### Routes

| Method & path | Purpose |
|---|---|
| `GET /api/account/config` | `{ enabled, supabaseUrl, publishableKey, billing }` — public values only |
| `GET /api/account/prices` | Plan prices from Stripe (for the plan cards) |
| `GET /api/account/me` | The signed-in account, plan, features, limits and usage |
| `POST /api/account/claim` | Moves what this browser published before signing in (surveys, responses, library, scrapes) to the account |
| `POST /api/billing/checkout` `{ plan }` | A Stripe Checkout page (or the portal for someone already subscribed) |
| `POST /api/billing/portal` | Stripe's billing portal |
| `POST /api/billing/sync` | Re-checks Stripe now |
| `POST /api/billing/webhook` | Stripe → MetaCode (signature checked with `STRIPE_WEBHOOK_SECRET`) |

---

## Your work in your account

When someone is signed in, `public/js/cloud-sync.js` keeps their work in their account as well as in the
browser:

| `kind` | What |
|---|---|
| `workspace` | The open project (posts, codes, codebook, network, settings) |
| `projects` | Saved projects |
| `surveys` | Survey Studio drafts |
| `meta` | The Survey Studio library and other small things |

API keys typed into MetaCode (Reddit app keys, the RedditAPIs.com key) are never synced.

- **Saving:**
  - Changes are saved in the browser first and sent to the account a few seconds later.
  - They're retried with back-off while offline.
  - The Account page shows the sync state.
- **Fetching:** changes from other devices are fetched when a page opens, when the tab becomes visible
  again, and every minute.
- **Conflicts:**
  - When the open project changed on two devices, the one in front of you stays open and the other is
    kept as a saved project ("… (from another device)").
  - Saved projects and drafts: the most recent change wins.
- **First sign-in on a browser:**
  - **Existing work:** MetaCode asks whether to add the browser's work to the account, or remove it from
    the browser.
  - **Adding it:** what that browser had published moves to the account too, on the server.
  - **The account's own open project:** if the account already had one, it's kept as a saved project.
- **Signing out:** the remaining changes are sent first, then MetaCode offers to remove the work from the
  browser (recommended on shared computers).
- **Signing in to a different account:** if the browser still holds another account's work, MetaCode
  removes it first, or lets you sign out instead.
- **Size limits:** a single record can be at most ~24 MB (the table refuses more than 25 MB), and an
  account at most 5,000 records.

---

## Security

- **Identity:** never taken from the client. The server identifies people only from a token Supabase
  confirms, and their plan only from Stripe (or `ACCOUNT_PLAN_OVERRIDES` in the server's own settings; by
  email only when the email is verified).
- **What's public:**
  - The publishable key is public by design, and the server refuses to hand out a secret or
    `service_role` key.
  - Row Level Security is what separates accounts' data. The policies allow a row only when
    `user_id = auth.uid()`, a trigger stops `user_id` from being changed, and anonymous visitors get no
    access.
  - The table holds only people's own work. Plans, usage and billing are kept by the MetaCode server, so
    nothing a user writes there can change what they're allowed to do.
- **What stays on the server:** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` never leave it and never
  appear in errors or logs. Stripe errors are logged as status and error type only.
- **Webhooks:** must carry a valid `Stripe-Signature` (HMAC-SHA256, at most five minutes old).
- **Cross-site protection:** state-changing account and billing routes accept only same-site requests, and
  the session cookie is `SameSite=Strict`.
- **Tokens:** cached by their SHA-256 hash; tokens themselves are never stored or logged.
- **Usage file:** `usage.json` is written with mode 0600. It holds counters, Stripe customer ids and
  verified emails (for overrides).

---

## Limitations

- **One server process:** usage counters, the plan cache and rate limits live in that process (with the
  counters saved to a JSON file). Several MetaCode processes behind a load balancer would each count
  separately; this deployment runs one (pm2, `instances: 1`).
- **Plan changes without a webhook:** they take up to five minutes to apply (or a click on Refresh).
- **Live services not tested here:** the tests use local stand-ins for Supabase and Stripe
  (`test/helpers/account-mocks.js`). They prove MetaCode's code against the documented APIs, not the live
  project's configuration. Check sign-up, checkout and the webhook once with Stripe's test mode
  (`sk_test_…`) before going live.
- **Email:** confirmation and reset emails depend on Supabase's email settings (custom SMTP for real use).
- **Unenforceable features:** client-only features (human coding, the Network Graph's drawing, metrics)
  run entirely in the browser. Only their page gates restrict them.

---

## File map

```
public/js/plans.js                     The plans and their limits (server and pages)
public/js/account.js                   Sign-in, dialogs, plan gates, the Account page, the account chip
public/js/cloud-sync.js                The account's copy of the browser's work (Supabase metacode_data)
public/css/account.css                 Their styles
accounts/index.js                      Guards, policies, /api/account and /api/billing routes
accounts/auth.js                       Verifying sessions with Supabase Auth
accounts/billing.js                    Plans from Stripe, checkout, portal, webhook signatures
accounts/usage.js                      Usage counters (ACCOUNT_DATA_DIR/usage.json)
accounts/rate.js                       Per-minute rates and things running at once
accounts/config.js                     Settings from the environment
supabase/migrations/…_metacode_accounts.sql   The table, Row Level Security and triggers
test/accounts.test.js                  Plans, counters, signatures; the server enforcing every plan
test/accounts-e2e.test.js              The pages in a browser: sign-up, sync, gates, checkout, upgrade, sign-out
test/helpers/account-mocks.js          Local stand-ins for Supabase and Stripe
```

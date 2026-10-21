# Secrets and secret scanning

MetaCode's credentials live only in the server's environment (`.env` on the
server, or the deployment's secret store), never in the repository. Their
names, and where each one is used, are listed in [`.env.example`](../.env.example),
which holds empty values and placeholders only. Signing material for the
desktop app lives in GitHub Actions secrets ([desktop/RELEASING.md](desktop/RELEASING.md)).

`.gitignore` keeps `.env`, `.env.*` (except `.env.example`), key and
certificate files (`*.pem`, `*.key`, `*.p12`, `*.pfx`), the files MetaCode
writes keys to (`reddit-credentials.json`, `redditapis-key.json`) and the data
folders out of Git.

## Scanning

[TruffleHog](https://github.com/trufflesecurity/trufflehog) runs on every pull
request and every push to `main` (`.github/workflows/secret-scan.yml`). It
scans the new commits and fails on a **verified** secret (the provider accepted
it) or an **unknown** one (verification couldn't finish).

Scan the whole history yourself (TruffleHog 3.99.3 or later, from its
[releases](https://github.com/trufflesecurity/trufflehog/releases); check the
download against the release's `checksums.txt`):

```bash
trufflehog git file://. --results=verified,unknown,unverified --no-update   # every commit, every branch
trufflehog filesystem . --exclude-paths=<file listing node_modules/ and dist/> --no-update   # the working tree
```

Before committing, `trufflehog git file://. --since-commit HEAD --results=verified,unknown --fail`
checks what you're about to add.

### Known findings (not credentials)

The October 2026 audit (3.99.3, 113 commits, all branches; working tree;
`collector/dist`; the packaged desktop app) found **no verified and no real
secrets**. It reported 7 `URI` findings, all URLs with a placeholder password:

| Where | What |
|---|---|
| `.env.example`, `docs/scraper-network.md` | example proxy URLs (`http://user:<placeholder>@host:port`) |
| `test/scraper-durable.test.js` | test fixtures pointing at non-routable `*.internal` hosts |

They are marked `trufflehog:ignore` in the current files. Older commits still
contain them without the mark, so a whole-history scan lists them (that is
why CI scans new commits only). Two historical values of `EMIS_API_KEY` in
`.env.example` were placeholders too (`emis-...`, `your-key`).

## If a real secret is found

1. **Rotate it first** with the provider that issued it (Reddit:
   <https://www.reddit.com/prefs/apps>; Stripe, Supabase, Google Cloud, X,
   LinkedIn: their dashboards; the AI service: its operator). Deleting it from
   the file does not remove it from Git history, and anyone who cloned the
   repository already has it.
2. Put the new value in the server's `.env` (or the deployment's secret
   store) and restart; never in a tracked file.
3. Remove the old value from the tracked file.
4. Rewriting history (`git filter-repo`) is optional once the secret is
   rotated, and needs everyone's agreement: it changes every later commit,
   breaks open pull requests and existing clones.

## Reddit credentials

The server's Reddit Data API keys are `REDDIT_CLIENT_ID` and
`REDDIT_CLIENT_SECRET` in `.env` (with `SCRAPER_USER_AGENT`), optional: users
can add their own on the Scraper page instead. To create them, see
[reddit-scraper.md › Reddit API credentials](reddit-scraper.md#reddit-api-credentials) (an app at
<https://www.reddit.com/prefs/apps>, under Reddit's Data API terms).

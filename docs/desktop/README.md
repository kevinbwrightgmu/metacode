# MetaCode Sheets — the desktop spreadsheet

MetaCode Sheets is an installable spreadsheet for Windows, macOS and Linux
with MetaCode's research tools built in: AI help with formulas and data, AI
Coding of text columns with a codebook, intercoder reliability, and the
account's MetaCode projects and scraper results. It is part of the **Pro, Max
and Ultra** plans; the MetaCode server checks the plan with the same accounts
(Supabase) and billing (Stripe) as the website.

- Code: `desktop/` (the app) and `desktop-api/` (its server routes)
- Releasing, signing and notarization: [RELEASING.md](RELEASING.md)

## Architecture

```
┌──────────────────────── MetaCode Sheets (Electron) ────────────────────────┐
│ Window (sandboxed, no Node.js, no network)                                 │
│   src/renderer  — sign-in/upgrade screens, home, canvas grid, toolbar,     │
│                   dialogs, MetaCode sidebar                                 │
│   src/shared    — spreadsheet engine (parser, ~160 functions, dependency   │
│                   graph, formats, undo) and file formats (.mcsheet,        │
│                   .xlsx, CSV) — plain ES modules, also used by tests        │
│        │ window.sheets (preload): a fixed list of requests                  │
│ Main process                                                               │
│   auth.js         Supabase sign-in (password; optional emailed link, PKCE)  │
│   entitlement.js  asks the server; offline only on a signed lease           │
│   secure-store.js session + lease, encrypted by the OS keychain             │
│   files.js        library, atomic saves, backups, conflicts, recovery       │
│   platform.js     AI, AI Coding, models, projects, scraper results          │
│   protocol.js     app://sheets — only the app's files, strict CSP           │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │ HTTPS, Bearer token (main process only)
┌────────────────────────────────▼───────────────────────────────────────────┐
│ MetaCode server (server.js)                                                │
│   /api/desktop/config       public: Supabase project, lease public key     │
│   /api/desktop/entitlement  plan from Stripe → signed lease (Ed25519)      │
│   /api/desktop/ai, /ai/batch  plan-checked and metered like the website    │
│   /api/models, /api/scraper/jobs…  existing routes, same account            │
│ Supabase: auth, metacode_data (projects; row-level security)               │
└────────────────────────────────────────────────────────────────────────────┘
```

Why Electron: the platform is JavaScript end to end (the engine, the
reliability statistics and the AI Coding prompts are shared with the
website), Electron gives OS keychain encryption (`safeStorage`), a
dependable cross-platform build chain (electron-builder) and end-to-end
testing of the real app (Playwright).

## How Pro, Max and Ultra access is enforced

1. **Sign-in** happens in the main process against Supabase. The window
   never sees a token.
2. **The server decides.** `GET /api/desktop/entitlement` verifies the token
   with Supabase and reads the plan from Stripe (`public/js/plans.js`, feature
   `desktop`). Free and canceled plans get `entitled: false` and the app shows
   the upgrade screen (with the real upgrade page, `/app.html#account`).
3. **Leases for offline use.** An entitled answer carries a lease: account,
   plan, server and expiry, signed with the server's Ed25519 key
   (`DESKTOP_LEASE_PRIVATE_KEY`). The app keeps it (encrypted) and, when the
   server can't be reached, opens only if the lease's signature is valid with
   the server's key — pinned into release builds — and it is for this account
   and server, not expired (`DESKTOP_OFFLINE_HOURS`, default 72) and the
   computer's clock hasn't been turned back past the last time the app saw.
   Editing the lease (a later expiry, another plan) breaks its signature.
4. **Re-checks** every 15 minutes, on resume from sleep and when the network
   comes back. A downgrade locks the app at the next check; unsaved work is
   copied to the recovery folder first.
5. **Locked means locked in the main process too.** While locked, the main
   process refuses workbook, clipboard, import/export, AI and project
   requests from the window, whatever the window sends.
6. **Server features are checked on the server, every time.** AI, AI Coding,
   projects and scraper results run on MetaCode with the account's plan and
   limits — a modified app gains nothing there.

What can't be enforced on a computer the user controls: someone who patches
the app's binary can make its *local* spreadsheet run without a plan. Release
builds make that harder (fuses: no `ELECTRON_RUN_AS_NODE`, no
`--inspect`, ASAR integrity checking; pinned lease keys), and everything that
reaches MetaCode stays plan-checked by the server.

## Spreadsheet features

- **Grid:** up to 1,048,576 rows × 16,384 columns, drawn on a canvas (only
  what's in view), frozen rows/columns, hidden rows/columns, resizing (drag,
  double-click to fit), zoom 50–200 %, gridlines, light and dark themes.
- **Editing:** typing, F2, formula bar and name box, Alt+Enter line breaks,
  Ctrl+Enter fills the selection, F4 cycles `$` references, click-to-insert
  references while typing a formula, function autocomplete and argument
  hints; Tab/Enter navigation as in Excel.
- **Formulas:** ~160 functions (math, statistics, conditional aggregates,
  logic, text, dates, lookup including XLOOKUP, information) plus MetaCode's
  `PERCENTAGREEMENT`, `COHENKAPPA`, `WEIGHTEDKAPPA`, `KRIPPENDORFF`;
  automatic recalculation of only what depends on a change; circular
  references reported; references adjusted on copy, insert, delete, move and
  sheet rename.
- **Formatting:** number formats (Excel codes, presets, more/fewer decimals),
  fonts, sizes, bold/italic/underline/strikethrough, text and fill colours,
  borders, horizontal/vertical alignment, indent, wrap.
- **Data:** copy/cut/paste (formulas adjusted; text from other apps), paste
  values, drag-fill and double-click fill (series of numbers, dates, weekdays,
  "Item 1…"), undo/redo (200 steps), sort (several keys, header detection),
  filters (values and conditions), find and replace (case, whole cell,
  formulas, all sheets, regex), remove duplicates, trim whitespace, AutoSum.
- **Sheets and workbooks:** add, rename, duplicate, delete, reorder (drag),
  tab colours; workbooks as tabs; new, open, rename, duplicate, delete (to
  the trash), recent files.
- **Files:** `.mcsheet` (JSON); import `.xlsx`/`.xlsm` (values, formulas,
  styles, widths, heights, hidden rows/columns, frozen panes, filters, tab
  colours, 1904 dates) and CSV/TSV (encoding and delimiter detection; long
  IDs, leading zeros and `=` text kept as text); export `.xlsx`, CSV, TSV
  (with CSV-injection protection).
- **Safety of your work:** AutoSave (a few seconds after each change), atomic
  saves with the last 5 versions kept as backups, recovery snapshots every 5
  seconds with an offer to restore after a crash, warnings instead of
  overwriting when another program changed, moved or deleted the file.
- **Keyboard shortcuts** (Help › Keyboard Shortcuts), context menus, a native
  menu bar, screen-reader announcements of the active cell.

## MetaCode features in the app

| Feature | Where it runs | What it uses |
|---|---|---|
| AI Assistant: formula from a description, explain, insights, ask | MetaCode AI (`/api/desktop/ai`) | the account's AI requests |
| AI clean-up of a column (with a preview of every change) | MetaCode AI | the account's AI requests |
| AI Coding of a text column with a codebook | `/api/desktop/ai/batch` — the website's prompts | the plan's AI Coding posts |
| Intercoder reliability (agreement, Cohen's κ, weighted κ, Krippendorff's α) | on the computer — the website's statistics | — |
| Open a MetaCode project as a workbook; save a sheet as a new project | Supabase `metacode_data` (row-level security) | the account's projects |
| Import scraper results | `/api/scraper/jobs/:id/results` | the account's scraper jobs |
| AI model choice | `/api/models` | — |

AI output is always marked (violet, "AI"), shown as a preview, and written to
the sheet only when you apply it — as one step that Undo reverses. Each tool
says what it sends before it sends it. Offline, these tools say they need a
connection; nothing is simulated.

## Downloading the app

People download MetaCode Sheets from the website: **`/download`** (linked from
the homepage, its footer, and the account page of Pro, Max and Ultra
accounts). The page picks the installer for the visitor's computer and lists
every platform with sizes and SHA-256 checksums.

The files come from the newest **published** GitHub release tagged
`desktop-v<version>` (see [RELEASING.md](RELEASING.md)); drafts and
pre-releases never appear. The server looks the release up through GitHub's
API (cached 10 minutes, kept when GitHub can't be reached, retried at most
once a minute) and gives each file a stable link that always means the
current version:

| Link | File |
|---|---|
| `/download/desktop/windows` | Windows installer (`.exe`) |
| `/download/desktop/windows-msi` | Windows `.msi` (IT deployment) |
| `/download/desktop/mac-arm64`, `/download/desktop/mac-x64` | macOS `.dmg` (Apple silicon, Intel) |
| `/download/desktop/linux-appimage`, `/download/desktop/linux-deb` | Linux AppImage, `.deb` |
| `/download/desktop/checksums` | `SHA256SUMS.txt` |

`GET /api/desktop/downloads` returns the version, date and file list the page
shows. When nothing is published yet, the page says so instead of showing
buttons. To serve installers from the server instead of GitHub, put them in a
folder and set `DESKTOP_DOWNLOADS_DIR`.

## Build and install

Requirements: Node.js 22, npm. From the repository root:

```bash
npm ci                         # the server (for the app's end-to-end tests)
cd desktop && npm ci           # Electron, electron-builder, Playwright
```

| | Development | Installer | Install |
|---|---|---|---|
| Windows | `npm start` | `npm run dist:win` (on Windows) → `dist/MetaCode-Sheets-<v>-win-x64.exe` (NSIS) and `.msi` | run the `.exe` (per-user, choose folder) or the `.msi` |
| macOS | `npm start` | `npm run dist:mac` (on a Mac) → `.dmg` and `.zip` for `x64` and `arm64` | open the `.dmg`, drag to Applications |
| Linux | `npm start` | `npm run dist:linux` → `.AppImage` and `.deb` | `chmod +x *.AppImage && ./MetaCode-*.AppImage`, or `sudo apt install ./MetaCode-*.deb` |

Development options (ignored by installed builds): `--server=http://localhost:3000`
(or `METACODE_SHEETS_SERVER`), `--user-data=<dir>`, `--library=<dir>`,
`--dev` (DevTools), `--insecure-test-store` (unencrypted session file, for
machines without a keyring).

On Linux the session is encrypted with the Secret Service (GNOME Keyring,
KWallet). Without one, the app still works but asks for the password at each
start and can't open offline.

## Commands (in `desktop/`)

| | |
|---|---|
| `npm start` / `npm run dev` | run the app (dev: with DevTools) |
| `npm test` | unit tests: engine, file formats, main process, access rules, window logic |
| `npm run test:e2e` | end-to-end tests of the real app (Linux: `xvfb-run -a npm run test:e2e`) |
| `npm run typecheck` | type-check main, preload, window and engine |
| `npm run sync` | copy the website's shared scripts into `src/renderer/vendor` |
| `npm run dist` / `dist:linux` / `dist:win` / `dist:mac` | installers in `desktop/dist/` |

CI: `.github/workflows/desktop.yml` runs the tests on Linux, Windows and macOS
for every change to the app or its API, builds the installers on each
platform on demand (`workflow_dispatch`) and for tags `desktop-v*`, and
attaches them to a draft release — once published, it's what `/download` offers.

## Server settings

Set on the MetaCode server (`.env`; see `.env.example`):

| Variable | |
|---|---|
| `DESKTOP_ENABLED` | `false` turns desktop access off (default on) |
| `DESKTOP_OFFLINE_HOURS` | how long a lease lasts offline (1–336, default 72) |
| `DESKTOP_LEASE_PRIVATE_KEY` | Ed25519 private key (PEM) that signs leases; generated into `ACCOUNT_DATA_DIR` if unset. **Secret.** |
| `DESKTOP_MIN_VERSION` | older app versions are asked to update |
| `DESKTOP_RELEASES_REPO` | GitHub repository whose published `desktop-v*` releases the download page offers (default `kevinbwrightgmu/metacode`; `off` turns downloads off) |
| `DESKTOP_GITHUB_TOKEN` | optional, raises GitHub's rate limit for the release lookup. **Secret.** |
| `DESKTOP_DOWNLOADS_DIR` | optional: serve installers from this folder on the server instead of GitHub |
| `DESKTOP_DOWNLOAD_URL` | where "Download the new version" points (default: this site's `/download`) |
| `DESKTOP_EMAIL_LINK` | offer "email me a sign-in link" (needs `metacode-sheets://auth-callback` in Supabase's redirect URLs) |
| `DESKTOP_WITHOUT_ACCOUNTS` | private single-user servers only: no sign-in |

## Performance (measured)

On the CI-class Linux container used for development (`npm test`,
`npm run test:e2e`):

- 100,000 rows × 5 columns (100,000 formulas): opens in ~3 s; drawing a
  screen while scrolling: median ~5 ms; typing a value and recalculating its
  dependents: ~50 ms.
- Engine: 200,000 cells load in ~0.7 s; one edit with one dependent ~0.6 ms;
  20,000 dependents recalculate in ~120 ms; inserting a row in a 200,000-cell
  sheet ~330 ms.
- `.xlsx`: 100,000 cells write in ~0.3–0.5 s and read (with recalculation) in
  ~0.6–1 s.

These are single-machine measurements, not guarantees; run the tests to
measure on your hardware.

## Known limitations

- Not yet: charts, pictures, comments, merged cells (imported merged cells
  are shown unmerged), conditional formatting, data validation, pivot tables,
  array formulas that spill, named ranges, cell protection, printing.
- `.xls` (Excel 97–2003) and `.ods` aren't read; `.xlsx` features listed above
  as "not yet" are dropped on import (the app says which).
- No real-time collaboration or cloud sync of `.mcsheet` workbooks: workbooks
  live on the computer. MetaCode projects are exchanged explicitly (open /
  save as new project).
- Updates are installed manually (no auto-updater yet).
- The emailed sign-in link needs a Supabase redirect URL and
  `DESKTOP_EMAIL_LINK=true`; otherwise accounts without a password sign in by
  setting one on the website.
- Client-side gating of the local spreadsheet can be bypassed by patching the
  binary (see above); server features cannot.
- Windows installers are built on Windows (or with Wine); macOS `.dmg` files on
  macOS. Unsigned builds trigger SmartScreen / Gatekeeper warnings.

## Roadmap (by priority)

1. Code signing and notarization in CI with the production certificates;
   pinned production lease key (`vars.DESKTOP_LEASE_PUBLIC_KEYS`).
2. Signed auto-updates (electron-updater with signature checks).
3. Charts and conditional formatting (most-requested for analysis).
4. Merged cells, comments, data validation; `.ods` import.
5. Cloud workbooks in the account (sync with conflict handling) and sharing.
6. Pivot tables and named ranges; spilled array formulas.
7. Two-way project sync (write coding results back to an existing project).

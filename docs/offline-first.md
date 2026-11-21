# MetaCode offline-first: architecture and plan

> One app. Any device. Works offline. Your AI, your hardware, your data.

This document describes how MetaCode becomes lightweight, offline-first and able to run on almost any
device. It also covers its built-in AI Model Store for local models. It is the same MetaCode: every
feature, the branding, the workflows and the data formats stay.

Status: **in progress**. Each phase below is ticked once it is built and tested. The platform matrix
and the measurements are filled in from real runs, never from guesses.

## 1. What the audit found

A seven-part audit read the whole codebase before anything changed. Its main findings:

| Area | Today | What stops "offline, any device" |
|---|---|---|
| Browser app (`public/`) | 7 static pages, no build step. The open project is in `localStorage['strata_v1']`; saved projects and surveys are in IndexedDB `metacode`. | `app.html` loads PapaParse, Chart.js and D3 from jsDelivr as blocking scripts: offline, CSV import, charts and the network graph break. Every page loads Google Fonts and Google Analytics. There is no manifest, no app service worker and no icons. Phones get no navigation (the sidebar is hidden at ≤900 px with nothing in its place). |
| Data and sync | Local-first already. Accounts (Supabase) are optional, and CloudSync mirrors data when signed in. | Nothing structural. Offline work continues, and the sync queue persists. |
| Server (`server.js`) | One Express process; `require` takes 122 ms and idle RSS is ~68 MB. | It waits up to 15 s for an absent AI service before announcing itself. A Python worker (+26 MB) starts at boot even if nobody scrapes. The status monitor spawns Python every 5 minutes. Data folders sit next to `server.js`, which fails on read-only installs. |
| AI | MetaCode → its AI service (`opencode/`, port 4097) → providers: OpenCode Zen, the EMIS gateway, OpenAI-compatible servers, and Ollama as a last-resort backup. | Cloud providers get the prompts. Local models can't be the default. Models can't be browsed or installed from the app. |
| Scraper, AI Lab, publishing, collaboration | Server features. | They need the server, and scraping needs the internet. These stay online features, clearly marked. |
| Desktop app (`desktop/`) | "MetaCode Sheets", a separate Electron product. | Not the main app. Out of scope here, apart from noting that its engine is browser-portable. |

## 2. Architecture

### One codebase, three ways to run it

```
            ┌──────────────── the browser (any device) ────────────────┐
            │  MetaCode pages + service worker (offline shell)          │
            │  data: localStorage / IndexedDB (unchanged formats)       │
            │  views: … existing pages … + Model Store, Installed       │
            │         models, AI Chat, System                           │
            └───────────────▲───────────────────────────────────────────┘
                            │ same-origin HTTP (only when reachable)
            ┌───────────────┴───────── MetaCode server (Node) ──────────┐
            │  existing routes  +  /api/local-ai (catalog, hardware,    │
            │  runtimes, installs, models)  +  lite profile             │
            └───────▲───────────────────────────────▲───────────────────┘
                    │ /v1 (loopback)                 │ native API (loopback)
            ┌───────┴──────── AI service ─────┐   ┌──┴──────────── Ollama ──┐
            │ providers: ollama, OpenAI-      │──▶│ models on this machine  │
            │ compatible local servers, cloud │   └─────────────────────────┘
            └─────────────────────────────────┘
```

1. **Local server.** For Windows, macOS, Linux, Raspberry Pi, mini PCs, old laptops and USB sticks.
   The Node server runs on the device, and the browser (or an installed app window) opens
   `http://localhost:3000`. Portable bundles carry their own Node runtime and keep their data next
   to themselves. Nothing needs the internet except the features that are online by nature.
2. **Installable PWA.** For every modern browser: Android, iOS/iPadOS, ChromeOS and desktops. Any
   MetaCode server serves it: the laptop, a Raspberry Pi on the network, or a VPS. A service worker
   keeps the app opening and working when that server or the internet is gone. The data was already
   in the browser.
3. **Hosted.** The existing VPS deployment, unchanged, plus the PWA and the Model Store for the
   operator.

**Why not Electron or Tauri for the main app?** MetaCode already runs in any browser.
- Electron would add about 100 MB of Chromium to every install, and has no Raspberry Pi target.
- Tauri needs a Rust build on each OS, and its webview differs from OS to OS.
- A portable Node runtime plus the system browser runs everywhere Node runs (x64 and ARM), in a
  fraction of the space. The PWA install gives it an app window.

### Offline behaviour

- Every script, style and font the app needs is served by MetaCode itself, at the same pinned versions
  (`public/vendor/`, rebuilt by `scripts/vendor-web.js`). No CDN, no Google Fonts, and no analytics
  unless an operator turns it on.
- One app-wide service worker (`/sw.js`) precaches the app shell, versioned by the files' contents. It
  never caches `/api/*`. It also carries the Scramjet routing of the in-app Reddit browser, so the two
  no longer fight over scope `/`.
- The top bar tells "server unreachable" and "offline" apart from "AI not set up". Features that need
  the internet or the server say so instead of failing.
- `navigator.storage.persist()` is requested, so the browser doesn't evict local data (Safari otherwise
  evicts it after 7 days unused).

### Local AI

**Runtime layer.** A runtime is something that runs models on a device. MetaCode knows several:

| Runtime | Where it runs | Install models from MetaCode | Status |
|---|---|---|---|
| Ollama (this machine) | Windows, macOS, Linux x64/arm64 (Raspberry Pi 4/5 with a 64-bit OS) | Yes: the Model Store | primary |
| OpenAI-compatible local server (llama.cpp `llama-server`, LM Studio, Jan, LocalAI) | wherever those run | No (they manage their own) | detected and listed |
| Another MetaCode server (your PC, a Pi or a VPS) | any device with a browser: phones, tablets, ChromeOS | on that server | the mobile path |

Each device's System page shows which runtimes work there, and why the others don't. For example,
there is no Ollama for iOS, and only community builds for Android.

**AI modes** (`AI_MODE`):
- `cloud`: the hosted default. Cloud providers come first, and Ollama is the last-resort backup, as now.
- `local`: local models come first and are the default. A cloud model answers only if it was picked.
- `local-only`: no prompt ever leaves the device, because non-local providers are switched off.
  This is the default for portable installs.

**AI Model Store.**
- **Catalog.** Ollama's library (`ollama.com/library`; per-model tags give exact sizes, context windows
  and inputs) and the registry's manifests (exact download sizes and digests). It is cached on disk,
  and a dated snapshot ships for the first run offline. Offline, the store shows the cached catalog
  and its date.
- **Installs.** They go through Ollama's own `/api/pull` and show progress, speed and time left.
  - A download can be cancelled.
  - Pausing is a cancel that keeps the partial download, and resuming pulls again: Ollama continues
    from where it stopped.
  - The same model is never downloaded twice at once.
  - Free disk space is checked against the manifest's size.
  - After the pull, the installed digest is compared with the registry's.
- **Management.** Installed models can be listed, loaded into memory, stopped, deleted and updated.
  - Each model shows the disk space it uses.
  - A model can be set as the default, or for each AI task (coding, assistant, import, CSV, scraper).
  - Each model has its own settings.
- **Recommendations.** The device's RAM, CPU, architecture, GPU, free disk space and OS are compared
  with each model's real size. Models fall into Ultra lightweight, Low resource, Balanced, High
  performance and Experimental. A model the device can't hold is never recommended.
- **Security.** Ollama has no authentication, so it stays on `127.0.0.1`. Installing and deleting
  models is allowed from the machine itself, or with `LOCAL_AI_ADMIN_TOKEN` on a hosted server.
  Visitors can browse, never install.

### Performance profiles

- **Browser.** Choose Potato, Balanced or Performance, or let MetaCode pick (auto) from the device's
  memory, CPU cores, data saver and reduced-motion settings.
  - Potato turns off animations, transitions, shadows and blur, and pauses background polling.
  - Potato also lightens the network graph and the long lists.
  - Every feature stays.
- **Server.** The lite profile (`METACODE_PROFILE=lite`, the default for portable installs) starts
  work only when a feature needs it: the Python worker, the AI-service probe, the status monitor and
  the sandbox probe.

### Data

The formats are unchanged: the backup, the project file, the coder file, survey elements and CSV
exports. `METACODE_DATA_DIR` gives the server's folders one root, and a portable install keeps them
in its own `data/` folder. Existing installs keep their folders.

## 3. Distribution

| Platform | Package | Notes |
|---|---|---|
| Any browser (desktop, Android, iOS/iPadOS, ChromeOS) | Installable PWA | Android's Chrome turns an installed PWA into a WebAPK |
| Windows x64 | Portable `.zip` (Node included, `MetaCode.cmd`) | — |
| macOS x64 / Apple Silicon | `.app` bundle in a `.zip` (Node included) | unsigned: Gatekeeper asks once |
| Linux x64 / arm64 / armv7l | Portable `.tar.gz` (Node included, `metacode.sh`, `.desktop` file) and `.deb` | Raspberry Pi: arm64 for Pi 3/4/5 with a 64-bit OS, armv7l for 32-bit |
| USB stick | Any portable bundle | Its data stays in the bundle's `data/` folder |

AI models are never bundled. They are downloaded in the Model Store.

## 4. Plan

- [x] **Phase 1, audit.** Seven readers mapped the features, data, network use, dependencies,
  performance and platform limits.
- [x] **Phase 2, architecture.** This document.
- [ ] **Phase 3, core.**
  - Serve the libraries and fonts locally; make analytics opt-in.
  - Add the manifest, icons and a unified service worker; offline and server-unreachable states.
  - Add mobile navigation and persistent storage.
  - Add `METACODE_DATA_DIR`.
- [ ] **Phase 4, AI Model Store.**
  - Catalog, hardware detection, recommendations, installs and management (server and UI).
  - The Installed Models, AI Chat and System pages.
- [ ] **Phase 5, local AI runtime.** The runtime layer and the compatibility matrix; `AI_MODE`
  `local` and `local-only`.
- [ ] **Phase 6, optimization.** Performance profiles and the server's lite profile, measured
  before and after.
- [ ] **Phase 7, testing.** Automated tests for each part, plus a run against a real Ollama.
- [ ] **Phase 8, distribution.** Portable bundles, a `.deb` and launchers; the PWA.
- [ ] **Phase 9, documentation.** Installation, offline use, model management and platform limits.

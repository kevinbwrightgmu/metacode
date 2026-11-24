# MetaCode offline-first

> One app. Any device. Works offline. Your AI, your hardware, your data.

MetaCode runs without the internet, on almost any device, and has an AI Model Store for models that run on
the device itself. It is the same MetaCode: every feature, the branding, the workflows and the data formats
stay. This document covers the platforms and how each was tested, installing, offline use, local AI,
performance, the architecture, privacy, building and testing, and the limits.

Numbers and test results in this document come from real runs, never from guesses. Where something was
built but not run on a real device, it says so.

**Contents**
1. [Status](#1-status)
2. [Platforms](#2-platforms)
3. [Install](#3-install)
4. [Offline use](#4-offline-use)
5. [Local AI and the AI Model Store](#5-local-ai-and-the-ai-model-store)
6. [Performance](#6-performance)
7. [Architecture](#7-architecture)
8. [Privacy and security](#8-privacy-and-security)
9. [Building and testing](#9-building-and-testing)
10. [Limitations](#10-limitations)
11. [Settings](#11-settings)
12. [What the audit found](#12-what-the-audit-found)

## 1. Status

All nine phases are done.

- [x] **Phase 1, audit.** Seven readers mapped the features, data, network use, dependencies, performance
  and platform limits ([section 12](#12-what-the-audit-found)).
- [x] **Phase 2, architecture.** [Section 7](#7-architecture).
- [x] **Phase 3, core.** Every library and font is served by MetaCode itself, and analytics is opt-in. A
  manifest, icons and one app-wide service worker make it an installable app that opens offline. The top bar
  tells "offline" and "server unreachable" apart. Phones get a navigation drawer, and installed apps get
  persistent storage. `METACODE_DATA_DIR` gives the server's data one folder.
- [x] **Phase 4, AI Model Store.** The catalog, hardware detection, recommendations, installs and model
  management, on the server (`local-ai/`) and in the app (Local AI: AI Model Store, Installed Models, AI Chat,
  System).
- [x] **Phase 5, local AI runtime.** The runtime layer, the compatibility matrix, and `AI_MODE` `local` and
  `local-only`.
- [x] **Phase 6, optimization.** Performance profiles in the browser, the server's lite profile, and Chart.js
  and D3 loaded only by the pages that use them, measured before and after ([section 6](#6-performance)).
- [x] **Phase 7, testing.** Automated tests for each part, including real Chromium runs offline and with a
  stand-in Ollama, plus runs against a real Ollama ([section 9](#9-building-and-testing)).
- [x] **Phase 8, distribution.**
  - Portable bundles for seven targets, each with its own Node.js runtime.
  - A `.deb`, an AppImage, a Windows setup program and `MetaCode.exe`, and `MetaCode.app`.
  - A CI workflow that builds them all and starts each on its own system.
- [x] **Phase 9, documentation.** This document, the README and `.env.example`.

## 2. Platforms

MetaCode is a Node.js server and a web app. One codebase runs everywhere, in one of three ways:
- **On the device.** A portable bundle or a package carries its own Node.js runtime, and the browser opens
  `http://localhost:3000`.
- **As an installed web app (PWA).** It is served by a MetaCode server the device can reach, and it opens and
  works offline.
- **Hosted.** The VPS deployment, unchanged.

No single file runs everywhere, so each system gets its own build. AI models are never bundled: the AI Model
Store downloads them.

| Platform | What to use | Started and checked |
|---|---|---|
| Windows 10 and 11, x64 | `MetaCode-<version>-win-x64.zip` (`MetaCode.exe` or `MetaCode.cmd`), or `MetaCode-Setup-<version>-x64.exe` | **CI**, Windows Server 2025: the folder through `MetaCode.cmd` and through `MetaCode.exe`; the setup program installed, started and uninstalled (data kept). A second start opened Microsoft Edge |
| Windows 11 on ARM | `win-arm64` `.zip` or setup program | **CI**, Windows 11 on ARM: the same checks |
| macOS 11+, Apple silicon | `MetaCode-<version>-darwin-arm64.tar.gz` (`MetaCode.command`), or `…-darwin-arm64-app.zip` (`MetaCode.app`) | **CI**, macOS on Apple silicon: the folder; `MetaCode.app`'s `Info.plist`, its script (the AppleScript compiles) and the server it starts, with its data in Application Support; Node.js's signature verified. A second start opened Safari |
| macOS 11+, Intel | `darwin-x64` `.tar.gz` or `-app.zip` | **CI**, under Rosetta 2 on Apple silicon (not an Intel Mac): the same checks |
| Linux x64 (desktop, mini PC, old laptop) | `linux-x64` `.tar.gz`, `.deb` (amd64), AppImage (x86_64) | **Here** and **CI** (Ubuntu): the folder (here also as an unprivileged user, without a Node.js on the system), the `.deb` (installed, started, removed), the AppImage without FUSE |
| Raspberry Pi 3, 4, 5, Zero 2 W (64-bit Raspberry Pi OS), other ARM64 Linux | `linux-arm64` `.tar.gz`, `.deb` (arm64), AppImage (aarch64) | **CI**, on an ARM64 Ubuntu machine (not a Pi): the folder, the `.deb`, the AppImage |
| Raspberry Pi 2 and newer (32-bit Raspberry Pi OS) | `linux-armv7l` `.tar.gz`, `.deb` (armhf), AppImage (armhf) | **CI**, in an emulated 32-bit Debian (QEMU, not a Pi). Without `libatomic1` the launcher says to install it; the `.deb` (which brings it) and the folder then start and pass the checks. (CI found that Node.js for 32-bit ARM needs it.) |
| Raspberry Pi Zero, Pi 1 (ARMv6) | a `--no-node` folder with Node.js for ARMv6 from unofficial-builds.nodejs.org | Not tested: Node.js 22 has no official ARMv6 build |
| ChromeOS | Its Linux development environment: the `.deb` (x64 or arm64) or the AppImage. Or the PWA from a MetaCode server | Not on a Chromebook; ChromeOS's Linux is Debian, where the `.deb` was tested |
| Android | The PWA from a MetaCode server: Chrome installs it as a WebAPK. Termux for a server on the phone | No APK (see below). The PWA was tested in Chromium with a phone-sized window, not on a phone |
| iOS and iPadOS | The PWA: Safari → Share → Add to Home Screen | No native app (see below). Not on an iPhone or iPad, and not in Safari |
| A USB stick | Any portable folder: its data stays in its `data/` | **Here**: the Linux folder unpacked and started with an empty environment |
| Any modern browser | The PWA | **Here**, in Chromium: installable, works offline and with the server stopped, the phone drawer, the profiles |

**"Here"** is the Linux x64 machine (4 CPU cores, 16 GB of memory, no GPU) where MetaCode was built.
**"CI"** is `.github/workflows/portable.yml` on GitHub's hosted machines. Its smoke test,
`scripts/smoke-portable.js`, starts the bundle's own launcher. It checks:
- the server answers with the app, its service worker and its local libraries;
- the AI Model Store is in `local-only` mode with its catalog, the device's hardware and recommendations;
- the data lands where it should;
- a second start opens the running MetaCode and exits;
- stopping it also stops its AI service.

### Why there's no native Android or iOS app

- **iOS and iPadOS.** A native app has to be built and signed on macOS with Xcode and an Apple Developer
  account, so it can't be built here. iOS also doesn't let an app keep a Node.js server running, and there is
  no Ollama for iOS.
  - **The closest alternative is the PWA:** Safari → Share → Add to Home Screen. It opens and works offline,
    with your data in Safari's storage.
  - AI, the Model Store and the scraper then come from a MetaCode server the device can reach: a hosted
    MetaCode, a Raspberry Pi or your computer (see [Limitations](#10-limitations) for plain-HTTP servers).
- **Android.** An APK that runs MetaCode's server would have to embed Node.js and a model runtime. That is a
  separate native project, and Ollama has no official Android build. The closest alternatives:
  1. **The PWA.** Chrome installs it as a WebAPK: an app in the launcher and the app list, which Chrome keeps
     up to date. An APK built as a Trusted Web Activity would open the same hosted MetaCode full screen. It
     would add a signing key to manage and nothing a WebAPK lacks, and it still wouldn't run MetaCode's server
     or local AI on the phone.
  2. **Termux**, untested here. Install Node.js with `pkg install nodejs-lts git`, then run MetaCode from its
     source:
     ```bash
     npm ci --omit=dev
     METACODE_PROFILE=lite AI_MODE=local-only METACODE_HOST=127.0.0.1 node server.js
     ```
     `METACODE_HOST=127.0.0.1` keeps it to the phone, not its Wi-Fi network. Termux's `ollama` package provides
     local models (`pkg install ollama`, then `ollama serve`), and the Store says so when it sees Termux.
     Chrome then opens `http://localhost:3000`, which counts as a secure origin, so the PWA works offline
     there too.

## 3. Install

Every package starts MetaCode the same way:
- The lite profile and AI on this device only (`METACODE_PROFILE=lite`, `AI_MODE=local-only`).
- It listens on `127.0.0.1:3000`, so only this computer can reach it.
- It opens `http://localhost:3000/app.html` in the browser.
- Started again while it runs, it opens the running MetaCode.

A `.env` file next to the launcher (or in the data folder) changes any of this ([section 11](#11-settings)).
MetaCode runs in a terminal window, and closing that window stops it. Nothing is signed with a Microsoft or
Apple certificate, so Windows and macOS ask once before the first start.

### Windows 10 and 11
- **Setup program.** Run `MetaCode-Setup-<version>-x64.exe` (on Windows on ARM, `-arm64`).
  - It installs for you only, with no administrator rights, in `%LOCALAPPDATA%\Programs\MetaCode`.
  - It adds Start menu and desktop shortcuts and an entry in Settings → Apps.
  - Uninstalling removes MetaCode's files and keeps your `data\` folder and `.env`.
  - `/S` installs silently.
- **Portable.** Unzip `MetaCode-<version>-win-x64.zip` anywhere, a USB stick included, and double-click
  `MetaCode.exe` (or `MetaCode.cmd`).
- When SmartScreen says "Windows protected your PC", choose **More info** → **Run anyway**.

### macOS 11 and newer (Apple silicon: `darwin-arm64`; Intel: `darwin-x64`)
- **MetaCode.app.** Unzip `MetaCode-<version>-darwin-arm64-app.zip`, move `MetaCode.app` to Applications and
  open it.
  - It runs the server in a Terminal window; closing the window stops it.
  - The first time, macOS asks whether MetaCode may control Terminal. If that was refused, the app says where to
    allow it.
  - Opened where it was unzipped, macOS runs a temporary copy of it, so the app asks to be moved first.
  - Data and settings (`.env`) go to `~/Library/Application Support/MetaCode`.
- **Portable.** Unpack the `.tar.gz` anywhere and double-click `MetaCode.command`.
- **The first open.** On macOS 14 and older, right-click → Open. On macOS 15 and newer, open it once, then
  System Settings → Privacy & Security → **Open Anyway**.

### Linux (x64, arm64, armv7l)
- **.deb** (Debian, Ubuntu, Linux Mint, Raspberry Pi OS, ChromeOS's Linux): `sudo apt install
  ./metacode_<version>_amd64.deb` (or `_arm64`, `_armhf`). Start MetaCode from the application menu, or run
  `metacode`. Data goes to `~/.local/share/metacode`. `sudo apt remove metacode` removes MetaCode and keeps
  the data.
- **AppImage** (any distribution): `chmod +x MetaCode-<version>-x86_64.AppImage` and run it. Data goes to
  `~/.local/share/metacode`. Without FUSE, run it with `--appimage-extract-and-run`.
- **Portable.** Run `tar -xzf MetaCode-<version>-linux-x64.tar.gz`, then
  `./MetaCode-<version>-linux-x64/metacode.sh`. `./metacode.sh --install-menu` adds it to the application
  menu.

### Raspberry Pi
- **64-bit Raspberry Pi OS** (Pi 3, 4, 5, Zero 2 W): use the arm64 build.
- **32-bit Raspberry Pi OS** (Pi 2 and newer): use armv7l, or the `armhf` `.deb`. Node.js for 32-bit ARM needs
  `libatomic1`: the `.deb` installs it, and the other builds say so if it's missing (`sudo apt install libatomic1`).
- **Pi Zero and Pi 1** (ARMv6): Node.js 22 has no official build. Use `--no-node` and install Node.js from
  unofficial-builds.nodejs.org.
- **Local AI:** Ollama needs the 64-bit OS. The Store recommends what fits the Pi's memory
  ([section 5](#5-local-ai-and-the-ai-model-store)); their speed on a Pi wasn't measured.
  - With 4 GB: Ultra lightweight and Low resource models of up to about 2.4 GB in memory, such as
    `gemma3:1b`, `qwen2.5:3b` and `llama3.2:3b`.
  - With 8 GB: Balanced models too, up to about 6 GB, such as `gemma3:4b`, `qwen2.5:7b` and `llama3.1:8b`.

### A USB stick
Unpack any portable folder onto it. What the server keeps stays in the folder's `data/`. Your projects live in
the browser of the computer you use. To carry them, use Settings → **Download a backup**, then
**Restore from a backup…** on the other computer.

### The installable web app (PWA)
Open MetaCode at `http://localhost:3000` or a hosted MetaCode (HTTPS). Then use the browser's **Install**
button (Chrome, Edge), Add to Dock (Safari on a Mac) or Add to Home Screen (Android, iOS). From then on it
opens from its own icon, offline too.

### From the source code
Run `npm install`, then `METACODE_PROFILE=lite AI_MODE=local-only npm start` (README, Quick Start).

## 4. Offline use

| | Works offline? |
|---|---|
| Projects, CSV import, the codebook, human coding, reliability, metrics and charts, the network graph, exports, Survey Studio's editor, settings, backups | Yes, in the browser, once the app has been opened (or installed) |
| AI coding, AI Chat, MetaCode Assistant | Yes, with a local model and the MetaCode server on this device |
| The AI Model Store's catalog | Yes, from the copy kept on disk, or the snapshot that ships with MetaCode (253 models) on a first start |
| Analyze CSV (NetworkX), the AI Coding Lab's code runs | Yes, with the MetaCode server on this device (NetworkX needs Python) |
| Scraping (Reddit, YouTube, X, LinkedIn), cloud AI providers, accounts and cloud sync, collecting survey responses from others, downloading models | No: they need the internet |

- **Status.** The top bar shows "Offline" when the device has no network, and "Server unreachable" when the
  network is up but no MetaCode server answers. A feature that needs what's missing says so instead of failing.
- **Updates.** The service worker keeps the app's files, versioned by their contents. When the server has a
  new version, the app says "MetaCode was updated" and loads it on the next reload. It never caches `/api`.
- **Your data.**
  - The open project lives in `localStorage`, and saved projects and surveys in IndexedDB, in the same formats
    as before.
  - An installed app asks the browser to keep its storage (`navigator.storage.persist()`).
  - Settings → **Download a backup** saves everything in one file.

## 5. Local AI and the AI Model Store

1. **Install Ollama** (ollama.com/download; it is a separate program). MetaCode finds it at
   `127.0.0.1:11434`, or wherever `OLLAMA_BASE_URL` points.
2. **Sidebar → Local AI → AI Model Store.**
   - **Recommended** compares this device's memory, CPU, GPU and free disk with each model's real size. It
     lists what fits in five tiers: Ultra lightweight (≤ 1 GB), Low resource (≤ 3 GB), Balanced (≤ 8 GB),
     High performance and Experimental.
   - A model the device can't hold is never recommended. The memory a model needs is estimated as 1.12 × its
     file plus room for a 4K context, from the size of the files.
   - **All models** is Ollama's whole library: search, categories (general, coding, reasoning, vision,
     embeddings, small, multilingual), capabilities, and sorting by popularity, date or size.
   - Each model lists its tags. For each tag it gives the download size, the memory needed, the context
     window and the inputs, and whether it fits this device.
   - A tag with variants for several runners (ollama.com shows a size range) is given, there and in
     Recommended, at the size of the variant the Ollama here downloads, from Ollama's registry. When the
     registry doesn't answer, or it isn't known whether this is Apple silicon, it is the range's upper bound.
3. **Install.** Downloads show progress, speed and time left.
   - They can be paused, resumed (Ollama continues where it stopped) and cancelled.
   - One downloads at a time, the others queue, and the same model is never downloaded twice at once.
   - Before a download starts, free disk space is checked against what it still has to fetch: the files
     Ollama doesn't have yet, less what arrived before a pause, keeping 512 MB spare. A resume, or an update
     that changes little, doesn't ask for the whole model again.
   - After it, the installed model's digest is compared with the registry's. For a tag with variants for
     several runners, any of its variants counts: Ollama 0.40 and later pull MLX on Apple silicon and
     llama.cpp elsewhere, an older Ollama pulls llama.cpp, and an Ollama in a VM or on another computer the
     variant for its own system. A mismatch is reported, and the model stays installed. An interrupted
     download says so and can be resumed.
4. **Installed Models.**
   - Load a model into memory or stop it, update it, or delete it; each shows the space it uses. Load, Stop,
     Settings and Delete work for any model Ollama lists, also one pulled from another registry (`hf.co/…`)
     (a cloud model has nothing to load). Update downloads the model again from Ollama's library, so it's
     offered for names from there (like `gemma3:1b`); update a model from another registry with
     `ollama pull <name>`.
   - Names that share one model's files (`gemma3:latest` and `gemma3:4b`) say so, and their files are counted
     once. Deleting one of them frees nothing while another stays.
   - **Use as default** makes a model MetaCode's default in this browser. Each AI task can have its own:
     AI Coding, Ask MetaCode, Import Data, Analyze CSV and the AI Scraper (beta). Only the models MetaCode's
     AI service offers are listed there, never an embedding model.
   - Each model has its own settings: temperature, maximum answer length, and how long it stays in memory.
5. **AI Chat** talks to one model on this device, streamed. It is never switched to another model.
6. **System** shows this browser, the MetaCode server (operating system, CPU, memory, GPU, disk), which AI
   runtimes work here, and where each works.

**Choosing a model.** Measured here: 4 CPU cores, no GPU, Ollama 0.40.17, through MetaCode in `local-only`
mode, a two-sentence answer.

| Model | Download | In memory | First word (model loaded / not yet) | Speed | Answer quality |
|---|---|---|---|---|---|
| `gemma3:270m` (Ultra lightweight) | 292 MB | 326 MB | 55 ms / 1.2 s | ~55–60 tokens/s | Fast, but often wrong on facts |
| `gemma3:1b` (Ultra lightweight) | 806 MB | 883 MB | 122 ms / 2.1 s | ~22 tokens/s | Correct and usable |

Larger models need more memory and answer more slowly on a CPU. A GPU, or Apple silicon's unified memory,
changes this a lot.

**Where the AI runs** (`AI_MODE`):
- `cloud` is the hosted default: cloud providers first, Ollama the last-resort backup.
- `local` puts models on this device first and makes them the default.
- `local-only` switches every other provider off, and MetaCode refuses any other model, so no prompt leaves
  the device. The launchers use it.

**Other runtimes.** llama.cpp's `llama-server`, LM Studio, Jan, vLLM and LocalAI answer in OpenAI's format.
System → **Look for other AI servers on this computer** finds them on their usual ports and gives the
configuration to add them.
They manage their own models, so the Store doesn't install models for them.

**From another device.** Installing and removing models is allowed from the computer MetaCode runs on. On a
server, set `LOCAL_AI_ADMIN_TOKEN` (at least 12 characters) and enter it in the Store. Everyone else can
browse, never install. Behind a reverse proxy that `TRUST_PROXY` names, managing models always needs the
token, also on the server itself: a request from the proxy can be any visitor's.

## 6. Performance

**Profiles in the browser** (Settings → Performance):
- **Auto** picks one from the device's memory, CPU cores, data-saver and reduced-motion settings.
- **Potato** turns off animations, transitions, shadows and blur. It draws charts without animation, lays out
  networks with fewer forces and syncs less often.
- **Balanced** is the default for most devices.
- **Performance** adds collision forces to large network graphs.
- Every feature stays in every profile.

**The server's lite profile** (`METACODE_PROFILE=lite`, what the packages use) starts nothing until a feature
needs it:
- the scraper's Python worker, at the first scrape;
- the status checks, when the status page opens;
- the AI Coding Lab's sandbox probe, at the first code run.

**Measured** on the Linux x64 machine above (resident memory; sizes of what's sent):

| | Before | After |
|---|---|---|
| Server at idle, standard profile | MetaCode 66 MB + its AI service and Python worker 110 MB = 176 MB | — |
| Server at idle, lite profile | — | 66 MB + its AI service 82 MB = 148 MB; with AI off, 64 MB and no other process |
| Server after AI answers (portable build, lite) | — | MetaCode 82 MB, AI service 135 MB |
| Server ready (`/api/health` answers; median of 5) | ~0.25 s from source | 0.24 s from source (lite); 0.31 s from a portable folder; 0.49 s from an AppImage without FUSE (1.2 s the first time) |
| `app.html` at start | 1,307 KB of scripts, partly from jsDelivr, plus Google Fonts and Analytics | 834 KB of scripts and 91 KB of styles, all from MetaCode, 0 requests to other sites. Chart.js and D3 (473 KB) load with the pages that use them, the Local AI pages (41 KB) when one opens |
| Fonts | Google Fonts | 224 KB, served by MetaCode |
| Kept offline by the service worker | nothing | 78 files, 2.7 MB |

**Download sizes** (MetaCode 1.0.0 with Node.js 22.23.5, from the CI build). The unpacked folder includes
Node.js, which is 87–125 MB of it:

| Target | Archive | Unpacked | Packages |
|---|---|---|---|
| linux-x64 | 72.6 MB `.tar.gz` | 220.7 MB | `.deb` 51.2 MB, AppImage 67.4 MB |
| linux-arm64 | 72.4 MB `.tar.gz` | 218.1 MB | `.deb` 51.3 MB, AppImage 67.1 MB |
| linux-armv7l | 67.0 MB `.tar.gz` | 203.4 MB | `.deb` 47.1 MB, AppImage 62.1 MB |
| win-x64 | 64.4 MB `.zip` | 183.0 MB | setup program 40.9 MB |
| win-arm64 | 60.0 MB `.zip` | 173.1 MB | setup program 37.2 MB |
| darwin-x64 | 66.8 MB `.tar.gz` | 211.3 MB | `MetaCode.app` 69.6 MB `.zip` |
| darwin-arm64 | 65.6 MB `.tar.gz` | 208.8 MB | `MetaCode.app` 68.4 MB `.zip` |

## 7. Architecture

```
            ┌──────────────── the browser (any device) ────────────────┐
            │  MetaCode pages + service worker (works offline)          │
            │  data: localStorage / IndexedDB (unchanged formats)       │
            │  Local AI: Model Store, Installed Models, AI Chat, System │
            └───────────────▲───────────────────────────────────────────┘
                            │ same-origin HTTP (when the server is reachable)
            ┌───────────────┴───────── MetaCode server (Node) ──────────┐
            │  existing routes  +  /api/local-ai (catalog, hardware,    │
            │  runtimes, installs, models)  +  lite profile             │
            └───────▲───────────────────────────────▲───────────────────┘
                    │ /v1 (loopback)                 │ Ollama's API (loopback)
            ┌───────┴──────── AI service ─────┐   ┌──┴──────────── Ollama ──┐
            │ providers: Ollama, OpenAI-      │──▶│ models on this machine  │
            │ compatible local servers, cloud │   └─────────────────────────┘
            └─────────────────────────────────┘
```

**Why not Electron or Tauri?** MetaCode already runs in any browser, so it uses the browser that's there.
- Electron would add about 100 MB of Chromium to every install, and has no Raspberry Pi build.
- Tauri needs a Rust build on each system, and its web view differs from system to system.
- A Node.js runtime with the system's browser runs wherever Node.js runs, x64 and ARM. Installing the PWA
  gives it an app window.

**Offline.**
- Every script, style and font comes from MetaCode itself (`public/vendor/`, from pinned packages by
  `scripts/vendor-web.js`), at the versions it used before.
- One service worker (`/sw.js`) keeps the app's files. It also carries the routing of the in-app Reddit
  browser (Scramjet), so the two don't fight over the scope `/`.

**The AI Model Store's parts** (`local-ai/`):

| File | What it does |
|---|---|
| `catalog.js` | Ollama's library and its tags pages (sizes, context windows, inputs). The registry's manifests give exact download sizes and digests, for a tag with several variants the one Ollama pulls here. Cached on disk for 24 hours, tags for 7 days, with the snapshot for a first start offline. When ollama.com doesn't answer, the saved catalog answers at once for 5 minutes before it's tried again |
| `hardware.js` | Memory, CPU, GPU (NVIDIA, AMD, Intel, Apple silicon, also under Rosetta), free disk, operating system (Raspberry Pi, WSL and Termux included). On macOS, the version from `sw_vers` and the available memory from `vm_stat`. A models folder on a network drive that stops answering gives "free space unknown" after 2 s instead of holding the server up |
| `recommend.js` | The tiers and the fit of each tag on this device |
| `installs.js` | Downloads through Ollama's `/api/pull`: queue, progress, pause, resume, cancel, disk check, digest check |
| `runtimes.js` | The runtimes and where each works (the compatibility matrix) |
| `ollama.js` | Ollama's API |
| `index.js` | The routes under `/api/local-ai` and who may manage models |

**Packages** (`scripts/build-portable.js`). Each target gets the app's files (what git tracks, without tests
and build files), its production dependencies (installed once and pruned) and the Node.js runtime for that
system. The launchers start `server.js` and leave the rest to it: `METACODE_OPEN_BROWSER` and
`METACODE_HOST`.

## 8. Privacy and security

- **No telemetry, nothing loaded from other sites.** Google Analytics is off unless an operator sets
  `METACODE_ANALYTICS_ID`. No CDN and no Google Fonts: the app at start makes 0 requests to other sites
  (measured).
- **Your data stays on the device.** It is in the browser, and what the server keeps is in its data folder.
  Accounts stay optional.
- **Prompts stay on the device** with `AI_MODE=local-only`. The AI service switches the other providers off,
  and MetaCode refuses any other model.
- **This computer only.** The packages listen on `127.0.0.1`. To let a phone or tablet on the same network
  in, set `METACODE_HOST=0.0.0.0`.
- **The AI Model Store answers MetaCode's own pages only.** It sends no CORS headers, and cross-site requests
  are refused. A request from this computer must also use one of this computer's own names: localhost,
  127.x.x.x, [::1], or (to read) its host name. So another site whose name points at 127.0.0.1 (DNS
  rebinding) gets nothing from the Store's routes (`/api/local-ai`), not even what they'd let it read (this
  computer's hardware, its models). Headers such as `X-Forwarded-For` don't change that, because a page can
  add them itself: they count only from a proxy that `TRUST_PROXY` names. Managing models takes localhost,
  127.x.x.x or [::1], and never comes from such a proxy without the admin token.
  - **A reverse proxy on the same machine** should pass the visitor's address (`X-Forwarded-For`, as in
    [deploy-vps.md](deploy-vps.md)), with `TRUST_PROXY=loopback`. One that passes only the site's own name
    (`Host`) needs that name in `PUBLIC_URL`: it may read, and managing models needs the admin token.
  - **One that passes neither** (nginx with only `proxy_pass`, which sends `Host: 127.0.0.1:3000`) makes
    every visitor this computer, unless `TRUST_PROXY` names it. So keep deploy-vps.md's `Host`,
    `X-Forwarded-For` and `X-Real-IP` lines, and `TRUST_PROXY=loopback`.
  - Ollama itself stays on 127.0.0.1, because it has no authentication.
- **Downloads are checked.**
  - Models: Ollama checks each file's sha256 as it downloads. MetaCode then compares the installed model's
    digest with the registry's manifest, and reports a mismatch.
  - Node.js runtimes: against nodejs.org's `SHASUMS256.txt`.
  - The AppImage runtime: its sha256 must be the one recorded in `scripts/build-portable.js` (the AppImage project
    rebuilds its runtime now and then; a different one stops the build until it's checked).
  - The browser libraries: sha256 for each file in `public/vendor/VENDOR.json`, checked by
    `node scripts/vendor-web.js --check`.
  - MetaCode runs nothing it downloads. Models are data, and only Ollama reads them.
- **Settings files.** The Store's settings are written with mode 0600. Keys stay in `.env` on the server and
  never reach the browser.

## 9. Building and testing

**Building the packages** (on Linux, or macOS with the same tools):
```bash
npm run build:portable                            # this computer's system
npm run build:portable -- --all --packages        # every system and every package, into dist/portable
npm run build:portable -- --target win-x64 --target linux-arm64 --deb
```
- **Tools:**
  - Node.js 22, npm, `tar`, `xz`, `zip` and `unzip`;
  - `dpkg-deb` for `--deb`;
  - `mksquashfs` (squashfs-tools) for `--appimage`;
  - `makensis` (NSIS) for `--installer`.
- **Other options:**
  - `--no-node` leaves the runtime out, and the launcher uses the device's Node.js.
  - `--no-archive` leaves only the folder.
  - Building again keeps a folder's `data/` and `.env` (it may be in use), and leaves them out of the archives and
    packages.
  - `--node <version>` picks the bundled Node.js.
- The AI Scraper (beta) page is included when `collector/dist` was built (`npm run collector:build`).

**CI.** `.github/workflows/portable.yml` builds everything on Linux, then starts each bundle on its own system
([section 2](#2-platforms)). It runs when the build or the packaging changes, for `metacode-v*` tags (a draft
release with every file and `SHA256SUMS.txt`), and by hand.

**Tests.**
- `npm test` runs every automated test. These parts belong to this work:

  | Test file | What it covers |
  |---|---|
  | `test/pwa-offline-e2e.test.js` | Chromium: no request to other sites; offline, with the server stopped; the phone drawer; the performance profiles |
  | `test/local-ai.test.js` | The Store's server against a stand-in Ollama that behaves like the real one: downloads, pause and resume, the disk check, manifest lists, names in any case, problems, management, who may manage, DNS rebinding, macOS, Apple silicon and Termux |
  | `test/local-ai-e2e.test.js` | Chromium: the Store, Installed Models, AI Chat and System pages |
  | `test/opencode-ollama.test.js`, `test/ai-service-client.test.js` | Ollama as a provider, and `AI_MODE` |
  | `test/lite-profile.test.js` | The lite profile |
  | `test/local-server.test.js` | `METACODE_HOST`, the browser opening, a second start, and the Store refusing other websites |
- Opt-in runs:
  - `METACODE_TEST_OLLAMA=1 node --test test/local-ai-real-ollama.test.js` runs against a real Ollama. It
    passed with Ollama 0.40.17, and an install through the Store matched the registry's digest.
  - `METACODE_TEST_PORTABLE=1 node --test test/portable-build.test.js` builds this computer's bundle and
    starts it.
- `node scripts/smoke-portable.js <folder>` checks any unpacked bundle, as CI does.

## 10. Limitations

- **Not signed.** Windows SmartScreen and macOS Gatekeeper ask once (see [Install](#3-install)). Signing
  needs a Microsoft code-signing certificate and an Apple Developer ID, which the project would have to buy.
- **Not tried on real hardware:** Windows, macOS, Raspberry Pi, Chromebooks, Android and iOS. They were run by
  CI on GitHub's machines, emulated, or not at all, as the table in [section 2](#2-platforms) says.
  - `MetaCode.app`'s Terminal step needs a person to allow it, so CI checks its script and runs the server it
    starts, not the app's own start.
  - The macOS Intel build ran under Rosetta 2, not on an Intel Mac.
  - The armv7l build ran in an emulated 32-bit Debian, not on a Pi.
- **No `.dmg` or `.rpm`.** The macOS app comes as a `.zip`, which macOS opens itself; making a `.dmg` needs
  macOS. The AppImage covers Fedora, openSUSE and other distributions.
- **The AppImage without FUSE** (`--appimage-extract-and-run`) runs MetaCode in a child process, so stop it
  by closing its terminal (or Ctrl+C). Killing only the AppImage's own process leaves MetaCode running.
- **Node.js 22's official builds** need:
  - Windows 10 or newer and macOS 11 or newer;
  - on Linux, glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8 and newer). Alpine and other musl systems
    need `--no-node` and their own Node.js;
  - ARMv7 or newer, so no Pi Zero or Pi 1.
- **Offline over the network needs HTTPS.** Browsers allow service workers on `https://` and `localhost`
  only. A phone using a computer's MetaCode at `http://192.168.x.x:3000` works online but can't install it
  for offline use. Use a hosted MetaCode (HTTPS), or put HTTPS in front of yours.
- **iOS storage.** Safari can clear a site's storage after 7 days without a visit unless it's added to the
  Home Screen, so keep backups.
- **Ollama.**
  - It has no official Android or iOS build.
  - On a Raspberry Pi it needs the 64-bit OS. On a 32-bit Pi, use an OpenAI-compatible server
    (llama.cpp's `llama-server`) or another device's MetaCode.
- **The catalog** is read from ollama.com's pages, which have no official API. If they change, the Store
  keeps using its last copy (or the snapshot) and says how old it is.
- **Memory estimates are approximate.** A model's need grows with the context it's given. "Tight" in the
  Store means it may fit with little room for anything else.
- **Online by nature.** Scraping, cloud AI and accounts need the internet. Analyze CSV and the server's
  scraper engine use Python when the device has it, and the packages don't install Python.

## 11. Settings

The packages' launchers set the first four. A `.env` file changes any of them: next to the launcher (the
portable folders), or in the data folder (`~/Library/Application Support/MetaCode` for `MetaCode.app`,
`~/.local/share/metacode` for the `.deb` and the AppImage). Everything else is in `.env.example`.

| Setting | What it does |
|---|---|
| `METACODE_PROFILE` | `lite`: nothing starts until a feature needs it |
| `AI_MODE` | `cloud`, `local` or `local-only` ([section 5](#5-local-ai-and-the-ai-model-store)) |
| `METACODE_HOST` | The address to listen on. `127.0.0.1` means this computer only (the packages); `0.0.0.0` means every network. Unset means every address, as before |
| `PORT` | The port (3000) |
| `METACODE_OPEN_BROWSER` | `1` opens MetaCode in the browser once it listens. Started again while it runs, it opens that one and exits. The launchers set it unless `METACODE_NO_BROWSER=1` |
| `METACODE_DATA_DIR` | One folder for everything the server keeps |
| `OLLAMA_BASE_URL` | Where Ollama answers (`http://127.0.0.1:11434/v1`) |
| `AI_LOCAL_CONTEXT_TOKENS` | How much a model on this machine takes in, prompt and answer together: 4096, Ollama's default, unless set. Set it to Ollama's `OLLAMA_CONTEXT_LENGTH`. A prompt that doesn't fit is refused with what to change, and Ask MetaCode sends only the parts of its reference that fit |
| `LOCAL_AI_ADMIN_TOKEN` | Lets other devices install and remove models (behind a reverse proxy that `TRUST_PROXY` names, it's needed on the server too) |
| `LOCAL_AI_LIBRARY_URL`, `LOCAL_AI_REGISTRY_URL` | A mirror of Ollama's library and registry |
| `OLLAMA_PULL_IDLE_SECONDS` | How long a download may make no progress before it's stopped as interrupted (default 120 s); resuming continues |
| `METACODE_ANALYTICS_ID` | Turns Google Analytics on (off by default) |

## 12. What the audit found

A seven-part audit read the whole codebase before anything changed. This is what it found, and what the
phases above did about it:

| Area | Before | Done |
|---|---|---|
| Browser app (`public/`) | PapaParse, Chart.js and D3 came from jsDelivr as blocking scripts. Every page loaded Google Fonts and Google Analytics. There was no manifest, app service worker or icons, and phones had no navigation | Everything local; analytics opt-in; an installable app that works offline; a navigation drawer on phones |
| Data and sync | Local-first already (localStorage, IndexedDB); accounts optional | Unchanged formats; persistent storage; `METACODE_DATA_DIR` |
| Server (`server.js`) | ~68 MB idle. A Python worker (+26 MB) started at boot, and the status monitor spawned Python every 5 minutes. Data folders sat next to `server.js` | The lite profile; one data folder; packages that keep data in the user's folders |
| AI | Cloud providers got the prompts, local models couldn't be the default, and models couldn't be browsed or installed | `AI_MODE`; the AI Model Store; the runtime layer |
| Scraper, AI Lab, publishing, collaboration | Server features | Unchanged; marked as needing the server or the internet |
| Desktop app (`desktop/`) | "MetaCode Sheets", a separate Electron product | Out of scope |

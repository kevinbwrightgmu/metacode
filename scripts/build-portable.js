#!/usr/bin/env node
// Portable MetaCode: one folder per platform with the app, its production dependencies, a Node.js runtime for that
// platform (downloaded from nodejs.org and checked against its SHASUMS256.txt) and a launcher. Unpack it anywhere,
// a USB stick included, and start the launcher: no installation, nothing written outside the folder (data/ holds
// what the server keeps; your projects live in the browser). Packages to install it, from the same folder:
//
//   node scripts/build-portable.js                       this computer's platform
//   node scripts/build-portable.js --target win-x64 --target linux-arm64
//   node scripts/build-portable.js --all --packages      every target and every package
//   options: --deb             Linux: a .deb (Debian, Ubuntu, Raspberry Pi OS, ChromeOS's Linux)
//            --appimage        Linux: an AppImage (needs mksquashfs; the AppImage runtime comes from the AppImage
//                              project's releases on github.com, or --appimage-runtime <file>)
//            --installer       Windows: MetaCode.exe in the folder and a setup program (needs NSIS's makensis)
//            --packages        all three
//            --no-node         no runtime: the launcher uses the Node.js installed on the device
//            --no-archive      leave the folder, no .tar.gz / .zip
//            --out <dir>       default dist/portable
//            --node <version>  default this Node's version
//   macOS targets always get MetaCode.app too (MetaCode-<version>-darwin-<arch>-app.zip): the app with everything
//   inside, for the Applications folder; its data goes to ~/Library/Application Support/MetaCode.
//
// The launchers start MetaCode in its lite profile (METACODE_PROFILE=lite) with AI on this computer only
// (AI_MODE=local-only), listening on 127.0.0.1:3000 (this computer only), and open the browser; a .env file
// (next to the launcher, or in the data folder) overrides any of that.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
// appimageSha256: the AppImage project's type2 runtime as it was checked for this MetaCode (its "continuous"
// release is rebuilt now and then: a runtime that differs stops the build until it's checked and updated here)
const TARGETS = {
  'linux-x64': { os: 'linux', deb: 'amd64', appimage: 'x86_64', elf: 0x3e, appimageSha256: '617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46' },
  'linux-arm64': { os: 'linux', deb: 'arm64', appimage: 'aarch64', elf: 0xb7, appimageSha256: '9a72a744d221576c9347ec074243acc5c3c7568896b12714e0e82e9f0bf47900' },
  'linux-armv7l': { os: 'linux', deb: 'armhf', appimage: 'armhf', elf: 0x28, appimageSha256: 'acc940e0b091453490861ca7341135c7cbe6182d4aa7336c67fa5f51b0e77fcc' },
  'win-x64': { os: 'win' },
  'win-arm64': { os: 'win' },
  'darwin-x64': { os: 'darwin' },
  'darwin-arm64': { os: 'darwin' },
};
// Not shipped: the desktop app, tests, build and CI files, the VPN gateway's Docker setup, the collector's sources
// (its build, collector/dist, is), type declarations, the packages' icons
const EXCLUDE = [/^desktop\//, /^test\//, /^\.github\//, /^deploy\//, /^types\//, /^scripts\//, /^packaging\//, /^collector\/(?!dist\/)/, /^sample-data\//, /^tsconfig\.json$/, /^\.gitignore$/];
// Files in node_modules that never run
const PRUNE_FILE = /(\.map|\.d\.ts|\.d\.mts|\.d\.cts|\.md|\.markdown)$/i;
const KEEP_FILE = /^(LICEN[CS]E|COPYING|NOTICE)/i;
const PRUNE_DIR = new Set(['test', 'tests', '__tests__', 'example', 'examples', 'docs', '.github', 'benchmark', 'benchmarks']);
const APPIMAGE_RUNTIME = 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-';
const DESCRIPTION = 'Social media content analysis, offline, with local AI';

function args() {
  const a = process.argv.slice(2);
  const o = { targets: [], deb: false, appimage: false, installer: false, node: true, archive: true, out: path.join(ROOT, 'dist', 'portable'), nodeVersion: process.versions.node, appimageRuntime: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--target') o.targets.push(a[++i]);
    else if (a[i] === '--all') o.targets = Object.keys(TARGETS);
    else if (a[i] === '--deb') o.deb = true;
    else if (a[i] === '--appimage') o.appimage = true;
    else if (a[i] === '--installer') o.installer = true;
    else if (a[i] === '--packages') o.deb = o.appimage = o.installer = true;
    else if (a[i] === '--appimage-runtime') o.appimageRuntime = path.resolve(a[++i]);
    else if (a[i] === '--no-node') o.node = false;
    else if (a[i] === '--no-archive') o.archive = false;
    else if (a[i] === '--out') o.out = path.resolve(a[++i]);
    else if (a[i] === '--node') o.nodeVersion = String(a[++i]).replace(/^v/, '');
    else throw new Error('Unknown option ' + a[i]);
  }
  if (!o.targets.length) o.targets = [(process.platform === 'win32' ? 'win' : process.platform) + '-' + (process.arch === 'arm' ? 'armv7l' : process.arch)];
  for (const t of o.targets) if (!TARGETS[t]) throw new Error('Unknown target ' + t + ' (' + Object.keys(TARGETS).join(', ') + ')');
  return o;
}

const sh = (cmd, argv, opts) => execFileSync(cmd, argv, Object.assign({ stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }, opts));
function has(cmd) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
function copyFile(from, to, mode) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  if (mode) fs.chmodSync(to, mode);
}
function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(f) : e.isFile() ? fs.statSync(f).size : 0;
  }
  return n;
}
const mb = n => (n / 1e6).toFixed(1) + ' MB';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// tar's options to pack files as root's (GNU tar on Linux, bsdtar on macOS)
let tarFlags = null;
function tarOwner() {
  if (!tarFlags) {
    let gnu = false;
    try { gnu = /GNU tar/.test(execFileSync('tar', ['--version'], { encoding: 'utf8' })); } catch (e) { gnu = false; }
    tarFlags = gnu ? ['--owner=0', '--group=0', '--numeric-owner'] : ['--uid', '0', '--gid', '0'];
  }
  return tarFlags;
}
async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  console.log('  downloading ' + url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
  fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(dest + '.part', dest);
  return dest;
}

// The app's files: what git tracks (so nothing local or secret, like .env, goes in), minus EXCLUDE, plus the
// collector's build
function appFiles() {
  const files = sh('git', ['ls-files', '-z'], { cwd: ROOT }).split('\0').filter(Boolean).filter(f => !EXCLUDE.some(re => re.test(f)));
  const dist = path.join(ROOT, 'collector', 'dist');
  if (fs.existsSync(dist)) {
    const walk = (d, rel) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else if (!/\.map$/.test(e.name)) files.push(r);
    });
    walk(dist, 'collector/dist');
  } else console.warn('  ! collector/dist isn\'t built (npm run collector:build): the AI Scraper (beta) page won\'t be in the bundle');
  return files;
}

// Production dependencies, once for every target (none needs compiling: bufferutil's optional speed-up is
// skipped, and ws uses its JavaScript fallback), with files that never run removed
function productionModules(cache) {
  const dir = path.join(cache, 'modules');
  const nm = path.join(dir, 'node_modules');
  // (installed for this package-lock.json, to the end: a changed lock file, or an install that stopped half-way,
  // installs again)
  const lock = sha256(path.join(ROOT, 'package-lock.json'));
  const marker = path.join(dir, 'installed-for.txt');
  let done = '';
  try { done = fs.readFileSync(marker, 'utf8').trim(); } catch (e) { done = ''; }
  if (done !== lock || !fs.existsSync(nm)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    copyFile(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
    copyFile(path.join(ROOT, 'package-lock.json'), path.join(dir, 'package-lock.json'));
    console.log('  installing production dependencies (npm ci --omit=dev)…');
    sh(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    const before = dirSize(nm);
    (function prune(d, depth) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) { if (depth > 0 && PRUNE_DIR.has(e.name.toLowerCase())) fs.rmSync(f, { recursive: true, force: true }); else prune(f, e.name.startsWith('@') ? depth : depth + 1); }
        else if (PRUNE_FILE.test(e.name) && !KEEP_FILE.test(e.name)) fs.rmSync(f, { force: true });
      }
    })(nm, 0);
    console.log('  node_modules: ' + mb(before) + ' → ' + mb(dirSize(nm)) + ' after removing maps, type declarations and docs');
    fs.writeFileSync(marker, lock + '\n');
  }
  // (the command-line links in .bin are symbolic links, which zip files and Windows don't keep; nothing uses them)
  fs.rmSync(path.join(nm, '.bin'), { recursive: true, force: true });
  return nm;
}

// The Node.js runtime for a target, checked against nodejs.org's SHASUMS256.txt
async function nodeRuntime(target, version, cache) {
  const win = TARGETS[target].os === 'win';
  const name = 'node-v' + version + '-' + target;
  const file = name + (win ? '.zip' : '.tar.xz');
  const base = 'https://nodejs.org/dist/v' + version + '/';
  const dest = await download(base + file, path.join(cache, file));
  const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
  const want = (sums.split('\n').find(l => l.endsWith('  ' + file)) || '').split(/\s+/)[0];
  const got = sha256(dest);
  if (!want || want !== got) { fs.rmSync(dest, { force: true }); throw new Error(file + ': its sha256 doesn\'t match nodejs.org\'s SHASUMS256.txt'); }
  const x = path.join(cache, name);
  if (!fs.existsSync(x)) {
    // (unpacked beside, then moved into place: an unpacking that stopped half-way is never used)
    const tmp = fs.mkdtempSync(path.join(cache, 'unpack-'));
    if (win) sh('unzip', ['-q', dest, '-d', tmp]); else sh('tar', ['-xJf', dest, '-C', tmp]);
    fs.renameSync(path.join(tmp, name), x);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { binary: win ? path.join(x, 'node.exe') : path.join(x, 'bin', 'node'), license: path.join(x, 'LICENSE'), sha256: got };
}

// ── Launchers ────────────────────────────────────────────────────────────────────────────────────────────────
// server.js does the rest: METACODE_OPEN_BROWSER opens the browser once it listens (or, when MetaCode already runs,
// opens that one), METACODE_HOST=127.0.0.1 keeps it to this computer
// The launcher for a Linux or macOS target. linux-armv7l's also checks for libatomic, which its Node.js needs and
// a minimal system may lack (whatever the kernel says: a Pi 4 or 5 runs 32-bit Raspberry Pi OS on a 64-bit kernel)
const ARM32_CHECK = `# (this folder's Node.js, for 32-bit ARM, needs libatomic: when it isn't in the usual places, a try says whether
# Node.js starts)
if [ "$NODE" = "$DIR/runtime/node" ]; then
  atomic=0
  for f in /usr/lib/arm-linux-gnueabihf/libatomic.so.1 /lib/arm-linux-gnueabihf/libatomic.so.1 /usr/lib/libatomic.so.1 /lib/libatomic.so.1; do [ -e "$f" ] && atomic=1; done
  if [ $atomic = 0 ] && "$NODE" -e '' 2>&1 | grep -q 'libatomic'; then
    echo "MetaCode's Node.js needs libatomic, which this system doesn't have: sudo apt install libatomic1" >&2; exit 1
  fi
fi
`;
const launchSh = target => LAUNCH_SH.replace('__ARM32__', target === 'linux-armv7l' ? ARM32_CHECK : '');
const LAUNCH_SH = `#!/bin/sh
# MetaCode, portable. Everything stays in this folder: data/ holds what the server keeps (your projects live in
# your browser). Settings: a .env file here or in data/ (copy .env.example); it overrides the defaults below.
#   ./metacode.sh                  start MetaCode and open it in the browser (Ctrl+C stops it)
#   ./metacode.sh --install-menu   add MetaCode to the desktop's application menu (Linux)
# Defaults: METACODE_PROFILE=lite, AI_MODE=local-only, PORT=3000, METACODE_HOST=127.0.0.1 (this computer only;
# 0.0.0.0 lets other devices on the network in). METACODE_NO_BROWSER=1: don't open the browser.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
if [ "$1" = "--install-menu" ]; then
  SHARE="\${XDG_DATA_HOME:-$HOME/.local/share}"
  mkdir -p "$SHARE/applications" "$SHARE/icons/hicolor/512x512/apps" || exit 1
  cp "$DIR/public/img/icons/icon-512.png" "$SHARE/icons/hicolor/512x512/apps/metacode.png"
  printf '[Desktop Entry]\\nType=Application\\nName=MetaCode\\nComment=${DESCRIPTION}\\nExec="%s"\\nIcon=metacode\\nTerminal=true\\nCategories=Education;Science;Office;\\n' "\${APPIMAGE:-$DIR/metacode.sh}" > "$SHARE/applications/metacode.desktop"
  echo "Added to the application menu: $SHARE/applications/metacode.desktop"; exit 0
fi
NODE="$DIR/runtime/node"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "MetaCode needs Node.js (22.15 or newer), and this copy has none: https://nodejs.org" >&2; exit 1; fi
__ARM32__: "\${METACODE_DATA_DIR:=$DIR/data}"; : "\${METACODE_PROFILE:=lite}"; : "\${AI_MODE:=local-only}"; : "\${PORT:=3000}"; : "\${METACODE_HOST:=127.0.0.1}"
[ "\${METACODE_NO_BROWSER:-0}" = 1 ] || : "\${METACODE_OPEN_BROWSER:=1}"
mkdir -p "$METACODE_DATA_DIR" || exit 1
if [ -z "\${METACODE_ENV_FILE:-}" ] && [ ! -f "$DIR/.env" ] && [ -f "$METACODE_DATA_DIR/.env" ]; then METACODE_ENV_FILE="$METACODE_DATA_DIR/.env"; export METACODE_ENV_FILE; fi
export METACODE_DATA_DIR METACODE_PROFILE AI_MODE PORT METACODE_HOST METACODE_OPEN_BROWSER
exec "$NODE" "$DIR/server.js"
`;
const LAUNCH_CMD = [
  '@echo off',
  'rem MetaCode, portable. Everything stays in this folder: data\\ holds what the server keeps (your projects live',
  'rem in your browser). Settings: a .env file here or in data\\ (copy .env.example); it overrides the defaults below.',
  'rem Defaults: METACODE_PROFILE=lite, AI_MODE=local-only, PORT=3000, METACODE_HOST=127.0.0.1 (this computer only;',
  'rem 0.0.0.0 lets other devices on the network in). METACODE_NO_BROWSER=1: don\'t open the browser.',
  'setlocal',
  'cd /d "%~dp0"',
  'set "NODE=%~dp0runtime\\node.exe"',
  'if not exist "%NODE%" set "NODE=node"',
  'if not defined METACODE_DATA_DIR set "METACODE_DATA_DIR=%~dp0data"',
  'if not defined METACODE_PROFILE set "METACODE_PROFILE=lite"',
  'if not defined AI_MODE set "AI_MODE=local-only"',
  'if not defined PORT set "PORT=3000"',
  'if not defined METACODE_HOST set "METACODE_HOST=127.0.0.1"',
  'if not "%METACODE_NO_BROWSER%"=="1" if not defined METACODE_OPEN_BROWSER set "METACODE_OPEN_BROWSER=1"',
  'if not exist "%METACODE_DATA_DIR%" mkdir "%METACODE_DATA_DIR%"',
  'if not defined METACODE_ENV_FILE if not exist "%~dp0.env" if exist "%METACODE_DATA_DIR%\\.env" set "METACODE_ENV_FILE=%METACODE_DATA_DIR%\\.env"',
  'title MetaCode',
  'echo.',
  'echo   MetaCode is starting. Close this window to stop it.',
  'echo.',
  '"%NODE%" "%~dp0server.js"',
  'if errorlevel 1 pause',
  '',
].join('\r\n');

function readme(target, o) {
  const start = target.startsWith('win')
    ? 'Double-click ' + (o.installer ? 'MetaCode.exe (or MetaCode.cmd)' : 'MetaCode.cmd') + '. Windows may warn once that it doesn\'t know the app ("More info" →\n  "Run anyway"): it isn\'t signed with a Microsoft certificate.'
    : target.startsWith('darwin') ? 'Double-click MetaCode.command. macOS asks once, because it isn\'t signed with an Apple certificate:\n  right-click → Open (macOS 15: System Settings → Privacy & Security → "Open Anyway").\n  To install MetaCode in Applications instead, use MetaCode-' + PKG.version + '-' + target + '-app.zip.'
    : 'Run ./metacode.sh (./metacode.sh --install-menu adds it to the application menu).' + (target === 'linux-x64' ? '' : '\n  Raspberry Pi: ' + (target === 'linux-arm64' ? '64-bit Raspberry Pi OS (Pi 3, 4, 5, Zero 2 W).' : '32-bit Raspberry Pi OS (Pi 2 and newer).'));
  return `MetaCode ${PKG.version}, portable (${target})

Start it:
  ${start}
MetaCode opens in your browser at http://localhost:3000/app.html. Close the window it runs in to stop it.
Install it as an app from the browser's menu ("Install" / "Add to Home Screen"): it then also opens offline.

Everything stays in this folder (a USB stick works): data/ holds what the server keeps, and your projects
live in your browser. MetaCode listens on this computer only; to use it from a phone or tablet on the same
network, set METACODE_HOST=0.0.0.0 in a .env file here (http://<this computer's address>:3000).

AI on this computer: install Ollama (ollama.com, a separate download), then open MetaCode's AI Model Store
to download models that fit this computer. Prompts never leave it (AI_MODE=local-only). Cloud providers and
other settings: copy .env.example to .env here and edit it (docs/offline-first.md).
`;
}

// ── macOS: MetaCode.app with everything inside ───────────────────────────────────────────────────────────────
// It runs MetaCode's server in a Terminal window (its log shows there, closing the window stops it) because a
// script can't take part in the Dock's Quit. Data: ~/Library/Application Support/MetaCode (a .env file there too).
function macApp(stage, target, out) {
  const root = path.join(out, 'app-' + target);
  fs.rmSync(root, { recursive: true, force: true });
  const contents = path.join(root, 'MetaCode.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  sh('cp', ['-a', stage, path.join(contents, 'Resources', 'app')]);
  ['MetaCode.command', 'README-PORTABLE.txt'].forEach(f => fs.rmSync(path.join(contents, 'Resources', 'app', f), { force: true }));
  copyFile(path.join(ROOT, 'packaging', 'MetaCode.icns'), path.join(contents, 'Resources', 'MetaCode.icns'));
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>MetaCode</string>
  <key>CFBundleDisplayName</key><string>MetaCode</string>
  <key>CFBundleIdentifier</key><string>de.metac0.metacode</string>
  <key>CFBundleVersion</key><string>${PKG.version}</string>
  <key>CFBundleShortVersionString</key><string>${PKG.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>MetaCode</string>
  <key>CFBundleIconFile</key><string>MetaCode</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
  <key>NSAppleEventsUsageDescription</key><string>MetaCode opens Terminal to run its server on this Mac and show its log.</string>
</dict></plist>
`);
  fs.writeFileSync(path.join(contents, 'MacOS', 'MetaCode'), `#!/bin/sh
# MetaCode.app: MetaCode's server runs in a Terminal window (its log shows there; closing the window stops it).
# Your data: ~/Library/Application Support/MetaCode (settings: a .env file there).
APP="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
DATA="$HOME/Library/Application Support/MetaCode"
alert() { /usr/bin/osascript -e 'on run argv' -e 'display alert "MetaCode" message (item 1 of argv) as warning' -e 'end run' "$1" >/dev/null 2>&1; }
# (opened where it was unpacked, macOS runs a temporary copy of it, which may be gone by the time Terminal starts)
case "$APP" in */AppTranslocation/*) alert "Move MetaCode to the Applications folder (or any other folder), then open it from there."; exit 1 ;; esac
mkdir -p "$DATA"
# (already running: open it. Its port is PORT in the .env there, else 3000)
PORT=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'"'"']\\{0,1\\}\\([0-9][0-9]*\\).*/\\1/p' "$DATA/.env" 2>/dev/null | tail -n 1)
[ -n "$PORT" ] || PORT=3000
if /usr/bin/curl -s -m 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"app":"metacode"'; then exec /usr/bin/open "http://localhost:$PORT/app.html"; fi
# (Terminal opens a window when it starts: the server runs in that one then. Refused the permission to control
# Terminal, the app says where to give it)
exec /usr/bin/osascript -e 'on run argv' \\
  -e 'set cmd to "cd " & quoted form of (item 1 of argv) & " && export METACODE_DATA_DIR=" & quoted form of (item 2 of argv) & " && exec ./metacode.sh"' \\
  -e 'set wasRunning to application "Terminal" is running' \\
  -e 'try' -e 'tell application "Terminal"' \\
  -e 'if wasRunning then' -e 'do script cmd' -e 'else' -e 'try' -e 'do script cmd in window 1' -e 'on error' -e 'do script cmd' -e 'end try' -e 'end if' \\
  -e 'activate' -e 'end tell' \\
  -e 'on error m' \\
  -e 'display alert "MetaCode couldn’t start" message "It runs its server in Terminal. Let MetaCode control Terminal: System Settings → Privacy & Security → Automation → MetaCode → Terminal. (" & m & ")" as warning' \\
  -e 'end try' -e 'end run' "$APP" "$DATA"
`, { mode: 0o755 });
  const file = path.join(out, 'MetaCode-' + PKG.version + '-' + target + '-app.zip');
  fs.rmSync(file, { force: true });
  sh('zip', ['-qry9', file, 'MetaCode.app'], { cwd: root });
  fs.rmSync(root, { recursive: true, force: true });
  return file;
}

// ── Linux: .deb and AppImage ──────────────────────────────────────────────────────────────────────────────────
const DESKTOP_ENTRY = exec => '[Desktop Entry]\nType=Application\nName=MetaCode\nComment=' + DESCRIPTION + '\nExec=' + exec + '\nIcon=metacode\nTerminal=true\nCategories=Education;Science;Office;\n';

function deb(stage, target, out) {
  const arch = TARGETS[target].deb;
  const root = path.join(out, 'deb-' + target);
  fs.rmSync(root, { recursive: true, force: true });
  const opt = path.join(root, 'opt', 'metacode');
  fs.mkdirSync(path.dirname(opt), { recursive: true });
  sh('cp', ['-a', stage, opt]);
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'metacode'), '#!/bin/sh\n# MetaCode (installed in /opt/metacode): your data stays in your home folder\n' +
    ': "${METACODE_DATA_DIR:=${XDG_DATA_HOME:-$HOME/.local/share}/metacode}"\nexport METACODE_DATA_DIR\nexec /opt/metacode/metacode.sh "$@"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'usr', 'share', 'applications'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr', 'share', 'applications', 'metacode.desktop'), DESKTOP_ENTRY('metacode'));
  copyFile(path.join(stage, 'public', 'img', 'icons', 'icon-512.png'), path.join(root, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'metacode.png'));
  fs.mkdirSync(path.join(root, 'DEBIAN'), { recursive: true });
  fs.writeFileSync(path.join(root, 'DEBIAN', 'control'), [
    'Package: metacode', 'Version: ' + PKG.version, 'Architecture: ' + arch, 'Maintainer: MetaCode <noreply@metac0.de>',
    'Installed-Size: ' + Math.ceil(dirSize(opt) / 1024), 'Section: science', 'Priority: optional',
    // (Node.js for 32-bit ARM needs libatomic)
    ...(arch === 'armhf' ? ['Depends: libatomic1'] : []), 'Recommends: python3',
    'Homepage: https://metac0.de', 'Description: Social media content analysis and intercoder reliability, offline',
    ' MetaCode with its own Node.js runtime: works without internet, installable as an app in the browser,',
    ' with an AI Model Store for models that run on this computer through Ollama.', ''].join('\n'));
  const file = path.join(out, 'metacode_' + PKG.version + '_' + arch + '.deb');
  sh('dpkg-deb', ['--build', '--root-owner-group', root, file]);
  fs.rmSync(root, { recursive: true, force: true });
  return file;
}

// The AppImage runtime (the program at the start of every AppImage, which mounts the rest): the AppImage
// project's static type2 runtime, checked to be a program for this target's processor
async function appImageRuntime(target, o, cache) {
  const t = TARGETS[target];
  const file = o.appimageRuntime || await download(APPIMAGE_RUNTIME + t.appimage, path.join(cache, 'appimage-runtime-' + t.appimage));
  const b = fs.readFileSync(file);
  if (b.length < 20 || b.readUInt32BE(0) !== 0x7f454c46 || b.readUInt16LE(18) !== t.elf) {
    if (!o.appimageRuntime) fs.rmSync(file, { force: true });
    throw new Error(file + ' isn\'t an AppImage runtime for ' + t.appimage);
  }
  const got = sha256(file);
  // (a runtime given with --appimage-runtime is the builder's own choice)
  if (!o.appimageRuntime && got !== t.appimageSha256) {
    fs.rmSync(file, { force: true });
    throw new Error('The AppImage runtime for ' + t.appimage + ' (' + APPIMAGE_RUNTIME + t.appimage + ') isn\'t the one checked for this MetaCode: its sha256 is ' + got +
      ', not ' + t.appimageSha256 + '. The AppImage project may have rebuilt it: check it, then update appimageSha256 in scripts/build-portable.js, or give one with --appimage-runtime <file>.');
  }
  return { file, sha256: got };
}

async function appImage(stage, target, out, o, cache) {
  if (!has('mksquashfs')) throw new Error('--appimage needs mksquashfs (squashfs-tools)');
  const runtime = await appImageRuntime(target, o, cache);
  const arch = TARGETS[target].appimage;
  const appdir = path.join(out, 'appdir-' + target);
  fs.rmSync(appdir, { recursive: true, force: true });
  fs.mkdirSync(appdir, { recursive: true });
  sh('cp', ['-a', stage, path.join(appdir, 'metacode')]);
  // (the AppImage is read-only: data goes to your home folder, as with the .deb)
  fs.writeFileSync(path.join(appdir, 'AppRun'), '#!/bin/sh\n# MetaCode as an AppImage: your data stays in ~/.local/share/metacode (METACODE_DATA_DIR changes it)\n' +
    'HERE="$(dirname "$(readlink -f "$0")")"\n: "${METACODE_DATA_DIR:=${XDG_DATA_HOME:-$HOME/.local/share}/metacode}"\nexport METACODE_DATA_DIR\nexec "$HERE/metacode/metacode.sh" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(appdir, 'metacode.desktop'), DESKTOP_ENTRY('metacode'));
  copyFile(path.join(stage, 'public', 'img', 'icons', 'icon-512.png'), path.join(appdir, 'metacode.png'));
  copyFile(path.join(stage, 'public', 'img', 'icons', 'icon-512.png'), path.join(appdir, '.DirIcon'));
  const image = path.join(out, 'appimage-' + target + '.squashfs');
  fs.rmSync(image, { force: true });
  sh('mksquashfs', [appdir, image, '-root-owned', '-noappend', '-comp', 'zstd', '-quiet'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const file = path.join(out, 'MetaCode-' + PKG.version + '-' + arch + '.AppImage');
  fs.writeFileSync(file, Buffer.concat([fs.readFileSync(runtime.file), fs.readFileSync(image)]), { mode: 0o755 });
  fs.rmSync(image, { force: true });
  fs.rmSync(appdir, { recursive: true, force: true });
  return { file, runtimeSha256: runtime.sha256 };
}

// ── Windows: MetaCode.exe and a setup program (NSIS) ─────────────────────────────────────────────────────────
const nsisVersion = () => (PKG.version.split('.').concat(['0', '0', '0', '0']).slice(0, 4).map(n => parseInt(n, 10) || 0).join('.'));
// (makensis takes this system's paths: / here, \\ on Windows)
const nsisPath = p => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);
const versionInfo = description => [
  'VIProductVersion "' + nsisVersion() + '"', 'VIAddVersionKey "ProductName" "MetaCode"', 'VIAddVersionKey "FileDescription" "' + description + '"',
  'VIAddVersionKey "FileVersion" "' + PKG.version + '"', 'VIAddVersionKey "ProductVersion" "' + PKG.version + '"', 'VIAddVersionKey "LegalCopyright" "MetaCode"'];
function makensis(script, dir) {
  const file = path.join(dir, 'build.nsi');
  fs.writeFileSync(file, script.join('\n') + '\n');
  sh('makensis', ['-V2', '-INPUTCHARSET', 'UTF8', file], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  fs.rmSync(file, { force: true });
}

// MetaCode.exe: starts MetaCode.cmd next to it (the window MetaCode runs in), with MetaCode's icon
function windowsLauncher(stage, cache) {
  const dir = fs.mkdtempSync(path.join(cache, 'nsis-'));
  copyFile(path.join(ROOT, 'packaging', 'metacode.ico'), path.join(dir, 'metacode.ico'));
  makensis(['Unicode true', 'Name "MetaCode"', 'OutFile "MetaCode.exe"', 'Icon "metacode.ico"', 'RequestExecutionLevel user', 'SilentInstall silent',
    ...versionInfo('MetaCode'), 'Section', '  ExecShell "open" "$EXEDIR\\MetaCode.cmd"', 'SectionEnd'], dir);
  copyFile(path.join(dir, 'MetaCode.exe'), path.join(stage, 'MetaCode.exe'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// The setup program: installs for this user (no administrator rights) in %LOCALAPPDATA%\Programs\MetaCode, with
// Start menu and desktop shortcuts and an entry in Settings → Apps. Uninstalling removes MetaCode's files and
// keeps data\ and .env (your data). (/S installs silently; /D=<folder> elsewhere, always in a folder "MetaCode".)
function windowsInstaller(stage, target, out, cache) {
  const dir = fs.mkdtempSync(path.join(cache, 'nsis-'));
  copyFile(path.join(ROOT, 'packaging', 'metacode.ico'), path.join(dir, 'metacode.ico'));
  const entries = fs.readdirSync(stage, { withFileTypes: true });
  const remove = entries.map(e => e.isDirectory() ? '  RMDir /r "$INSTDIR\\' + e.name + '"' : '  Delete "$INSTDIR\\' + e.name + '"');
  const removeDirs = entries.filter(e => e.isDirectory()).map(e => '  RMDir /r "$INSTDIR\\' + e.name + '"');
  const arch = target.split('-')[1];
  const file = path.join(out, 'MetaCode-Setup-' + PKG.version + '-' + arch + '.exe');
  const UNINST = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MetaCode';
  makensis([
    'Unicode true', '!include "MUI2.nsh"', '!include "FileFunc.nsh"',
    'Name "MetaCode"', 'OutFile "' + nsisPath(file) + '"', 'InstallDir "$LOCALAPPDATA\\Programs\\MetaCode"',
    'RequestExecutionLevel user', 'SetCompressor /SOLID lzma', 'BrandingText "MetaCode ' + PKG.version + '"', ...versionInfo('MetaCode setup'),
    '!define MUI_ICON "metacode.ico"', '!define MUI_UNICON "metacode.ico"',
    '!define MUI_FINISHPAGE_RUN "$INSTDIR\\MetaCode.exe"', '!define MUI_FINISHPAGE_RUN_TEXT "Start MetaCode"',
    '!insertmacro MUI_PAGE_INSTFILES', '!insertmacro MUI_PAGE_FINISH', '!insertmacro MUI_UNPAGE_CONFIRM', '!insertmacro MUI_UNPAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "English"',
    // (a folder given with /D= gets a MetaCode folder inside it, so uninstalling never touches anything else)
    // (a folder named MetaCode is used as it is only when it's empty or already holds MetaCode: one that holds
    // other things gets a MetaCode folder inside it too)
    'Function .onInit', '  ${GetFileName} "$INSTDIR" $0', '  StrCmp $0 "MetaCode" 0 add', '  IfFileExists "$INSTDIR\\portable.json" done 0',
    '  ${DirState} "$INSTDIR" $1', '  IntCmp $1 1 add done done', '  add:', '  StrCpy $INSTDIR "$INSTDIR\\MetaCode"', '  done:', 'FunctionEnd',
    'Section "MetaCode"', '  SetOutPath "$INSTDIR"',
    '  ; an earlier version\'s files go first (data\\ and .env stay)', ...removeDirs,
    '  File /r "' + nsisPath(path.join(stage, '*')) + '"',
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    '  CreateShortCut "$SMPROGRAMS\\MetaCode.lnk" "$INSTDIR\\MetaCode.exe"', '  CreateShortCut "$DESKTOP\\MetaCode.lnk" "$INSTDIR\\MetaCode.exe"',
    '  WriteRegStr HKCU "' + UNINST + '" "DisplayName" "MetaCode"', '  WriteRegStr HKCU "' + UNINST + '" "DisplayVersion" "' + PKG.version + '"',
    '  WriteRegStr HKCU "' + UNINST + '" "Publisher" "MetaCode"', '  WriteRegStr HKCU "' + UNINST + '" "DisplayIcon" "$INSTDIR\\MetaCode.exe"',
    '  WriteRegStr HKCU "' + UNINST + '" "InstallLocation" "$INSTDIR"', '  WriteRegStr HKCU "' + UNINST + '" "UninstallString" \'"$INSTDIR\\Uninstall.exe"\'',
    '  WriteRegStr HKCU "' + UNINST + '" "QuietUninstallString" \'"$INSTDIR\\Uninstall.exe" /S\'',
    '  WriteRegDWORD HKCU "' + UNINST + '" "NoModify" 1', '  WriteRegDWORD HKCU "' + UNINST + '" "NoRepair" 1',
    '  WriteRegDWORD HKCU "' + UNINST + '" "EstimatedSize" ' + Math.ceil(dirSize(stage) / 1024),
    'SectionEnd',
    'Section "Uninstall"', ...remove, '  Delete "$INSTDIR\\Uninstall.exe"',
    '  RMDir "$INSTDIR"', '  ; (only when empty: data\\ and .env stay)',
    '  Delete "$SMPROGRAMS\\MetaCode.lnk"', '  Delete "$DESKTOP\\MetaCode.lnk"', '  DeleteRegKey HKCU "' + UNINST + '"',
    'SectionEnd',
  ], dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return file;
}

(async () => {
  const o = args();
  if (o.installer && o.targets.some(t => TARGETS[t].os === 'win') && !has('makensis')) throw new Error('--installer needs NSIS (makensis): apt install nsis, brew install makensis, or nsis.sourceforge.io');
  fs.mkdirSync(o.out, { recursive: true });
  const cache = path.join(o.out, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const files = appFiles();
  const modules = productionModules(cache);
  for (const target of o.targets) {
    const t = TARGETS[target];
    const name = 'MetaCode-' + PKG.version + '-' + target;
    const stage = path.join(o.out, name);
    console.log('▸ ' + name);
    // (a folder built before may be in use: what it keeps, data/, and its settings, .env, stay)
    const kept = path.join(o.out, '.kept-' + target);
    fs.rmSync(kept, { recursive: true, force: true });
    const keep = ['data', '.env'].filter(f => fs.existsSync(path.join(stage, f)));
    if (keep.length) {
      fs.mkdirSync(kept, { recursive: true });
      keep.forEach(f => fs.renameSync(path.join(stage, f), path.join(kept, f)));
      console.log('  kept ' + keep.join(' and ') + ' from the folder built before');
    }
    fs.rmSync(stage, { recursive: true, force: true });
    for (const f of files) copyFile(path.join(ROOT, f), path.join(stage, f));
    sh('cp', ['-a', modules, path.join(stage, 'node_modules')]);
    let runtime = null;
    if (o.node) {
      runtime = await nodeRuntime(target, o.nodeVersion, cache);
      copyFile(runtime.binary, path.join(stage, 'runtime', path.basename(runtime.binary)), 0o755);
      copyFile(runtime.license, path.join(stage, 'runtime', 'LICENSE'));
    }
    if (t.os === 'win') {
      fs.writeFileSync(path.join(stage, 'MetaCode.cmd'), LAUNCH_CMD);
      if (o.installer) windowsLauncher(stage, cache);
    } else fs.writeFileSync(path.join(stage, 'metacode.sh'), launchSh(target), { mode: 0o755 });
    if (t.os === 'darwin') copyFile(path.join(stage, 'metacode.sh'), path.join(stage, 'MetaCode.command'), 0o755);
    fs.writeFileSync(path.join(stage, 'README-PORTABLE.txt'), readme(target, o));
    fs.writeFileSync(path.join(stage, 'portable.json'), JSON.stringify({ name: 'MetaCode', version: PKG.version, target, node: runtime ? o.nodeVersion : null, nodeSha256: runtime ? runtime.sha256 : null, builtAt: new Date().toISOString() }, null, 2) + '\n');
    const made = ['folder ' + mb(dirSize(stage))];
    const note = f => made.push(path.basename(f) + ' ' + mb(fs.statSync(f).size));
    if (o.archive) {
      const archive = path.join(o.out, name + (t.os === 'win' ? '.zip' : '.tar.gz'));
      fs.rmSync(archive, { force: true });
      // (a folder in use isn't packed with its data/ and .env: they're put back afterwards. Files are packed as
      // root's, not the builder's: unpacked by root, they'd belong to whoever has the builder's user id there)
      if (t.os === 'win') sh('zip', ['-qr9', archive, name, '-x', name + '/data/*', name + '/.env'], { cwd: o.out });
      else sh('tar', tarOwner().concat(['--exclude', name + '/data', '--exclude', name + '/.env', '-czf', archive, '-C', o.out, name]));
      note(archive);
    }
    if (t.os === 'darwin') note(macApp(stage, target, o.out));
    if (o.deb && t.deb) note(deb(stage, target, o.out));
    if (o.appimage && t.appimage) {
      const ai = await appImage(stage, target, o.out, o, cache);
      note(ai.file);
      made.push('AppImage runtime sha256 ' + ai.runtimeSha256);
    }
    if (o.installer && t.os === 'win') note(windowsInstaller(stage, target, o.out, cache));
    // (what was kept goes back into the folder, now that the packages are made without it)
    if (fs.existsSync(kept)) {
      for (const f of fs.readdirSync(kept)) fs.renameSync(path.join(kept, f), path.join(stage, f));
      fs.rmSync(kept, { recursive: true, force: true });
    }
    console.log('  ' + made.join(', '));
  }
})().catch(e => { console.error('build-portable: ' + e.message); process.exit(1); });

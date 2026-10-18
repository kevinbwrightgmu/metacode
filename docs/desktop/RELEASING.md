# Releasing MetaCode Sheets

## 1. The lease key (do this once per server)

The server signs offline leases with an Ed25519 key. Give production a fixed
key so every server instance, and every app build, agrees on it:

```bash
openssl genpkey -algorithm ed25519 -out desktop-lease-key.pem
# on the server (.env) — SECRET, never commit it:
DESKTOP_LEASE_PRIVATE_KEY="$(awk '{printf "%s\\n", $0}' desktop-lease-key.pem)"
```

Its public key (not secret) is what release builds pin. Read it from the
running server:

```bash
curl -s https://metac0.de/api/desktop/config | jq -r .lease.publicKey
```

Set it as the GitHub Actions **variable** `DESKTOP_LEASE_PUBLIC_KEYS`
(Settings › Secrets and variables › Actions › Variables). To rotate keys
without locking out installed apps, list the new and old keys,
comma-separated, for one release cycle (the lease lifetime), then switch the
server's private key.

`scripts/build.js` writes the keys into `app-config.json` for the build only
and puts the file back afterwards. Builds without pinned keys print a warning
and trust the key the server publishes over HTTPS (fine for testing).

## 2. Code signing

All signing material lives in GitHub **secrets**; nothing is committed.

**Windows** (Authenticode): export the code-signing certificate as a
password-protected `.pfx`, then set

- `CSC_LINK` — the `.pfx`, base64-encoded (`base64 -w0 cert.pfx`)
- `CSC_KEY_PASSWORD` — its password

(EV certificates on hardware tokens or Azure Trusted Signing need
electron-builder's `win.azureSignOptions` / a custom sign hook instead.)

**macOS** (Developer ID Application certificate):

- `CSC_LINK` / `CSC_KEY_PASSWORD` — the `.p12` export, base64, and password

Without these secrets the builds still work. Empty secrets count as not set.
Windows installers are unsigned and SmartScreen warns once. Mac apps are
ad-hoc signed (Apple silicon won't open an unsigned app at all), and macOS asks
people to allow them once in System Settings › Privacy & Security ›
Open Anyway; the download page explains both.

## 3. macOS notarization

With these secrets set, electron-builder notarizes the app after signing
(hardened runtime; entitlements in `desktop/build/entitlements.mac.plist`:
only JIT and outgoing network):

- `APPLE_ID` — the Apple ID e-mail
- `APPLE_APP_SPECIFIC_PASSWORD` — an app-specific password for it
- `APPLE_TEAM_ID` — the team ID

## 4. Building a release

1. Set `"version"` in `desktop/package.json` (e.g. `1.1.0`), commit to main.
2. Start the build, either way:
   - on GitHub: **Actions › Desktop app › Run workflow** on `main`, with
     **create a draft release** ticked (no tag needed: publishing the draft
     creates `desktop-v1.1.0` on that commit), or
   - with git: `git tag desktop-v1.1.0 && git push origin desktop-v1.1.0`.
3. The **Desktop app** workflow runs the tests, builds on Windows, macOS and
   Linux, and creates a **draft** GitHub release with the installers and
   `SHA256SUMS.txt`.
4. Check the draft (install on each OS: sign in with a Pro account, open a
   workbook, sign in with a Free account and see the upgrade screen), then
   publish it. Leave "Set as a pre-release" unticked: pre-releases aren't offered.
5. Within 10 minutes the website's download page (`/download`) offers the new
   version; its links (`/download/desktop/windows` …) now lead to the new
   files. Raise `DESKTOP_MIN_VERSION` only when older versions must stop
   working: those apps then send people to `/download` (or to
   `DESKTOP_DOWNLOAD_URL`, if set).

Manual builds: `cd desktop && npm ci && npm run dist:<linux|win|mac>`.
Windows installers need Windows (or Wine), `.dmg` files need macOS.

## 5. Updates

This version has no auto-updater: people install new versions from the
website's download page, and the server can require a minimum version
(`DESKTOP_MIN_VERSION`), which shows "Update MetaCode Sheets" with a download
link. Adding signed auto-updates (electron-updater, which checks the
publisher's signature on Windows and macOS) is the next step on the roadmap;
it needs the signing above first.

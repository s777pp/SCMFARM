# SCMFARM

A desktop app for Windows that farms Steam trading cards **on the user's own PC**, made by
[showcasemaker.com](https://showcasemaker.com). A step-by-step wizard replaces console windows and config files.

Farming engine: [ArchiSteamFarm](https://github.com/JustArchiNET/ArchiSteamFarm) (ASF) by JustArchi,
Apache-2.0, used **unmodified** as a hidden sidecar process. The app is not ASF and is not affiliated with it.
Research notes on how we use ASF: [docs/RESEARCH.md](docs/RESEARCH.md).

## How it works

```
 SCMFARM window (HTML/CSS/JS in WebView2)
        │  Tauri commands (src-tauri/src/*.rs)
        ▼
 Rust side ── downloads ASF-win-x64.zip (pinned 6.3.11.7, SHA-512 checked) into %APPDATA%\com.showcasemaker.farm\asf
          ── writes config/ASF.json + config/IPC.config (127.0.0.1, random port, random IPC password)
          ── starts ArchiSteamFarm.exe hidden (CREATE_NO_WINDOW, Headless) and stops it on exit
          ── proxies /Api/... calls to ASF's IPC REST API
        ▼
 ASF ── Steam
```

* The Steam password is never stored: it goes from the sign-in form to ASF's memory over 127.0.0.1
  (`POST /Api/Bot/main/Input`). After the first sign-in ASF keeps Steam's login token in `config/main.db`.
* Sign-in by QR code (scan in the Steam Mobile app, no password) or by password + Steam Guard: the wizard shows the e-mail code screen or the Steam Mobile app code screen, depending on what
  ASF asks for (`RequiredInput`).
* Several Steam accounts (one ASF bot each), Windows notifications and optional Telegram messages through the user's
  own bot, a "sets close to a badge" panel from the Steam inventory, and Steam sale dates on the dashboard.
* No telemetry. ASF's own extras are switched off (`RemoteCommunication: 0`, self-update off, `FilterBadBots` off).

## Project layout

| Path | What |
|---|---|
| `ui/` | The whole interface: `index.html`, `css/` (tokens copied from the site), `js/app.js` (wizard + dashboard), `js/farm.js` (ASF logic), `js/backend.js` (Tauri bridge + demo mock), `js/locales/` (en ru de tr fr uk es pt) |
| `src-tauri/src/engine.rs` | Download/verify/unpack ASF, start/stop it, IPC proxy, log tail |
| `src-tauri/src/settings.rs` | App settings file, autostart, opening links |
| `src-tauri/src/lib.rs` | Tray icon, close-to-tray, single instance, cleanup on exit |
| `src-tauri/src/extras.rs` | Windows notifications, the user's own Telegram bot, the showcasemaker.com feed (sale dates, set prices) |
| `src-tauri/src/updater.rs` | Signed self-update of the portable exe |
| `licenses/` | ArchiSteamFarm licence (Apache-2.0), Montserrat font licence (OFL), qrcode-generator (MIT) — built into the exe (`src-tauri/src/system.rs`), About → Licences writes them out |
| `scripts/preview.mjs` | Serves `ui/` for a browser preview in demo mode |

## Build on Windows

One-time setup:

1. **Microsoft C++ Build Tools** — <https://visualstudio.microsoft.com/visual-cpp-build-tools/>, select the
   workload **"Desktop development with C++"** (MSVC + Windows SDK).
2. **Rust** — <https://rustup.rs> → run `rustup-init.exe`, accept the defaults (`stable-x86_64-pc-windows-msvc`).
3. **Node.js 18+** — already needed for the Tauri CLI (`npm install` pulls `@tauri-apps/cli`).
4. **WebView2** — already part of Windows 10/11.

Then in this folder:

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` compiles the Rust side (the first build takes a few minutes) and opens the app window.
The first run downloads ASF (~20 MB) into `%APPDATA%\com.showcasemaker.farm\asf`.

Release exe:

```bash
npm run build
```

The program is one portable file, `src-tauri/target/release/SCMFARM.exe` (no installer; `bundle.active` is
false). Close a running SCMFARM first, the build replaces that file.

### UI only (no Rust, no Steam)

```bash
npm run preview
```

Open <http://127.0.0.1:5199>. Without Tauri the UI uses an in-memory mock (yellow "Demo mode" badge):
any login works, password `wrong` shows the wrong-password error, a login containing `app` asks for the
Steam Mobile code instead of the e-mail code, any 5 characters pass as a code.

## Updating the bundled ASF version

Change `ASF_VERSION`, `ASF_URL` and `ASF_SHA512` in `src-tauri/src/engine.rs` (hash from the release's
`SHA512SUMS`). On next start the app downloads the new build and keeps the existing `config/` folder,
so users stay signed in. Read the ASF changelog for IPC changes first.

## Continuous integration

[`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml) builds `SCMFARM.exe` on a
GitHub-hosted Windows runner for every push to `main`, every pull request and every `v*` tag, runs the Rust tests
and uploads the exe as a workflow artifact. Release binaries are only ever taken from these CI runs, never from a developer's PC.
`scripts/check-version.mjs` runs first and fails the build if `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and the release tag disagree on the version, or if the product name is not
"SCMFARM". Commit `src-tauri/Cargo.lock` after the first build so CI builds are reproducible.

To release: bump the version in all three files, commit, tag `vX.Y.Z`, push the tag. The tag build publishes a
GitHub release with `SCMFARM.exe` and `latest.json`.

## Releases and self-update

* `latest.json` (from `scripts/sign-release.mjs` in CI): version, size, SHA-256 of the exe and an ed25519
  signature over `SCMFARM <version> <sha256>`. The private key is the GitHub secret `RELEASE_KEY` (the owner keeps
  an offline copy); the public key is `RELEASE_PUBLIC_KEY` in `src-tauri/src/updater.rs`.
* showcasemaker.com mirrors the newest GitHub release: `/api/scmfarm/latest` serves the manifest with a download
  URL on the site, `/download/scmfarm` serves the exe (cached on the VPS, GitHub as fallback).
* On start the app asks `/api/scmfarm/latest`. A newer version is downloaded next to the running exe, checked
  (SHA-256 + signature), swapped in (`SCMFARM.exe` → `SCMFARM.exe.old`, new file in place) and started; the new
  process deletes the old file once the old one has exited. Offline or no release: the app just starts.
  Dev builds (`npm run dev`) never update themselves.

## Install and uninstall

Nothing to install: download `SCMFARM.exe` and run it (no admin rights). It keeps its data in
`%APPDATA%\com.showcasemaker.farm` (settings, the downloaded ASF engine, the Steam login token) and the window's
WebView profile in `%LOCALAPPDATA%\com.showcasemaker.farm`. "Start with Windows" adds a normal autostart entry.

To uninstall: About → **Remove SCMFARM from this PC**. It stops the engine, removes the autostart entry, deletes
both folders and the exe itself, then quits.

## Privacy

* SCMFARM has **no telemetry, analytics or crash reporting**. If anything like that is ever added, it
  will be off until the user explicitly agrees.
* The Steam login and password are used only to sign in to Steam through the local ASF process
  (127.0.0.1). The password is never written to disk and never sent to showcasemaker.com or anyone else.
  Steam's login token stays in the app data folder on the user's PC.
* Network connections the app makes:
  * Steam (by ASF, for signing in, farming and reading the account's own inventory for the sets panel);
  * GitHub (one-time download of the pinned ASF release);
  * Steam's image CDN (game pictures and avatars on the dashboard);
  * showcasemaker.com, only with the matching switch on (Settings → Options, both on by default and explained there):
    "Update SCMFARM automatically" asks once per start for the newest version; "Steam news from showcasemaker.com"
    downloads at most once a day one file that is the same for everyone (Steam sale dates, card set sizes and
    prices). Neither request carries account data or identifiers;
  * api.telegram.org, only if the user connects their **own** Telegram bot (token from @BotFather). Messages go
    straight from the PC to Telegram and contain only the account's display name and what happened ("farming
    finished", "Steam asks for a code"). The bot token and chat id stay in `settings.json` on the PC; "Turn off"
    deletes them.
  The "showcasemaker.com" button and the links in the app only open pages in the user's browser.
* Windows notifications are local (switch "Notify me").
* ASF's optional remote features (joining its Steam group, public trade listing, self-update, bad-bot list)
  are switched off by the app.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

*(Applied to SignPath Foundation in November 2026; until the project is accepted, the exe from CI is unsigned.)*

* Only `SCMFARM.exe` files built by the GitHub Actions workflow in this repository from a tagged commit are signed.
* Every component is open source under an OSI-approved licence: SCMFARM (Apache-2.0), ArchiSteamFarm
  (Apache-2.0, downloaded unmodified at first run), Tauri (Apache-2.0/MIT), Montserrat (OFL-1.1), qrcode-generator (MIT).
  There are no proprietary parts and no commercial dual licensing.

Team roles:

| Role | Who |
|---|---|
| Committers and reviewers | [@s777pp](https://github.com/s777pp) (owner of showcasemaker.com) |
| Approvers (approve each signing request) | [@s777pp](https://github.com/s777pp) |

Changes from anyone outside this list (pull requests) are reviewed by a committer before they are merged.

The privacy statement for signed releases is the [Privacy](#privacy) section above.

## Roadmap

* **Done:** wizard, one account, dashboard, tray, autostart, eight languages, own title bar, log out,
  portable exe with signed self-update, download page on showcasemaker.com.
* **0.2.0:** several Steam accounts, notifications (Windows, own Telegram bot), sets close to a badge, Steam sale dates.
* **Next:** code signing via SignPath Foundation (applied; enable the SignPath step in the workflow on approval).
* **Later:** "approve in the Steam app" sign-in, a Windows job object so the engine always exits with the app.

## Licences

* SCMFARM: **Apache License 2.0** — [LICENSE](LICENSE), attributions in [NOTICE](NOTICE).
* ArchiSteamFarm: Apache License 2.0 — `licenses/ArchiSteamFarm-LICENSE.txt`; the downloaded ASF folder also
  keeps its own `LICENSE.txt`. ASF has no NOTICE file. The About dialog credits ASF and links to its repository.
* Montserrat: SIL Open Font License 1.1 — `licenses/Montserrat-OFL.txt`.

# Showcase Farm

A desktop app for Windows that farms Steam trading cards **on the user's own PC**, made by
[showcasemaker.com](https://showcasemaker.com). A step-by-step wizard replaces console windows and config files.

Farming engine: [ArchiSteamFarm](https://github.com/JustArchiNET/ArchiSteamFarm) (ASF) by JustArchi,
Apache-2.0, used **unmodified** as a hidden sidecar process. The app is not ASF and is not affiliated with it.
Research notes on how we use ASF: [docs/RESEARCH.md](docs/RESEARCH.md).

## How it works

```
 Showcase Farm window (HTML/CSS/JS in WebView2)
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
* No telemetry. ASF's own extras are switched off (`RemoteCommunication: 0`, self-update off, `FilterBadBots` off).

## Project layout

| Path | What |
|---|---|
| `ui/` | The whole interface: `index.html`, `css/` (tokens copied from the site), `js/app.js` (wizard + dashboard), `js/farm.js` (ASF logic), `js/backend.js` (Tauri bridge + demo mock), `js/locales/` (en, ru) |
| `src-tauri/src/engine.rs` | Download/verify/unpack ASF, start/stop it, IPC proxy, log tail |
| `src-tauri/src/settings.rs` | App settings file, autostart, opening links |
| `src-tauri/src/lib.rs` | Tray icon, close-to-tray, single instance, cleanup on exit |
| `licenses/` | ArchiSteamFarm licence (Apache-2.0), Montserrat font licence (OFL) — shipped inside the installer |
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

Installer:

```bash
npm run build
```

The NSIS installer lands in `src-tauri/target/release/bundle/nsis/`.

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

[`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml) builds the NSIS installer on a
GitHub-hosted Windows runner for every push to `main`, every pull request and every `v*` tag, and uploads it as
a workflow artifact. Release binaries are only ever taken from these CI runs, never from a developer's PC.
`scripts/check-version.mjs` runs first and fails the build if `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and the release tag disagree on the version, or if the product name is not
"Showcase Farm". Commit `src-tauri/Cargo.lock` after the first build so CI builds are reproducible.

To release: bump the version in all three files, commit, tag `vX.Y.Z`, push the tag.

## Install and uninstall

The installer is a per-user NSIS installer (no admin rights needed). It registers a normal uninstaller in
Windows "Apps & features". The uninstaller removes the program and offers to delete the app data folder
(`%APPDATA%\com.showcasemaker.farm`: settings, the downloaded ASF engine and the Steam login token).
Quit the app from the tray first so the engine is stopped.

## Privacy

* Showcase Farm has **no telemetry, analytics or crash reporting**. If anything like that is ever added, it
  will be off until the user explicitly agrees.
* The Steam login and password are used only to sign in to Steam through the local ASF process
  (127.0.0.1). The password is never written to disk and never sent to showcasemaker.com or anyone else.
  Steam's login token stays in the app data folder on the user's PC.
* Network connections the app makes: Steam (by ASF, for signing in and farming), GitHub (one-time download
  of the pinned ASF release), Steam's image CDN (game pictures and the avatar on the dashboard).
  The "showcasemaker.com" button only opens the site in the user's browser.
* ASF's optional remote features (joining its Steam group, public trade listing, self-update, bad-bot list)
  are switched off by the app.

## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

*(Signing is planned for the first public release; until then installers from CI are unsigned.)*

* Only installers built by the GitHub Actions workflow in this repository from a tagged commit are signed.
* Every component is open source under an OSI-approved licence: Showcase Farm (Apache-2.0), ArchiSteamFarm
  (Apache-2.0, downloaded unmodified at first run), Tauri (Apache-2.0/MIT), Montserrat (OFL-1.1), qrcode-generator (MIT).
  There are no proprietary parts and no commercial dual licensing.

Team roles:

| Role | Who |
|---|---|
| Authors (committers) | Project owner (showcasemaker.com) |
| Reviewers | Project owner (showcasemaker.com) |
| Approvers (approve each signing request) | Project owner (showcasemaker.com) |

The privacy statement for signed releases is the [Privacy](#privacy) section above.

## Roadmap

* **Stage 1 (this prototype):** wizard, one account, dashboard, tray, autostart, RU/EN.
* **Stage 2:** several Steam accounts, the remaining six languages (de, tr, fr, uk, es, pt), QR re-login from the dashboard, "approve in the
  Steam app" sign-in, a Windows job object so the engine always exits with the app.
* **Stage 3:** first public release from CI, code signing via SignPath Foundation (apply after the first
  public release, then add the SignPath GitHub Action to the workflow), auto-update, download page on
  showcasemaker.com.

## Licences

* Showcase Farm: **Apache License 2.0** — [LICENSE](LICENSE), attributions in [NOTICE](NOTICE).
* ArchiSteamFarm: Apache License 2.0 — `licenses/ArchiSteamFarm-LICENSE.txt`; the downloaded ASF folder also
  keeps its own `LICENSE.txt`. ASF has no NOTICE file. The About dialog credits ASF and links to its repository.
* Montserrat: SIL Open Font License 1.1 — `licenses/Montserrat-OFL.txt`.

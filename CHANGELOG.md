# Changelog

Format: newest first. Versions follow `package.json` / `tauri.conf.json` / `Cargo.toml` (kept equal by
`scripts/check-version.mjs`).

## Unreleased (0.1.0 prototype) — 2026-11-03

### Added (accounts)
- **Account avatars in the title bar** (left of the language menu): avatar with a green dot when connected; click
  opens a menu with name, login, status and **Log out**. Name and avatar are remembered in `settings.json`
  (`account`), so they show at the next start before Steam connects. Built as a list, ready for several accounts.
- **Log out** (title bar menu, and a button on the "signed in" card of step 2): asks in the app's own window, stops
  the bot and deletes it through ASF (`DELETE /Api/Bot/main`: ASF removes the bot's config and database, so the
  Steam sign-in token leaves the PC), clears the login and goes back to the sign-in step.
- **Own yes / no window** (`ask()` in app.js) instead of the WebView's `confirm()`, also for "skip this game".
- Fixed: the global form handler blocked `<dialog>` forms, so "About" could not be closed with its button.

### Changed (owner feedback after the first launch)
- **Name: SCMFARM** (was "Showcase Farm"): window title, tray, installer (`SCMFARM_<ver>_x64-setup.exe`),
  texts, docs. Identifier `com.showcasemaker.farm` and the data folder stay the same, so nothing is lost.
- **Icons from showcasemaker.com**: the site's white S with an arrow on its navy tile
  (`src-tauri/icons/*`, `ui/img/logo.png`), made from the site's `static/icon.png`.
- **Looks like an app, not a page**: no Windows frame (`decorations: false`); the top bar is our own title bar
  (drag to move, double-click to maximise, min / max / close buttons, close still goes to the tray);
  full-height step sidebar, the step text and the buttons bar fill the window, a status bar at the bottom;
  no text selection or browser right-click menu outside text fields; thin app scrollbars.
- **Default window 1180 x 760** (min 980 x 660); every wizard step and the dashboard fit without a scrollbar
  (only the game queue scrolls inside its panel; the "Steam asks for the password again" box is one row now).
- **Language menu** in the app's style (globe, current language, list with codes) instead of the system select.
- **showcasemaker.com** in the status bar is a link.
- **QR button with an empty login** now says why nothing starts (the login is needed to check that the phone
  approves this exact account) instead of only focusing the field; the error takes the privacy note's place.

### Added
- **QR sign-in** via the Steam Mobile app (no password). ASF allows QR only outside Headless mode, so the
  engine is restarted non-headless for the sign-in and back to headless after Steam issues the token.
  QR rendered with vendored `ui/vendor/qrcode.js` (qrcode-generator 1.5.2, MIT). Commit `340572c`.
- `Cargo.lock` committed for reproducible builds. Commit `313131f`.
- **SignPath-ready repo**: Apache-2.0 `LICENSE` + `NOTICE`, GitHub Actions Windows build of the NSIS installer
  (`.github/workflows/build-windows.yml`), version/product-name check, README sections "Code signing policy",
  "Privacy", "Install and uninstall", "Roadmap". Commit `5ac2743`.
- **Prototype** (commit `4944db9`):
  - `docs/RESEARCH.md` — ASF 6.3.11.7 IPC API, headless Steam Guard flow, password handling, release asset +
    SHA-512, licence notes.
  - Tauri 2 shell: downloads pinned ASF, verifies SHA-512, writes `ASF.json`/`IPC.config` (127.0.0.1, random
    port + password), runs ASF hidden, proxies `/Api/...`, stops it on exit; tray, close-to-tray, single
    instance, autostart with Windows.
  - UI in showcasemaker.com style: 5-step wizard (how it works + slot calculator, Steam sign-in with e-mail /
    mobile-app codes, what to farm, options, start) and dashboard (current game, cards/games/time left,
    farm-next / skip, levels to next showcase slot, link to the site). RU + EN, structure for 8 languages.
  - Demo mode (`npm run preview`) with an in-memory engine mock.

### Verified
- Release build compiles with no errors or warnings on Windows 11 (Rust 1.99.1, MSVC Build Tools 2022);
  installer `src-tauri/target/release/bundle/nsis/Showcase Farm_0.1.0_x64-setup.exe` (~3 MB).
- Owner launched the app: engine download and start work.
- Whole wizard, error states and QR screen checked in the browser demo mode.

### Not verified yet
- QR sign-in and password + Steam Guard sign-in against real Steam.
- Actual farming on a real account (dashboard numbers from ASF).
- The GitHub Actions workflow (repo has no GitHub remote yet).

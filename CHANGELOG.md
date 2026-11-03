# Changelog

Format: newest first. Versions follow `package.json` / `tauri.conf.json` / `Cargo.toml` (kept equal by
`scripts/check-version.mjs`).

## Unreleased (0.1.0 prototype) — 2026-11-03

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

# SCMFARM — notes for Claude sessions

Read first: `docs/HANDOFF.md` (current state and next steps), `CHANGELOG.md`, `docs/RESEARCH.md` (how ASF is used).

## Owner and rules
- The owner runs showcasemaker.com (Steam profile showcase tools) and speaks Russian: **talk to them in
  Russian**; code, comments, commit messages and docs in English.
- Product name is **SCMFARM**, never "ASF". Say "Powered by ArchiSteamFarm". Keep ASF's licence in
  `licenses/`, ASF itself runs **unmodified**.
- Never send the user's Steam password anywhere but the local ASF process; never write it to disk.
  No telemetry without explicit consent.
- UI texts are our own words (never copy other sites). Languages: en, ru done; de tr fr uk es pt planned
  (`ui/js/i18n.js` registry, one file per language in `ui/js/locales/`).
- Design comes from the site (`ui/css/tokens.css` copied from the showcasemaker.com repo,
  `static/css/tokens.css` there). The site repo is read-only from here.
- Every component must stay OSI-licensed (SignPath Foundation signing requirement). Release binaries only
  from CI. Keep versions equal in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- Commit finished steps; do not push unless the owner asks. Update `CHANGELOG.md` and `docs/HANDOFF.md`
  when a step is done.

## Build
- Toolchain on the owner's PC: Rust stable (rustup, `%USERPROFILE%\.cargo\bin` — add to PATH in new shells),
  MSVC Build Tools 2022, Node 24.
- `npm run build` → `src-tauri/target/release/bundle/nsis/SCMFARM_<ver>_x64-setup.exe`;
  `npm run dev` for a dev window; `npm run preview` → UI in a browser with a mock engine (demo mode).
- Claude's auto-mode refuses to launch the built app (it downloads and runs ASF), so live tests are done by
  the owner; ask them for `%APPDATA%\com.showcasemaker.farm\asf\log.txt` when something fails.

# Hand-off: where the work stands

Last updated 2026-11-03. History of changes: `CHANGELOG.md`.

## State
- Stage 0 (research) and stage 1 (prototype) are done and committed on `master` (local repo
  `G:\Projects\showcase-farm`, no GitHub remote yet).
- The release build works on the owner's PC; the owner launched it and the engine downloads/starts.
- Sign-in options: QR code (Steam Mobile app, no password) or password + Steam Guard code (e-mail or app).
- Neither sign-in nor real farming has been confirmed against a real Steam account yet — **first thing to do**:
  ask the owner to sign in (QR first) and run farming for a while, then check the dashboard against ASF's log.

## Where things are
| What | Where |
|---|---|
| ASF download / start / stop / IPC proxy / log tail | `src-tauri/src/engine.rs` (pinned version + SHA-512 at the top) |
| Settings file, autostart, open links | `src-tauri/src/settings.rs` |
| Tray, close-to-tray, single instance, cleanup on exit | `src-tauri/src/lib.rs` |
| Wizard + dashboard | `ui/js/app.js` |
| ASF logic: bot config, sign-in state machine (password, codes, QR), status, XP math | `ui/js/farm.js` |
| Tauri bridge + demo mock | `ui/js/backend.js` |
| Texts | `ui/js/locales/en.js`, `ru.js` |
| Runtime data on the user's PC | `%APPDATA%\com.showcasemaker.farm\` (`settings.json`, `asf\` with `config\main.json`, `main.db` token, `log.txt`) |

## Key decisions (why it is built this way)
- ASF runs Headless with stdin empty; when it needs input it stops the bot and sets `RequiredInput`; the UI
  sends `POST /Api/Bot/main/Input` and starts the bot again. Details in `docs/RESEARCH.md` §3.
- QR sign-in needs non-headless ASF, so the engine restarts in that mode only for the QR sign-in
  (`engine_start(interactive=true)`), then back to headless.
- One bot named `main`. ASF self-update off; the app pins the ASF version.
- Farming options map to ASF config: `FarmingOrders`, `FarmingPreferences` (SkipRefundableGames,
  FarmPriorityQueueOnly for "only chosen games"), `RemoteCommunication: 0`.

## Next steps
1. Test with a real account (QR and password flows, farming, pause/resume, skip, farm next). Fix what breaks.
2. Stage 2: several accounts; the six remaining languages; a Windows Job object so ASF always dies with the
   app; QR re-login directly from the dashboard; maybe "tap Approve" sign-in (needs non-headless ASF with a
   stdin pipe answering the DeviceConfirmation prompt).
3. Stage 3: push to GitHub, first CI build, first public release, then apply to SignPath Foundation and add
   their GitHub Action; auto-update; download page on showcasemaker.com.

## Window and look (2026-11-03)
- No Windows frame (`tauri.conf.json` `decorations: false`, `shadow: true`): `#titlebar` in `ui/index.html` is the
  title bar; `ui/js/app.js` "window frame" block drags it (`startDragging`), double-click maximises, `#winCtl` buttons
  call minimize / toggleMaximize / close; permissions in `src-tauri/capabilities/default.json`. In the browser demo
  the buttons are hidden (no Tauri).
- Layout targets the default 1180 x 760 window with no scrollbar: check every wizard step and the dashboard at that
  size after UI changes (`npm run preview`, viewport 1180 x 760).

## Accounts (2026-11-03)
- `accounts()` in app.js builds the title bar list from `settings.account` + the live bot; still one ASF bot
  `main`. Several accounts = several bots: give each a name, loop `accounts()` over them, keep `deleteBot(name)`.
- Log out = `stopBot()` + `deleteBot()` (ASF deletes config + .db) + clear `login` / `account` / `wizardDone`.

## Gotchas
- New shells may not have Rust on PATH: prepend `%USERPROFILE%\.cargo\bin`.
- `zip` crate is pinned to 2.x on purpose (API used in `engine.rs`).
- CSP blocks inline scripts/handlers: no `onerror=` etc. in HTML strings (see the global image error handler
  at the end of `app.js`).

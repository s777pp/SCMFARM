# Hand-off: where the work stands

Last updated 2026-11-03 (0.2.0). History of changes: `CHANGELOG.md`.

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
| Texts | `ui/js/locales/<lang>.js`: en ru de tr fr uk es pt |
| Runtime data on the user's PC | `%APPDATA%\com.showcasemaker.farm\` (`settings.json`, `asf\` with `config\main.json`, `main.db` token, `log.txt`) |

## Key decisions (why it is built this way)
- ASF runs Headless with stdin empty; when it needs input it stops the bot and sets `RequiredInput`; the UI
  sends `POST /Api/Bot/main/Input` and starts the bot again. Details in `docs/RESEARCH.md` §3.
- QR sign-in needs non-headless ASF, so the engine restarts in that mode only for the QR sign-in
  (`engine_start(interactive=true)`), then back to headless.
- One ASF bot per Steam account (0.2.0): the first is `main` (as in 0.1.x), added ones `acc2`, `acc3`, … ASF
  self-update off; the app pins the ASF version.
- Farming options map to ASF config: `FarmingOrders`, `FarmingPreferences` (SkipRefundableGames,
  FarmPriorityQueueOnly for "only chosen games"), `RemoteCommunication: 0`.

## Release status (2026-11-03)
- Public repo https://github.com/s777pp/SCMFARM (branch `main`). v0.1.0 released by CI from tag `v0.1.0`;
  the latest.json signature verifies with `RELEASE_PUBLIC_KEY`.
- showcasemaker.com mirrors it (VPS `.env`: `SCMFARM_REPO=s777pp/SCMFARM`): `/api/scmfarm/latest` answers 0.1.0,
  `/download/scmfarm` serves the exe.
- SignPath Foundation: application sent 2026-11-03 (category Gaming, privacy URL = README#privacy). On approval: API token
  as secret SIGNPATH_API_TOKEN, uncomment the SignPath step in the workflow, point the release at the signed file.
- Private signing key: GitHub secret `RELEASE_KEY`; owner's copy outside any repo. Next release: bump the version in
  the three files, commit, tag `vX.Y.Z`, push branch and tag.

## Next steps
1. Test 0.2.0 with real accounts: a second account, a Windows notification, a Telegram message from the owner's own
   bot, the sets panel against the real inventory JSON (field names in `cardsByGame` are read case-insensitively).
2. Still open: a Windows Job object so ASF always dies with the app; "tap Approve" sign-in (needs non-headless ASF
   with a stdin pipe answering the DeviceConfirmation prompt).
3. SignPath: on approval enable the workflow step.

## Window and look (2026-11-03)
- No Windows frame (`tauri.conf.json` `decorations: false`, `shadow: true`): `#titlebar` in `ui/index.html` is the
  title bar; `ui/js/app.js` "window frame" block drags it (`startDragging`), double-click maximises, `#winCtl` buttons
  call minimize / toggleMaximize / close; permissions in `src-tauri/capabilities/default.json`. In the browser demo
  the buttons are hidden (no Tauri).
- Layout targets the default 1180 x 760 window with no scrollbar: check every wizard step and the dashboard at that
  size after UI changes (`npm run preview`, viewport 1180 x 760).

## Accounts (0.2.0)
- `settings.accounts` = `[{ bot, login, name, avatar, level, farmMode, order, chosenText, skipRefundable }]`,
  `settings.current` = the bot the dashboard shows. App-wide options stay top-level. `migrateSettings()` in app.js
  moves a 0.1.x flat setup into `accounts[0]` with bot `main`, so users stay signed in.
- The wizard edits `state.draft` (a copy of an account, or a new one from `newAccount()`); "Start farming" saves it
  into the list. "Add account" (title bar `+` or the account menu) opens the wizard at the sign-in step; "Back to
  the farm" in the step rail drops an unfinished new bot from ASF again.
- Polling: one `GET /Api/Bot/main,acc2,…` every 3 s; avatars in the title bar and tabs in the dashboard head
  switch the account. Log out = `stopBot(bot)` + `deleteBot(bot)` and remove it from the list.
- QR sign-in restarts the whole engine non-headless, so other accounts reconnect once (they keep their tokens).

## Notifications, feed, sets panel (0.2.0)
- `src-tauri/src/extras.rs`: `notify_toast` (tauri-plugin-notification), `telegram_link` / `telegram_send` (the
  user's own bot, token + chat id in settings.json key `telegram`), `feed_get` (showcasemaker.com
  `/api/scmfarm/feed`, cached a day as `feed.json` in the app data folder).
- Feed contract: `{v:1, updated, sales:[{id, kind: sale|fest|nextfest, name, start, end, rewards[]}], sets:{appid:[cards, set_cents]}}`.
  Built by the site (crawl of the Steam market, `smweb/card_prices.py` there). A missing feed = no sale strip and
  the sets panel explains why.
- `watchForNews()` in app.js: "done" after the account farmed since start, "input" when Steam asks for a password
  or code outside the wizard.
- Sets panel: `cardsByGame()` + `nearSets()` in farm.js; inventory re-read at most every 30 min or by its reload button.

## Waking ASF after the user played (0.2.2)
- ASF 6.3.11.7 may sit idle for hours after the user plays on the same account (details in RESEARCH.md §4, "Pause
  while I play"). `wakeStep` in `farm.js` runs on every poll per bot: "had cards, was playing, now free and idle" ->
  after 2 min a non-permanent Pause + Resume (`kickFarming`), then every 15 min, at most 6 times. Status shows
  "scanning" meanwhile. Live check by the owner: play a game for a while during farming, quit, and see farming come
  back within ~3 minutes (or within ~1 h 15 min if the games were set aside for an hour).

## Achievements (0.3.0)
- `src-tauri/src/achievements.rs`: binary KeyValues + schema reader (unit tests, plus a test that parses every schema
  on this PC), the helper (`main.rs` dispatches `--achievements` before Tauri starts), commands `ach_steam`,
  `ach_games`, `ach_load`, `ach_apply`. vtable slots are SAM's `ISteamClient018` / `ISteamUserStats013` /
  `ISteamUser012`; x64 thiscall = the normal C ABI with `self` first.
- `ui/js/achievements.js`: the screen; `app.js` mode "ach", title-bar button `#btnAch`; `farm.js` `holdFarming`.
- Not verified live by Claude (it may not run the app against the owner's Steam): reading a real game, applying,
  the global percentages callback (1110), the pause/resume around the helper. Owner test: open a game you own,
  tick one locked achievement, apply, check the Steam profile; then untick and apply again.
- Later: showcasemaker.com's achievement-letters tool can hand a list of appid + ids; `ach_apply` already takes lists.

## Gotchas
- New shells may not have Rust on PATH: prepend `%USERPROFILE%\.cargo\bin`.
- `zip` crate is pinned to 2.x on purpose (API used in `engine.rs`).
- CSP blocks inline scripts/handlers: no `onerror=` etc. in HTML strings (see the global image error handler
  at the end of `app.js`).

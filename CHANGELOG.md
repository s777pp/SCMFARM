# Changelog

Format: newest first. Versions follow `package.json` / `tauri.conf.json` / `Cargo.toml` (kept equal by
`scripts/check-version.mjs`).

## 0.3.0 — 2026-11-05

### Added
- **Two tools, easy to find.** After an account is added a chooser asks "What would you like to do?" with two big
  cards: Card farming and Achievements (marked NEW). The title bar has a switch between the two at any time, and the
  next start opens the tool used last (`settings.tool`; `achSeen` hides the NEW mark). Texts in 8 languages.
- **Achievements screen**, the way Steam Achievement Manager does it
  (gibbed, zlib licence; code ported to Rust in `src-tauri/src/achievements.rs`, licence in `licenses/`, About →
  Licences, NOTICE, README). Left: the games whose achievement list Steam already keeps on this PC
  (`<Steam>/appcache/stats/UserGameStatsSchema_<appid>.bin`, only games run on this PC) plus every game the account
  owns, asked from ASF (`owns <bot> regex/.*`, the bot signed in as the same account as the Steam client; lines
  "… app/ID | Name" in any ASF language), a search and "open by appid". Right: the game's
  achievements with icon, name, description, global %, unlock date; tick / untick and apply all at once; hidden ones
  are marked, protected ones (set by the game's servers, `(permission & 3) != 0`) are locked. Filters all / locked /
  unlocked, search, "tick all locked", undo.
- How it talks to Steam: SCMFARM starts itself as a short-lived helper (`SCMFARM.exe --achievements <appid>
  read|apply`, `SteamAppId` set) that loads `steamclient64.dll` from the user's Steam folder (nothing from Steamworks
  is shipped), connects to the running Steam client, requests the user's stats, sets / clears / stores, prints one
  JSON line and exits. `apply` takes lists of ids on stdin, ready for the site's achievement-letters tool later.
- Steam sees that game as running while the helper works, which would kick ASF off its game, so the farming of the
  SCMFARM account that is signed in to the Steam client (registry `ActiveProcess\ActiveUser` vs the bot's SteamID)
  is paused for those seconds (non-permanent pause) and resumed after. If the Steam client has another account, a
  note says so.
- Before the first change: a warning in our own words (unlock times are public, some achievement-hunting groups do
  not count such accounts, Valve does not ban for it, no promises). Texts in all 8 languages; demo mock with two games.

## 0.2.2 — 2026-11-05

### Fixed
- **Farming did not come back after the user played a game** on the same account (seen in a real log: 7 games and
  28 cards left, ASF idle for hours). While the user plays, Steam logs ASF off every minute (LoggedInElsewhere); ASF's
  farming pass then marks the remaining games "cannot be played now" for an hour, ends with "nothing to farm", and
  when the account is free again `CardsFarmer.Resume(false)` skips the badge scan, so ASF waits for its
  `IdleFarmingPeriod` timer. SCMFARM now notices "was playing, had cards, now free and idle" and, after 2 minutes,
  pauses and resumes farming through IPC (that runs `Resume(true)`, which always scans), again every 15 minutes, at
  most 6 times. Meanwhile the account shows "looking for games with drops" instead of "done", and no false
  "farming finished" notification is sent. `wakeStep` / `kickFarming` in `ui/js/farm.js`.

## 0.2.1 — 2026-11-04

### Fixed
- **"Sets close to a badge" stayed empty** ("no cards in the inventory yet") while showcasemaker.com had no set prices
  yet: the panel only listed games the site's feed knew. Now every game with normal cards in the inventory is listed
  at once, and the app asks the Steam Community Market itself for each game's set size and price (`card_set` in
  `src-tauri/src/extras.rs`: 1-2 requests per game, one game every 3 s, at most 40 per inventory read, cached a day in
  `card_sets.json`; Steam asking to slow down stops it until the next read). Until a size is known the row says
  "N cards · finding the set size". The feed's prices are used for games not looked up yet.

## 0.2.0 — 2026-11-03

### Added
- **Several Steam accounts.** Each account is its own ASF bot (`main`, `acc2`, …). "Add account" (the `+` next to the
  avatars, or the account menu) runs the sign-in and "what to farm" steps for a new account; the same login cannot be
  added twice. Avatars in the title bar and tabs in the dashboard head switch the account; Settings edits the shown
  one; Log out removes only that account. One IPC request polls all bots. 0.1.x settings move into the new list by
  themselves, so nobody has to sign in again.
- **Notifications**: a Windows notification when an account has collected all its cards or Steam asks for a
  password or code (switch "Notify me"). Optional **Telegram** messages through the user's own bot: a short guide in the
  app, token check, "Connect" finds the chat after the user presses Start, "Send a test", "Turn off" deletes the token
  (`src-tauri/src/extras.rs`, `tauri-plugin-notification`).
- **Sets close to a badge** (dashboard, right column): normal cards from the account's Steam inventory
  (`GET /Api/Bot/<bot>/Inventory/753/6`) grouped per game, with set sizes and market prices from showcasemaker.com:
  have/need, what is missing and roughly what it costs; a full set opens the badge page to craft it, the others open
  the market filtered to that game's cards.
- **Steam sales on the dashboard**: a strip a month before a seasonal sale and while it runs, with what to collect.
- Switch **"Steam news from showcasemaker.com"**: at most one download a day of `/api/scmfarm/feed` (sale dates, set
  sizes and prices), the same file for everyone, cached in the app data folder.

### Changed
- Options step: two compact columns so the seven options still fit 1180 x 760 in all eight languages; the level card
  on the dashboard is smaller to make room for the sets panel.
- README Privacy lists the new optional connections (feed, Telegram). RESEARCH.md: the inventory endpoint and the
  `FarmingPreferences` flags of 6.3.11.7 (ASF no longer has `AutoSteamSaleEvent`).

### Not verified yet
- Real inventory JSON field names (the parser accepts snake_case and PascalCase), a real Windows toast from the
  portable exe, a real Telegram bot, a second real account.

## 0.1.1 — 2026-11-03

### Changed (SignPath Foundation requirements)
- **Switch "Update SCMFARM automatically"** in the Options step (on by default; all 8 languages): the update check is
  the app's only request to showcasemaker.com, the wizard explains it and it can be turned off. With it off the app
  reads its version locally. Options are laid out in two columns so the step still fits 1180 x 760.
- README "Code signing policy": the SignPath credit with links, roles named (@s777pp), review rule for pull requests,
  application status. Release notes now link the code signing policy and the privacy statement.
- showcasemaker.com/scmfarm shows "Code signing policy" and privacy links (site repo).

## 0.1.0 — 2026-11-03 (first public release, unsigned)

Released from CI: https://github.com/s777pp/SCMFARM/releases/tag/v0.1.0, mirrored at showcasemaker.com/download/scmfarm.

### Changed (distribution)
- **One portable `SCMFARM.exe`, no installer** (`bundle.active: false`). Licences are built into the exe
  (About → Licences writes and opens them), **About → Remove SCMFARM from this PC** uninstalls everything
  (engine, Steam token, settings, autostart, WebView profile, the exe itself).
- **Signed self-update** (`src-tauri/src/updater.rs`): at start the app asks showcasemaker.com
  (`/api/scmfarm/latest`); a newer version is downloaded, checked (SHA-256 + ed25519 signature over
  "SCMFARM <version> <sha256>"), swapped in and restarted. Release key: public half in the code, private half
  only in the GitHub secret `RELEASE_KEY`. Rust tests check the signature format against the CI script.
- CI builds the exe, runs the Rust tests, and on a `v*` tag publishes a GitHub release with `SCMFARM.exe` and
  `latest.json` (`scripts/sign-release.mjs`). The SignPath step is ready in the workflow, commented out until the
  project is accepted.

### Added (languages)
- **All eight languages of showcasemaker.com**: German, Turkish, French, Ukrainian, Spanish and Portuguese join
  English and Russian (`ui/js/locales/*.js`, 174 texts each, same placeholders; Steam's own names such as
  Steam Guard and Family View in each language). Ukrainian systems now get Ukrainian instead of Russian.
- Every wizard step and the dashboard checked in all eight at 1180 x 760: no scrollbar, nothing cut off
  (French step name shortened to "Le principe"; step 1 a few px tighter).

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
- **The program file is `SCMFARM.exe`** (`mainBinaryName`; was `showcase-farm.exe`). A new file name also stops
  Explorer from showing the old icon it had cached for the old file.
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
- **"About" button** (info icon + "About") at the left of the status bar; "Powered by ArchiSteamFarm" stays next to
  it as plain text (it used to be the hidden About button).
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

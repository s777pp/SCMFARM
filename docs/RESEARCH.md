# Stage 0 research: ArchiSteamFarm as a sidecar

Checked against ASF **6.3.11.7** (tag `6.3.11.7`, published 2026-10-25) — source code of that tag and the
official wiki (IPC, Configuration, FAQ, Remote-communication, Third-party pages), on 2026-11-03.
File/line references are to the ASF repository at that tag.

## 1. Which build to ship and how to update it

| Item | Value |
|---|---|
| Asset | `ASF-win-x64.zip` (20 510 469 bytes) — self-contained .NET, no runtime install needed |
| URL | `https://github.com/JustArchiNET/ArchiSteamFarm/releases/download/6.3.11.7/ASF-win-x64.zip` |
| SHA-512 | `95d8b91c944fd7c47e6dae71d89b65ee81cb219689fd67fe91da665297b7da32ee567c8ebb96b7b7a653b2ea43ed62e8d176b53d0f7e078309443802d2bd7167` (matches the release's `SHA512SUMS`, verified locally) |
| Zip contents | `ArchiSteamFarm.exe`, `LICENSE.txt`, `config/` (empty), `plugins/`, `www/` (ASF-ui), `logs/`, `*.html` docs |
| Other assets | `ASF-win-arm64.zip`, `ASF-generic.zip` (needs .NET runtime), linux/osx builds, `SHA512SUMS` + `SHA512SUMS.sign` |

**Decision for the prototype:** the app downloads the pinned zip on first run (keeps our installer small),
checks it against the pinned SHA-512 above, and unpacks it into `%APPDATA%\com.showcasemaker.farm\asf\`.
The pinned version/hash live in one place (`src-tauri/src/engine.rs`, `ASF_VERSION` / `ASF_SHA512`).

**Updates.** ASF can update itself (`UpdateChannel` 1 = Stable, `UpdatePeriod` hours, or `POST /Api/ASF/Update`);
it then checks the build checksum against `asf.justarchi.net` (Remote-communication wiki page). We switch
self-update **off** (`UpdateChannel: 0`, `UpdatePeriod: 0`) so the engine version is the one we tested with our UI.
We update ASF by shipping a new app version with a new pin (stage 3 auto-update), or — option for later —
by letting the app download a newer pinned zip. Keeping `config/` (bot `.json` + `.db` with the Steam refresh
token) between versions is enough to keep the user signed in.

## 2. IPC (local REST API)

* Enabled by `IPC: true` in `ASF.json` (default true). Kestrel listens on `127.0.0.1:1242` and `[::1]:1242`
  unless `config/IPC.config` says otherwise. We write `IPC.config` with **one** endpoint
  `http://127.0.0.1:<free random port>` so we never clash with a user's own ASF on 1242 and never listen on
  other interfaces.
* Auth: `IPCPassword` in `ASF.json`; every request sends header `Authentication: <password>`
  (`IPC/Integration/ApiAuthenticationMiddleware.cs:47`; a `?password=` query also works — we don't use it).
  We generate a random 32-byte password per install, keep it only in `ASF.json` and in memory.
* All responses are `GenericResponse { Success, Message, Result }`.
* Swagger is served by ASF itself at `/swagger` (useful during development).

Endpoints we use (from `IPC/Controllers/Api/*.cs`):

| What | Call | Notes |
|---|---|---|
| Engine alive / version | `GET /Api/ASF` | `Result.Version`, `Result.GlobalConfig`, … |
| Add/update a bot | `POST /Api/Bot/{name}` body `{ "BotConfig": { … } }` | writes `config/{name}.json`; ASF picks it up. Keeps an existing password if the request has none |
| Bot status | `GET /Api/Bot/{name}` | `Result[name]` = Bot (see below); `{a,b}` comma list = several bots in one call (0.2.0 polls all accounts this way) |
| Start / stop | `POST /Api/Bot/{name}/Start`, `/Stop` | |
| Pause / resume farming | `POST /Api/Bot/{name}/Pause` body `{ "Permanent": true, "ResumeInSeconds": 0 }`, `POST …/Resume` | |
| Submit password / codes | `POST /Api/Bot/{name}/Input` body `{ "Type": <EUserInputType>, "Value": "…" }` | see §3 |
| Delete bot | `DELETE /Api/Bot/{name}` | |
| Commands | `POST /Api/Command` body `{ "Command": "fqadd main 440,570" }` | farming queue `fq`/`fqadd`/`fqrm`, blacklist `fb`/`fbadd`/`fbrm` |
| Inventory | `GET /Api/Bot/{name}/Inventory/753/6` | `Result[name] = { Assets[], Descriptions[] }` (SteamKit `CEcon_Asset` / `CEconItem_Description`, `BotController.cs:289`). Trading cards: tags `item_class` = `item_class_2`, `cardborder` = `cardborder_0` (normal) / `_1` (foil), `Game` tag's `localized_tag_name` = game name, `market_fee_app` = the game's appid. Used by the "sets close to a badge" panel |
| Encrypt | `POST /Api/ASF/Encrypt` body `{ "CryptoMethod": 2, "StringToEncrypt": "…" }` | not needed, see §3 |
| Shut down | `POST /Api/ASF/Exit` | graceful stop before we kill the process |

Bot object fields we read: `BotName`, `KeepRunning`, `IsConnectedAndLoggedOn`, `RequiredInput`,
`Nickname`, `AvatarHash`, `SSteamID`, `IsPlayingPossible`, `HasMobileAuthenticator`,
`CardsFarmer { Paused, TimeRemaining ("d.hh:mm:ss"), CurrentGamesFarming[], GamesToFarm[] }`,
each game `{ AppID, GameName, CardsRemaining, HoursPlayed }`.
`TimeRemaining` is ASF's own estimate (≈30 min per card + hours needed to reach `HoursUntilCardDrops`).
`GamesToFarm` is filled once ASF has parsed the badge pages after login, i.e. after farming starts.

`EUserInputType` (`Core/ASF.cs:957`): 0 None, 1 Login, 2 Password, 3 SteamGuard (5-char e-mail code),
4 SteamParentalCode, 5 TwoFactorAuthentication (5-char code from the Steam mobile app), 6 Cryptkey,
7 DeviceConfirmation, 8 QrCodeLogin.

## 3. Sign-in, Steam Guard and where the password lives

How ASF behaves in **Headless** mode (`Headless: true`), which we use because there is no console:

* `Logging.GetUserInput` returns `null` in headless mode (`NLog/Logging.cs:84`). So whenever ASF needs
  something it sets `Bot.RequiredInput` and **stops the bot** (`Steam/Bot.cs` `RequestInput`,
  `InitLoginAndPassword`, `HandleLoginResult` for `AccountLogonDenied`/`InvalidLoginAuthCode` → SteamGuard,
  `AccountLoginDeniedNeedTwoFactor`/`TwoFactorCodeMismatch` → TwoFactorAuthentication).
* The app sees `RequiredInput != 0` and `KeepRunning == false` in `GET /Api/Bot/{name}`, asks the user,
  sends `POST …/Input`, then `POST …/Start`. `SetUserInput` (`Steam/Bot.cs:951`) keeps the value in
  memory: e-mail code → `AuthCode`, app code → `TwoFactorCode`, password → `BotConfig.SteamPassword`
  with `IsSteamPasswordSet = false` ("do not allow saving this account credential").
* Validation inside ASF: e-mail code must be 5 chars; 2FA code 5 chars (or backup code length).
* **"Approve in the Steam app" (device confirmation) and QR login are disabled in headless mode**
  (`BotCredentialsProvider.AcceptDeviceConfirmationAsync`, `Bot.WantsQrCodeLogin`). In headless mode the
  user types the 5-character code from the Steam Mobile app's Steam Guard screen instead. Getting the
  "tap Approve" flow would need non-headless ASF with its stdin piped to us — possible later, not needed now.
* **QR sign-in (implemented).** `Bot.WantsQrCodeLogin` returns false in headless mode, but in non-headless
  mode `RequestInput(QrCodeLogin)` first returns a value pre-set through `POST …/Input` `{Type: 8, Value: "Y"}`
  (`Steam/Bot.cs` `RequestInput`, `SetUserInput`). So for a QR sign-in the app restarts ASF with
  `Headless: false` (stdin is empty, so every other console prompt still returns nothing and the bot stops with
  `RequiredInput` set, same as headless), creates the bot disabled, sends Input 8 "Y", starts it, and renders
  `Bot.QrChallengeURL` (serialized, refreshed by ASF when Steam rotates the challenge) as a QR code. The user
  scans it in the Steam Mobile app; ASF checks the scanned account matches `SteamLogin` and saves the refresh
  token. The app then rewrites the bot config (enabled) and restarts ASF headless. No password involved.
* After the first successful login ASF stores a **refresh token** in `config/{name}.db`; later starts need
  neither the password nor a code until Steam invalidates the token.

**Password decision:** we never write the Steam password to disk. The bot config has `SteamLogin` only;
the password goes from the wizard straight to `POST /Api/Bot/main/Input` (Type 2) over 127.0.0.1 and lives
only in ASF's memory. If ASF ever needs it again (token expired) the dashboard asks for it.
Alternative supported by ASF if we ever want to store it: `PasswordFormat: 2` = `ProtectedDataForCurrentUser`
(Windows DPAPI, only this Windows user can decrypt; produce the value with `POST /Api/ASF/Encrypt`
`CryptoMethod 2`). Format 1 (AES) uses a key that is public unless `--cryptkey` is set, so it is not real
protection.

## 4. Config we write

`config/ASF.json` (global):

```json
{
  "Headless": true,
  "IPC": true,
  "IPCPassword": "<random>",
  "AutoRestart": false,
  "UpdateChannel": 0,
  "UpdatePeriod": 0,
  "SteamOwnerID": 0,
  "FilterBadBots": false
}
```

`config/IPC.config`: `{"Kestrel":{"Endpoints":{"HTTP4":{"Url":"http://127.0.0.1:<port>"}}}}`

`config/main.json` (via `POST /Api/Bot/main`):

```json
{
  "Enabled": true,
  "SteamLogin": "<login>",
  "RemoteCommunication": 0,
  "FarmingOrders": [ <EFarmingOrder> ],
  "FarmingPreferences": <flags>,
  "OnlineStatus": 1
}
```

* `RemoteCommunication: 0` — default is `All` (3): joins the ASF Steam group and may announce the bot in
  ASF's public listing. We turn both off; the wizard does not join any group for the user.
* `FarmingOrders` (`EFarmingOrder`): 0 Unordered, 3 CardDropsAscending (finish games fast),
  4 CardDropsDescending, 13 RedeemDateTimesDescending (newest purchases first), 9 Random, …
* `FarmingPreferences` flags: 1 FarmingPausedByDefault, 8 FarmPriorityQueueOnly (only games we put in
  the `fq` queue — used for "only the games I choose"), 16 SkipRefundableGames (on by default for us so
  farming never burns a game's 2-hour refund window), 32 SkipUnplayedGames.
  Full list in 6.3.11.7 `BotConfig.cs`: 0 None, 1, 2 ShutdownOnFarmingFinished, 4 SendOnFarmingFinished, 8, 16, 32,
  64 EnableRiskyCardsDiscovery, 256 AutoUnpackBoosterPacks. **128 AutoSteamSaleEvent is gone**: ASF no longer clears
  the sale discovery queue, so SCMFARM only reminds the user (sale strip on the dashboard).
* "Pause while I play": ASF already does this. When the user launches a game on the same account Steam
  takes the session away from ASF (`PlayingBlocked`, `IsPlayingPossible == false`) and ASF resumes when
  the user stops playing. The UI shows this state instead of inventing its own detection.
  **Except it often does not resume** (6.3.11.7 source, 2026-11-05): while Steam keeps logging ASF off, `Farm()`
  runs `IsPlayableGame` and games whose app data cannot be read get ignored for `HoursToIgnore` (1 h); the next badge
  scan then finds nothing, `ShouldResumeFarming = false`, and `CheckOccupationStatus` calls `CardsFarmer.Resume(false)`,
  which returns without `StartFarming` (no scan). Only the `IdleFarmingPeriod` timer, `OnNewGameAdded` or a user
  resume (`Actions.Resume` -> `Resume(true)`, only when `Paused`) scans again. SCMFARM's `wakeStep` does a
  non-permanent Pause + Resume after the account is free (see CHANGELOG 0.2.2).

## 5. Facts for the wizard texts

* Cards drop only from paid games that have trading cards; free/promo licences give none.
* A game drops roughly half its card set (rounded up); the rest come from trading/market/boosters.
  ASF reads the number of remaining drops from the user's badge pages.
* ASF's estimate: ~30 minutes per card, plus some playtime for games with < `HoursUntilCardDrops`
  (default 3) hours. One game at a time; several at once only for the hour-bumping phase.
* Steam level: crafting a badge gives 100 XP; levels 0–10 cost 100 XP each, 11–20 cost 200, and so on
  (+100 per 10 levels). Every 10 levels unlocks one more profile showcase slot (Steam rule).
  These numbers drive the "levels to the next showcase slot" widget; we do not claim a guaranteed level.

## 6. Licence and redistribution

* ASF is **Apache-2.0** (`LICENSE.txt` in the repo and in every release zip). There is **no `NOTICE` file**
  in the repo or the release, so Apache-2.0 §4(d) adds nothing beyond §4(a)–(c).
* What we must do when we redistribute ASF binaries: (a) ship a copy of the licence — we keep
  `LICENSE.txt` from the zip untouched next to the exe and also ship `licenses/ArchiSteamFarm-LICENSE.txt`
  in our app; (b) we do not modify ASF files, so no "changed files" notices are needed; (c) keep ASF's
  copyright/attribution — the About screen says "Powered by ArchiSteamFarm (Apache-2.0) by JustArchi"
  with a link to the repo. Trademark: Apache-2.0 §6 grants no trademark rights, so the app is called
  **SCMFARM**, never "ASF"; ASF is only mentioned as the engine.
* Wiki statements: the IPC page says the ASF API "can be used to make your own helper scripts, tools,
  GUIs and alike" and is officially supported. The FAQ says Apache-2.0 "allows other developers to further
  integrate ASF with their own projects" but that such projects are not reviewed/authorised by the ASF team
  and strongly advises users not to give account details to third-party **services**. Our design matches
  that: everything runs on the user's PC and credentials go only to the local ASF process and Steam.
  The Third-party wiki page lists community tools "for reference only" — we could ask to be listed later.
* ASF's FAQ also states that farming does not download games and works for all owned licences; it is the
  user's own account and own PC, which is the setup the FAQ describes as fine.

## 7. Remote communication ASF still does

Steam (required), GitHub API only for updates (off), `asf.justarchi.net` for update checksums (off with
updates), the bad-bots list (only used for trading; we set `FilterBadBots: false`) and the STM listing (off: we don't enable trading features). Our own app sends nothing
anywhere; no telemetry.

## 8. What could not be verified in this session

* Running the downloaded `ArchiSteamFarm.exe` was blocked by the session's permission rules, so the IPC
  calls above are verified from source only, not against a live process. The first run on the owner's PC
  should be watched with `/swagger` open.
* No real Steam account was used; the Steam Guard flow is implemented from the code paths above.

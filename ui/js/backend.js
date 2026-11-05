// Bridge to the Rust side. Inside the Tauri window it calls the commands from src-tauri/src/*.rs.
// Opened in a normal browser (npm run preview) it uses an in-memory mock of the engine, so the
// wizard and dashboard can be worked on without Rust, ASF or a Steam account.

const tauri = window.__TAURI__;
export const isDemo = !tauri;

function realBackend() {
  const invoke = tauri.core.invoke;
  return {
    engineInfo: () => invoke("engine_info"),
    async engineInstall(onProgress) {
      const unlisten = await tauri.event.listen("engine-progress", (e) => onProgress(e.payload));
      try {
        await invoke("engine_install");
      } finally {
        unlisten();
      }
    },
    engineStart: (keepAwake, interactive) => invoke("engine_start", { keepAwake: !!keepAwake, interactive: !!interactive }),
    engineStop: () => invoke("engine_stop"),
    asf: (method, path, body) => invoke("asf_request", { method, path, body: body ?? null }),
    logTail: (lines) => invoke("engine_log_tail", { lines }),
    settingsGet: () => invoke("settings_get"),
    settingsSet: (patch) => invoke("settings_set", { patch }),
    setAutostart: (enabled) => invoke("set_autostart", { enabled }),
    openExternal: (url) => invoke("open_external", { url }),
    updateCheck: () => invoke("update_check"),
    appVersion: () => tauri.app.getVersion(),
    async updateInstall(onProgress) {
      const unlisten = await tauri.event.listen("update-progress", (e) => onProgress(e.payload));
      try {
        await invoke("update_install"); // on success the app exits and restarts into the new version
      } finally {
        unlisten();
      }
    },
    openLicenses: () => invoke("open_licenses"),
    removeFromPc: (deleteExe) => invoke("remove_from_pc", { deleteExe: !!deleteExe }),
    notifyToast: (title, body) => invoke("notify_toast", { title, body }),
    telegramLink: (token) => invoke("telegram_link", { token }),
    telegramSend: (token, chatId, text) => invoke("telegram_send", { token, chatId, text }),
    feedGet: () => invoke("feed_get"),
    cardSet: (appid) => invoke("card_set", { appid }),
    freeGet: () => invoke("free_get"),
    linkTake: () => invoke("link_take"),
    onLink: (cb) => tauri.event.listen("scmfarm-link", (e) => cb(e.payload)),
    achSteam: () => invoke("ach_steam"),
    achGames: (lang) => invoke("ach_games", { lang }),
    achLoad: (appid, lang) => invoke("ach_load", { appid, lang }),
    achApply: (appid, set, clear, lang) => invoke("ach_apply", { appid, set, clear, lang }),
  };
}

// ---------------------------------------------------------------- demo mock
function mockBackend() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (Result = null) => ({ Success: true, Message: "OK", Result });
  const fail = (Message) => ({ Success: false, Message, Result: null });
  const params = new URLSearchParams(location.search);
  let installed = false;
  let running = false;
  let settings = {};
  const log = [];
  const newGames = () => [
    { AppID: 620, GameName: "Portal 2", CardsRemaining: 4, HoursPlayed: 3.4 },
    { AppID: 105600, GameName: "Terraria", CardsRemaining: 5, HoursPlayed: 12.1 },
    { AppID: 413150, GameName: "Stardew Valley", CardsRemaining: 3, HoursPlayed: 0.6 },
    { AppID: 367520, GameName: "Hollow Knight", CardsRemaining: 4, HoursPlayed: 2 },
    { AppID: 646570, GameName: "Slay the Spire", CardsRemaining: 2, HoursPlayed: 7.5 },
  ];
  // One entry per ASF bot (= Steam account): { bot, games, password, code, qrWanted, paused, pausedByDefault, queue, skipped }.
  const bots = new Map();

  function toFarm(m) {
    const queueOnly = m.bot.BotConfig.FarmingPreferences & 8; // FarmPriorityQueueOnly
    const left = m.games.filter((g) => g.CardsRemaining > 0 && !m.skipped.has(g.AppID) && (!queueOnly || m.queue.includes(g.AppID)));
    left.sort((a, b) => (m.queue.indexOf(b.AppID) >= 0) - (m.queue.indexOf(a.AppID) >= 0));
    return left;
  }
  function view(m) {
    const list = m.bot.IsConnectedAndLoggedOn ? toFarm(m) : [];
    const farming = m.bot.IsConnectedAndLoggedOn && !m.paused && list.length ? [list[0]] : [];
    const mins = list.reduce((s, g) => s + g.CardsRemaining * 30, 0);
    const span = `${Math.floor(mins / 1440)}.${String(Math.floor((mins % 1440) / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
    return { ...m.bot, CardsFarmer: { Paused: m.paused, TimeRemaining: span, CurrentGamesFarming: farming, GamesToFarm: list } };
  }
  // Slowly drop cards so the dashboard moves (?fast=1 finishes quickly, to see the "done" notification).
  setInterval(() => {
    for (const m of bots.values()) {
      const g = view(m).CardsFarmer.CurrentGamesFarming[0];
      if (g && (params.has("fast") || Math.random() < 0.25)) m.games.find((x) => x.AppID === g.AppID).CardsRemaining--;
    }
  }, params.has("fast") ? 700 : 4000);

  async function start(m) {
    const bot = m.bot;
    bot.KeepRunning = true;
    bot.RequiredInput = 0;
    await sleep(900);
    const signedIn = () => Object.assign(bot, { IsConnectedAndLoggedOn: true, SteamID: bots.size < 2 ? 76561198000000001 : 76561198000000000 + bots.size, Nickname: bot.BotConfig.SteamLogin === "demo" || bots.size < 2 ? "Demo farmer" : `Demo ${bot.BotConfig.SteamLogin}`, AvatarHash: null });
    if (m.qrWanted) {
      m.qrWanted = false;
      Object.assign(bot, { RequiredInput: 8, QrChallengeURL: "https://s.team/q/1/" + Date.now() });
      await sleep(7000); // "scanned" on the phone
      if (bot.RequiredInput === 8) Object.assign(bot, { RequiredInput: 0, QrChallengeURL: null }) && signedIn();
      m.paused = m.pausedByDefault;
    } else if (!m.password) {
      Object.assign(bot, { KeepRunning: false, RequiredInput: 2 });
    } else if (m.password === "wrong") {
      m.password = null;
      log.push(`2026-11-03 12:00:00|SCMFARM-1|WARN|${bot.BotName}|OnLoggedOn() InvalidPassword/InvalidPassword`);
      Object.assign(bot, { KeepRunning: false, RequiredInput: 0 });
    } else if (!m.code) {
      Object.assign(bot, { KeepRunning: false, RequiredInput: bot.BotConfig.SteamLogin.includes("app") ? 5 : 3 });
    } else {
      signedIn();
      m.paused = m.pausedByDefault;
    }
  }

  // Demo inventory: a few normal cards of some games (ASF returns SteamKit's assets + descriptions).
  function inventory() {
    const have = { 620: 7, 105600: 3, 413150: 5, 367520: 1, 646570: 6, 252950: 8 };
    const names = { 620: "Portal 2", 105600: "Terraria", 413150: "Stardew Valley", 367520: "Hollow Knight", 646570: "Slay the Spire", 252950: "Rocket League" };
    const assets = [], descriptions = [];
    for (const [app, n] of Object.entries(have)) {
      for (let i = 0; i < n; i++) {
        const classid = `${app}${i}`;
        assets.push({ appid: 753, contextid: 6, assetid: `${classid}9`, classid, instanceid: 0, amount: 1 + (i % 2) });
        descriptions.push({ appid: 753, classid, instanceid: 0, market_fee_app: Number(app), market_hash_name: `${app}-Card ${i}`,
          tags: [{ category: "item_class", internal_name: "item_class_2" }, { category: "cardborder", internal_name: "cardborder_0" }, { category: "Game", internal_name: `app_${app}`, localized_tag_name: names[app] }] });
      }
    }
    return { assets, descriptions };
  }

  const feed = {
    v: 1,
    updated: new Date().toISOString(),
    sales: [
      { id: "demo-sale", kind: "sale", name: "Steam Winter Sale", start: new Date(Date.now() + (params.has("sale") ? -2 : 9) * 864e5).toISOString().slice(0, 10), end: new Date(Date.now() + (params.has("sale") ? 5 : 23) * 864e5).toISOString().slice(0, 10), rewards: ["stickers", "badge"] },
      { id: "demo-fest", kind: "nextfest", name: "Steam Next Fest", start: "2027-02-22", end: "2027-03-01", rewards: [] },
    ],
    sets: { 620: [9, 412], 105600: [8, 96], 413150: [6, 133], 367520: [8, 310], 646570: [7, 98], 252950: [8, 230] },
  };

  return {
    async engineInfo() {
      return { installed, upToDate: installed, version: "6.3.11.7", running };
    },
    async engineInstall(onProgress) {
      const total = 20510469;
      for (let done = 0; done <= total; done += total / 12) {
        onProgress({ done: Math.min(done, total), total });
        await sleep(160);
      }
      installed = true;
    },
    async engineStart() {
      await sleep(700);
      running = true;
    },
    async engineStop() {
      running = false;
    },
    async asf(method, path, body) {
      if (!running) throw "engine_not_running";
      await sleep(120);
      if (path === "/Api/ASF") return ok({ Version: "6.3.11.7" });
      if (path === "/Api/Command") {
        const [cmd, name, ids] = body.Command.split(" ");
        const m = bots.get(name);
        const list = (ids || "").split(",").map(Number);
        if (m && cmd === "fqadd") m.queue.push(...list);
        if (m && cmd === "fbadd") list.forEach((id) => m.skipped.add(id));
        // like ASF in Russian: "<bot> Уже имеется: app/ID | Name", then a summary line
        if (m && cmd === "owns") return ok(`<${name}> Уже имеется: app/900001 | Demo Adventure
<${name}> Уже имеется: app/900003 | Demo Puzzle
<${name}> Уже имеется: app/620 | Portal 2
<${name}> Владеет 3 из 3.`);
        return ok("OK");
      }
      const inv = path.match(/^\/Api\/Bot\/(\w+)\/Inventory\/753\/6$/);
      if (inv) return ok({ [inv[1]]: inventory() });
      const p = path.match(/^\/Api\/Bot\/([\w,%]+)(?:\/(\w+))?$/);
      if (!p) return fail("unknown");
      const names = decodeURIComponent(p[1]).split(",");
      const action = p[2];
      if (!action && method === "GET") {
        return ok(Object.fromEntries(names.filter((n) => bots.has(n)).map((n) => [n, view(bots.get(n))])));
      }
      const name = names[0];
      let m = bots.get(name);
      if (!action && method === "POST") {
        const cfg = body.BotConfig;
        if (!m || m.bot.BotConfig.SteamLogin !== cfg.SteamLogin) {
          m = { games: newGames(), queue: [], skipped: new Set(), password: null, code: null, qrWanted: false, paused: false,
            bot: { BotName: name, KeepRunning: false, IsConnectedAndLoggedOn: false, RequiredInput: 0, IsPlayingPossible: true, BotConfig: cfg } };
          bots.set(name, m);
          m.pausedByDefault = !!(cfg.FarmingPreferences & 1);
          if (cfg.Enabled !== false) setTimeout(() => start(m), 300);
        } else {
          m.bot.BotConfig = cfg;
          m.pausedByDefault = !!(cfg.FarmingPreferences & 1);
          m.paused = m.pausedByDefault;
        }
        return ok({ [name]: true });
      }
      if (!action && method === "DELETE") {
        bots.delete(name);
        return ok({ [name]: true });
      }
      if (!m) return fail("Bot not found");
      if (action === "Input") {
        if (body.Type === 2) m.password = body.Value;
        if (body.Type === 8) m.qrWanted = body.Value === "Y";
        if (body.Type === 3 || body.Type === 5) {
          if (body.Value.length !== 5) return fail("invalid");
          m.code = body.Value;
        }
        m.bot.RequiredInput = 0;
        return ok();
      }
      if (action === "Start") start(m);
      if (action === "Stop") Object.assign(m.bot, { KeepRunning: false, IsConnectedAndLoggedOn: false, RequiredInput: 0, QrChallengeURL: null });
      if (action === "Pause") m.paused = true;
      if (action === "Resume") m.paused = false;
      return ok();
    },
    async logTail() {
      return log.slice(-40);
    },
    async settingsGet() {
      return { ...settings };
    },
    async settingsSet(patch) {
      settings = { ...settings, ...patch };
      return { ...settings };
    },
    async setAutostart() {},
    async openExternal(url) {
      window.open(url, "_blank", "noopener");
    },
    // ?update=1 in the preview URL shows the update screen (it "fails" at the end, the demo cannot restart).
    async appVersion() {
      return "0.2.1";
    },
    async updateCheck() {
      const demo = params.has("update");
      return { current: "0.2.1", latest: demo ? "0.3.0" : "0.2.1", available: demo };
    },
    async updateInstall(onProgress) {
      const total = 13000000;
      for (let done = 0; done <= total; done += total / 10) {
        onProgress({ done, total });
        await sleep(150);
      }
      throw "demo";
    },
    async openLicenses() {},
    async removeFromPc() {
      log.push("demo: remove from PC");
    },
    // Notifications go to the browser console in the demo; any token of the right shape "links" to chat 1.
    async notifyToast(title, body) {
      console.info("toast:", title, "—", body);
    },
    async telegramLink(token) {
      await sleep(500);
      if (!/^\d+:[\w-]{20,}$/.test(token.trim())) throw "bad_token";
      return 1;
    },
    async telegramSend(token, chatId, text) {
      console.info("telegram:", chatId, text);
    },
    // The demo answers from the demo feed's sets with no feed sizes (?nofeed=1 shows sizes arriving one by one).
    async cardSet(appid) {
      await sleep(400);
      const [cards, cents] = feed.sets[appid] || [7, 140];
      return { cards, cents, name: "" };
    },
    async feedGet() {
      return params.has("nofeed") ? null : feed;
    },
    // scmfarm:// links: ?letters=1 starts as if opened from the site with two games of letters.
    async linkTake() {
      return params.has("letters") ? "scmfarm://letters?w=HI&g=900001:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,900002:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : null;
    },
    onLink() {},
    // Free games: one free-to-keep DLC and one key giveaway (?nofree=1: nothing free right now).
    async freeGet() {
      if (params.has("nofree")) return { v: 1, updated: "", steam: [], keys: [] };
      return { v: 1, updated: new Date().toISOString(), steam: [
        { appid: 4693960, subid: 1782986, name: "Hunting Simulator 3 - Classic American Hunter Pack", kind: "dlc", worth: 499, image: "", url: "https://store.steampowered.com/app/4693960/" }],
        keys: [{ id: 3843, name: "Letter Quest: Grimm's Journey Remastered", kind: "game", worth: "$6.99", image: "", url: "https://www.gamerpower.com/", ends: "2026-11-09" }] };
    },
    // Achievements: two made-up games; ?nosteam=1 shows the "Steam is not running" state.
    async achSteam() {
      return { installed: true, user: params.has("nosteam") ? null : "76561198000000001" };
    },
    async achGames() {
      return [{ appid: 900001, name: "Demo Adventure", count: 6 }, { appid: 900002, name: "Demo Racer", count: 4 }];
    },
    async achLoad(appid) {
      await sleep(900);
      return { appid, game: appid === 900001 ? "Demo Adventure" : "Demo Racer", steamid: "76561198000000001", achievements: achDemo(appid) };
    },
    async achApply(appid, set, clear) {
      await sleep(1200);
      achDemo(appid).forEach((a) => {
        if (a.protected) return;
        if (set.includes(a.id)) Object.assign(a, { achieved: true, unlocked: Math.floor(Date.now() / 1000) });
        if (clear.includes(a.id)) Object.assign(a, { achieved: false, unlocked: 0 });
      });
      return { appid, game: "", steamid: "76561198000000001", stored: 1, achievements: achDemo(appid) };
    },
  };
}

const achStore = {};
function achDemo(appid) {
  const names = ["First steps", "Explorer", "Collector", "Night owl", "Speed run", "Secret room", "Champion"];
  return (achStore[appid] ||= names.slice(0, appid === 900001 ? 6 : 4).map((name, i) => ({
    id: `ACH_${i}`, name, desc: i === 5 ? "" : `Demo description of “${name}”.`, icon: "", iconGray: "",
    hidden: i === 5, protected: i === 3, achieved: i < 2, unlocked: i < 2 ? 1700000000 + i * 86400 : 0, percent: [71.2, 44.9, 12.3, 3.4, 0.8, 1.9, 25][i],
  })));
}

export const api = isDemo ? mockBackend() : realBackend();

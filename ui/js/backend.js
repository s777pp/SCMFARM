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
  };
}

// ---------------------------------------------------------------- demo mock
function mockBackend() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (Result = null) => ({ Success: true, Message: "OK", Result });
  const fail = (Message) => ({ Success: false, Message, Result: null });
  let installed = false;
  let running = false;
  let settings = {};
  const log = [];
  const games = [
    { AppID: 620, GameName: "Portal 2", CardsRemaining: 4, HoursPlayed: 3.4 },
    { AppID: 105600, GameName: "Terraria", CardsRemaining: 5, HoursPlayed: 12.1 },
    { AppID: 413150, GameName: "Stardew Valley", CardsRemaining: 3, HoursPlayed: 0.6 },
    { AppID: 367520, GameName: "Hollow Knight", CardsRemaining: 4, HoursPlayed: 2 },
    { AppID: 646570, GameName: "Slay the Spire", CardsRemaining: 2, HoursPlayed: 7.5 },
  ];
  let bot = null;
  let password = null;
  let code = null;
  let qrWanted = false;
  let paused = false;
  let pausedByDefault = false;
  const queue = [];
  const skipped = new Set();

  function toFarm() {
    const queueOnly = bot.BotConfig.FarmingPreferences & 8; // FarmPriorityQueueOnly
    const left = games.filter((g) => g.CardsRemaining > 0 && !skipped.has(g.AppID) && (!queueOnly || queue.includes(g.AppID)));
    left.sort((a, b) => (queue.indexOf(b.AppID) >= 0) - (queue.indexOf(a.AppID) >= 0));
    return left;
  }
  function view() {
    if (!bot) return null;
    const list = bot.IsConnectedAndLoggedOn ? toFarm() : [];
    const farming = bot.IsConnectedAndLoggedOn && !paused && list.length ? [list[0]] : [];
    const mins = list.reduce((s, g) => s + g.CardsRemaining * 30, 0);
    const span = `${Math.floor(mins / 1440)}.${String(Math.floor((mins % 1440) / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
    return {
      ...bot,
      CardsFarmer: { Paused: paused, TimeRemaining: span, CurrentGamesFarming: farming, GamesToFarm: list },
    };
  }
  // Slowly drop cards so the dashboard moves.
  setInterval(() => {
    const v = view();
    const g = v && v.CardsFarmer.CurrentGamesFarming[0];
    if (g && Math.random() < 0.25) games.find((x) => x.AppID === g.AppID).CardsRemaining--;
  }, 4000);

  async function start() {
    bot.KeepRunning = true;
    bot.RequiredInput = 0;
    await sleep(900);
    if (qrWanted) {
      qrWanted = false;
      Object.assign(bot, { RequiredInput: 8, QrChallengeURL: "https://s.team/q/1/" + Date.now() });
      await sleep(7000); // "scanned" on the phone
      if (bot.RequiredInput === 8) Object.assign(bot, { RequiredInput: 0, QrChallengeURL: null, IsConnectedAndLoggedOn: true, Nickname: "Demo farmer" });
      paused = pausedByDefault;
    } else if (!password) {
      Object.assign(bot, { KeepRunning: false, RequiredInput: 2 });
    } else if (password === "wrong") {
      password = null;
      log.push("Unable to log in to Steam: InvalidPassword/InvalidPassword");
      Object.assign(bot, { KeepRunning: false, RequiredInput: 0 });
    } else if (!code) {
      Object.assign(bot, { KeepRunning: false, RequiredInput: bot.BotConfig.SteamLogin.includes("app") ? 5 : 3 });
    } else {
      Object.assign(bot, { IsConnectedAndLoggedOn: true, Nickname: "Demo farmer", AvatarHash: null });
      paused = pausedByDefault;
    }
  }

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
      const m = path.match(/^\/Api\/Bot\/(\w+)(?:\/(\w+))?$/);
      if (path === "/Api/ASF") return ok({ Version: "6.3.11.7" });
      if (path === "/Api/Command") {
        const [cmd, , ids] = body.Command.split(" ");
        const list = (ids || "").split(",").map(Number);
        if (cmd === "fqadd") queue.push(...list);
        if (cmd === "fbadd") list.forEach((id) => skipped.add(id));
        return ok("OK");
      }
      if (!m) return fail("unknown");
      const [, , action] = m;
      if (!action && method === "POST") {
        const cfg = body.BotConfig;
        pausedByDefault = !!(cfg.FarmingPreferences & 1);
        if (!bot || bot.BotConfig.SteamLogin !== cfg.SteamLogin) {
          bot = { BotName: "main", KeepRunning: false, IsConnectedAndLoggedOn: false, RequiredInput: 0, IsPlayingPossible: true, BotConfig: cfg };
          password = code = null;
          setTimeout(start, 300);
        } else {
          bot.BotConfig = cfg;
          paused = pausedByDefault;
        }
        return ok({ main: true });
      }
      if (!action && method === "DELETE") {
        bot = null;
        password = code = null;
        return ok({ main: true });
      }
      if (!action) return ok(bot ? { main: view() } : {});
      if (!bot) return fail("Bot not found");
      if (action === "Input") {
        if (body.Type === 2) password = body.Value;
        if (body.Type === 8) qrWanted = body.Value === "Y";
        if (body.Type === 3 || body.Type === 5) {
          if (body.Value.length !== 5) return fail("invalid");
          code = body.Value;
        }
        bot.RequiredInput = 0;
        return ok();
      }
      if (action === "Start") start();
      if (action === "Stop") Object.assign(bot, { KeepRunning: false, IsConnectedAndLoggedOn: false, RequiredInput: 0, QrChallengeURL: null });
      if (action === "Pause") paused = true;
      if (action === "Resume") paused = false;
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
  };
}

export const api = isDemo ? mockBackend() : realBackend();

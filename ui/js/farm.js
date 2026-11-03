// Everything that knows about ASF: bot config, the sign-in state machine, status and math helpers.
// Numbers and enums are documented in docs/RESEARCH.md.
import { api } from "./backend.js";

export const FIRST_BOT = "main"; // the first account's bot (0.1.x had only this one)
export const INPUT = { None: 0, Login: 1, Password: 2, SteamGuard: 3, Parental: 4, TwoFactor: 5, QrCodeLogin: 8 };
// EFarmingOrder values
export const ORDERS = { fast: 3, most: 4, new: 13, any: 0 };
// EFarmingPreferences flags
const PREF = { PausedByDefault: 1, PriorityQueueOnly: 8, SkipRefundable: 16 };

export function botConfig(s, { paused = false } = {}) {
  let prefs = 0;
  if (paused) prefs |= PREF.PausedByDefault;
  if (s.farmMode === "chosen") prefs |= PREF.PriorityQueueOnly;
  if (s.skipRefundable !== false) prefs |= PREF.SkipRefundable;
  const order = ORDERS[s.order ?? "fast"];
  return {
    Enabled: true,
    SteamLogin: s.login,
    RemoteCommunication: 0, // don't join ASF's Steam group, no public listing
    FarmingOrders: order ? [order] : [],
    FarmingPreferences: prefs,
    OnlineStatus: 1,
  };
}

export async function asf(method, path, body) {
  const res = await api.asf(method, path, body);
  if (!res || !res.Success) throw new Error(res?.Message || "asf_error");
  return res.Result;
}

export async function getBot(bot) {
  return (await getBots([bot]))[bot] ?? null;
}

/** One request for several bots: { name: bot }; bots ASF doesn't know are left out. */
export async function getBots(names) {
  if (!names.length) return {};
  try {
    return (await asf("GET", `/Api/Bot/${names.map(encodeURIComponent).join(",")}`)) || {};
  } catch {
    return {};
  }
}

// One ASF bot per Steam account; every helper takes the bot name.
const quiet = (p) => p.catch(() => null); // e.g. "already running" when ASF started the bot itself
export const saveBot = (bot, cfg) => asf("POST", `/Api/Bot/${bot}`, { BotConfig: cfg });
export const sendInput = (bot, type, value) => asf("POST", `/Api/Bot/${bot}/Input`, { Type: type, Value: value });
export const startBot = (bot) => quiet(asf("POST", `/Api/Bot/${bot}/Start`));
export const stopBot = (bot) => quiet(asf("POST", `/Api/Bot/${bot}/Stop`));
// ASF deletes the bot's config and database, so the Steam sign-in token leaves this PC with it.
export const deleteBot = (bot) => quiet(asf("DELETE", `/Api/Bot/${bot}`));
export const pauseFarming = (bot) => quiet(asf("POST", `/Api/Bot/${bot}/Pause`, { Permanent: true, ResumeInSeconds: 0 }));
export const resumeFarming = (bot) => quiet(asf("POST", `/Api/Bot/${bot}/Resume`));
export const command = (text) => asf("POST", "/Api/Command", { Command: text });
export const farmNext = (bot, appId) => command(`fqadd ${bot} ${appId}`);
export const skipGame = (bot, appId) => command(`fbadd ${bot} ${appId}`);
export const queueGames = (bot, ids) => (ids.length ? command(`fqadd ${bot} ${ids.join(",")}`) : null);

// ------------------------------------------------------------------ card sets
// ASF serialises SteamKit's protobuf classes; read a field whatever its casing.
const field = (o, k) => o?.[k] ?? o?.[k.replace(/(^|_)(\w)/g, (_, _u, c) => c.toUpperCase())];

/** Normal (not foil) trading cards in the bot's Steam inventory, per game: { appid: { name, classes: { classid: amount } } }. */
export async function cardsByGame(bot) {
  const inv = (await asf("GET", `/Api/Bot/${bot}/Inventory/753/6`))?.[bot] || {};
  const games = new Map(); // classid -> [appid, game name]
  for (const d of field(inv, "descriptions") || []) {
    const tags = field(d, "tags") || [];
    const tag = (cat) => field(tags.find((x) => field(x, "category") === cat), "internal_name");
    if (tag("item_class") !== "item_class_2" || tag("cardborder") !== "cardborder_0") continue;
    const app = Number(field(d, "market_fee_app")) || Number(String(field(d, "market_hash_name") || "").split("-")[0]);
    const game = tags.find((x) => field(x, "category") === "Game");
    if (app) games.set(String(field(d, "classid")), [app, field(game, "localized_tag_name") || ""]);
  }
  const out = {};
  for (const a of field(inv, "assets") || []) {
    const cls = String(field(a, "classid"));
    const [app, name] = games.get(cls) || [];
    if (!app) continue;
    const per = (out[app] ||= { name, classes: {} });
    per.classes[cls] = (per.classes[cls] || 0) + (Number(field(a, "amount")) || 1);
  }
  return out;
}

/**
 * Sets the account is closest to finishing: [{ appid, name, have, size, missing, price, full }]. `sets` is
 * { appid: [cards in set, whole set price in USD cents] } (the app's own market lookups, else the showcasemaker.com
 * feed); price = the missing cards. Games whose set size is not known yet come last with size 0, so every game with
 * cards in the inventory shows up.
 */
export function nearSets(byGame, sets, limit = 30) {
  const rows = [];
  for (const [appid, { name, classes }] of Object.entries(byGame || {})) {
    const [size, setPrice] = sets?.[appid] || [];
    const owned = Object.keys(classes).length;
    if (!size) {
      rows.push({ appid: Number(appid), name, have: owned, size: 0, missing: Infinity, price: 0, full: false });
      continue;
    }
    const have = Math.min(size, owned);
    const missing = size - have;
    rows.push({ appid: Number(appid), name, have, size, missing, price: Math.round(((setPrice || 0) / size) * missing), full: !missing });
  }
  rows.sort((a, b) => a.missing - b.missing || a.price - b.price || b.have - a.have);
  return rows.slice(0, limit);
}

/** App IDs from store links ("/app/620/") or bare numbers. */
export function parseAppIds(text) {
  const ids = new Set();
  for (const part of String(text || "").split(/[\s,;]+/)) {
    const m = part.match(/\/app\/(\d+)/) || part.match(/^(\d{1,9})$/);
    if (m) ids.add(Number(m[1]));
  }
  return [...ids];
}

/** .NET TimeSpan "d.hh:mm:ss" / "hh:mm:ss" → minutes. */
export function spanMinutes(s) {
  const m = String(s || "").match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 24 + Number(m[2])) * 60 + Number(m[3]);
}

// Steam: levels 1-10 cost 100 XP each, 11-20 cost 200, … A badge gives 100 XP; a showcase slot every 10 levels.
export function xpForLevel(level) {
  let xp = 0;
  for (let l = 1; l <= level; l++) xp += 100 * Math.ceil(l / 10);
  return xp;
}

export function nextSlot(level) {
  const lv = Math.max(0, Math.min(5000, Math.floor(Number(level) || 0)));
  const next = (Math.floor(lv / 10) + 1) * 10;
  const xp = xpForLevel(next) - xpForLevel(lv);
  return { level: lv, next, xp, badges: Math.ceil(xp / 100), progress: (lv % 10) / 10 };
}

// ------------------------------------------------------------------ status
export function botStatus(b, { loggedOnSince } = {}) {
  if (!b) return "stopped";
  if (b.RequiredInput) return "input";
  if (!b.KeepRunning) return "stopped";
  if (!b.IsConnectedAndLoggedOn) return "connecting";
  const cf = b.CardsFarmer || {};
  if (!b.IsPlayingPossible) return "playing";
  if (cf.Paused) return "paused";
  if (cf.CurrentGamesFarming?.length) return "farming";
  if (cf.GamesToFarm?.length) return "farming";
  // Right after login ASF still reads the badge pages.
  if (loggedOnSince && Date.now() - loggedOnSince < 3 * 60 * 1000) return "scanning";
  return "done";
}

// ------------------------------------------------------------------ log reasons
async function logLines() {
  try {
    return await api.logTail(80);
  } catch {
    return [];
  }
}

/** Remembers where the log ends so later reads only look at new lines. */
export async function markLog() {
  const lines = await logLines();
  return lines[lines.length - 1] ?? "";
}

// ASF log lines look like "date|process|LEVEL|<bot>|message": with several accounts only this bot's lines count.
export async function failureSince(mark, bot) {
  const lines = await logLines();
  const from = mark ? lines.lastIndexOf(mark) + 1 : 0;
  const fresh = lines.slice(from).filter((l) => !bot || l.includes(`|${bot}|`)).join("\n");
  if (/InvalidPassword/.test(fresh)) return "password";
  if (/RateLimitExceeded|AccountLoginDeniedThrottle|AccountLogonDeniedVerifiedEmailRequired/.test(fresh)) return "rate";
  if (/TwoFactorCodeMismatch|InvalidLoginAuthCode/.test(fresh)) return "code";
  return null;
}

// ------------------------------------------------------------------ sign-in
/**
 * Drives one sign-in: creates the bot (farming paused while the wizard runs), feeds the password and
 * Steam Guard codes to ASF through IPC when it asks for them (RequiredInput), reports states to `onState`:
 * connecting | email | app | parental | password | qr (with `url`) | ok | error (with `reason`).
 *
 * QR sign-in: ASF only offers it when not in Headless mode, so `hooks.toInteractive()` restarts the engine
 * non-headless for the sign-in and `hooks.toHeadless()` switches back once Steam has issued the login token.
 */
export class SignIn {
  constructor(onState, hooks) {
    this.onState = onState;
    this.hooks = hooks;
    this.timer = null;
    this.password = null;
  }

  emit(kind, extra = {}) {
    const key = kind + (extra.reason || "") + (extra.url || "");
    if (key === this.lastKey && kind !== "ok") return;
    this.lastKey = key;
    this.onState({ kind, ...extra });
  }

  async begin(settings, password) {
    this.bot = settings.bot;
    this.cancel();
    this.qr = false;
    this.password = password;
    this.passwordSent = false;
    this.codeSent = false;
    this.kicked = false;
    this.startedAt = Date.now();
    this.lastKey = null;
    this.emit("connecting");
    await this.hooks.toHeadless();
    this.mark = await markLog();
    await saveBot(this.bot, botConfig(settings, { paused: true }));
    this.loop();
  }

  async beginQr(settings) {
    this.bot = settings.bot;
    this.cancel();
    this.settings = settings;
    this.qr = true;
    this.qrShown = false;
    this.qrTries = 0;
    this.password = null;
    this.startedAt = Date.now();
    this.lastKey = null;
    this.emit("connecting");
    await this.hooks.toInteractive();
    this.mark = await markLog();
    // Disabled so ASF doesn't start it on its own before it knows we want the QR code.
    await saveBot(this.bot, { ...botConfig(settings, { paused: true }), Enabled: false });
    for (let i = 0; i < 20 && !(await getBot(this.bot)); i++) await new Promise((r) => setTimeout(r, 500));
    await this.askQr();
    this.loop();
  }

  async askQr() {
    this.qrTries++;
    await sendInput(this.bot, INPUT.QrCodeLogin, "Y");
    await startBot(this.bot);
  }

  async cancelQr() {
    this.cancel();
    this.qr = false;
    await stopBot(this.bot);
    await this.hooks.toHeadless();
  }

  async qrTick(b) {
    if (b.IsConnectedAndLoggedOn) {
      // Token saved; go back to headless with the normal (enabled) config and let the usual flow confirm it.
      this.qr = false;
      this.emit("connecting");
      await saveBot(this.bot, botConfig(this.settings, { paused: true }));
      await this.hooks.toHeadless();
      this.startedAt = Date.now();
      this.kicked = false;
      return false;
    }
    if (b.RequiredInput === INPUT.QrCodeLogin && b.QrChallengeURL) {
      this.qrShown = true;
      this.emit("qr", { url: b.QrChallengeURL });
      return false;
    }
    if (!b.KeepRunning) {
      if (!this.qrShown && this.qrTries < 3) await this.askQr();
      else {
        await this.cancelQr();
        this.emit("error", { reason: "qr" });
        return true;
      }
    }
    return false;
  }

  loop() {
    this.timer = setTimeout(async () => {
      try {
        if (await this.tick()) return;
      } catch (e) {
        console.warn(e);
      }
      if (this.timer) this.loop();
    }, 1200);
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  async fail(reason) {
    this.cancel();
    this.password = null;
    await stopBot(this.bot); // don't let ASF keep retrying a wrong password: Steam rate-limits that
    this.emit("error", { reason });
  }

  /** Returns true when finished. */
  async tick() {
    const b = await getBot(this.bot);
    if (!b) {
      if (Date.now() - this.startedAt > 30000) await this.fail("generic");
      return !this.timer;
    }
    if (this.qr) return this.qrTick(b);
    if (b.IsConnectedAndLoggedOn) {
      this.cancel();
      this.password = null;
      this.emit("ok", { bot: b });
      return true;
    }
    const reason = await failureSince(this.mark, this.bot);
    if (reason === "password" || reason === "rate") {
      await this.fail(reason);
      return true;
    }
    switch (b.RequiredInput) {
      case INPUT.Password:
        if (this.password && !this.passwordSent) {
          this.passwordSent = true;
          await sendInput(this.bot, INPUT.Password, this.password);
          await startBot(this.bot);
          this.emit("connecting");
        } else if (!this.password) {
          this.emit("password");
        }
        return false;
      case INPUT.SteamGuard:
        this.emit("email", { reason: this.codeSent ? "code" : "" });
        return false;
      case INPUT.TwoFactor:
        this.emit("app", { reason: this.codeSent ? "code" : "" });
        return false;
      case INPUT.Parental:
        this.emit("parental");
        return false;
      case INPUT.Login:
        await this.fail("generic");
        return true;
    }
    if (!b.KeepRunning) {
      if (!this.kicked) {
        this.kicked = true;
        await startBot(this.bot);
      } else if (Date.now() - this.startedAt > 45000) {
        await this.fail(reason || "generic");
        return true;
      }
    }
    this.emit("connecting");
    return false;
  }

  async submitCode(type, value) {
    this.codeSent = true;
    this.mark = await markLog();
    await sendInput(this.bot, type, value.trim());
    await startBot(this.bot);
    this.startedAt = Date.now();
    this.lastKey = null;
    this.emit("connecting");
    if (!this.timer) this.loop();
  }

  async submitPassword(password) {
    this.password = password;
    this.passwordSent = false;
    this.kicked = false;
    this.startedAt = Date.now();
    this.mark = await markLog();
    this.lastKey = null;
    this.emit("connecting");
    if (!this.timer) this.loop();
  }
}

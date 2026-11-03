// Everything that knows about ASF: bot config, the sign-in state machine, status and math helpers.
// Numbers and enums are documented in docs/RESEARCH.md.
import { api } from "./backend.js";

export const BOT = "main";
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

export async function getBot() {
  try {
    const r = await asf("GET", `/Api/Bot/${BOT}`);
    return r?.[BOT] ?? null;
  } catch {
    return null;
  }
}

const quiet = (p) => p.catch(() => null); // e.g. "already running" when ASF started the bot itself
export const saveBot = (cfg) => asf("POST", `/Api/Bot/${BOT}`, { BotConfig: cfg });
export const sendInput = (type, value) => asf("POST", `/Api/Bot/${BOT}/Input`, { Type: type, Value: value });
export const startBot = () => quiet(asf("POST", `/Api/Bot/${BOT}/Start`));
export const stopBot = () => quiet(asf("POST", `/Api/Bot/${BOT}/Stop`));
export const pauseFarming = () => quiet(asf("POST", `/Api/Bot/${BOT}/Pause`, { Permanent: true, ResumeInSeconds: 0 }));
export const resumeFarming = () => quiet(asf("POST", `/Api/Bot/${BOT}/Resume`));
export const command = (text) => asf("POST", "/Api/Command", { Command: text });
export const farmNext = (appId) => command(`fqadd ${BOT} ${appId}`);
export const skipGame = (appId) => command(`fbadd ${BOT} ${appId}`);
export const queueGames = (ids) => (ids.length ? command(`fqadd ${BOT} ${ids.join(",")}`) : null);

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

export async function failureSince(mark) {
  const lines = await logLines();
  const from = mark ? lines.lastIndexOf(mark) + 1 : 0;
  const fresh = lines.slice(from).join("\n");
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
    await saveBot(botConfig(settings, { paused: true }));
    this.loop();
  }

  async beginQr(settings) {
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
    await saveBot({ ...botConfig(settings, { paused: true }), Enabled: false });
    for (let i = 0; i < 20 && !(await getBot()); i++) await new Promise((r) => setTimeout(r, 500));
    await this.askQr();
    this.loop();
  }

  async askQr() {
    this.qrTries++;
    await sendInput(INPUT.QrCodeLogin, "Y");
    await startBot();
  }

  async cancelQr() {
    this.cancel();
    this.qr = false;
    await stopBot();
    await this.hooks.toHeadless();
  }

  async qrTick(b) {
    if (b.IsConnectedAndLoggedOn) {
      // Token saved; go back to headless with the normal (enabled) config and let the usual flow confirm it.
      this.qr = false;
      this.emit("connecting");
      await saveBot(botConfig(this.settings, { paused: true }));
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
    await stopBot(); // don't let ASF keep retrying a wrong password: Steam rate-limits that
    this.emit("error", { reason });
  }

  /** Returns true when finished. */
  async tick() {
    const b = await getBot();
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
    const reason = await failureSince(this.mark);
    if (reason === "password" || reason === "rate") {
      await this.fail(reason);
      return true;
    }
    switch (b.RequiredInput) {
      case INPUT.Password:
        if (this.password && !this.passwordSent) {
          this.passwordSent = true;
          await sendInput(INPUT.Password, this.password);
          await startBot();
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
        await startBot();
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
    await sendInput(type, value.trim());
    await startBot();
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

import { api, isDemo } from "./backend.js";
import { LANGS, applyI18n, detectLang, getLang, setLang, t } from "./i18n.js";
import {
  FIRST_BOT, INPUT, SignIn, botConfig, botStatus, cardsByGame, deleteBot, farmNext, getBot, getBots, nearSets, nextSlot,
  parseAppIds, pauseFarming, queueGames, resumeFarming, saveBot, sendInput, skipGame, spanMinutes, startBot, stopBot,
} from "./farm.js";

const SITE = "https://showcasemaker.com";
const STEPS = ["intro", "signin", "what", "options", "start"];
const SETS_EVERY = 30 * 60 * 1000; // re-read the Steam inventory for the sets panel at most this often
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const capsule = (id) => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${Number(id)}/header.jpg`;
const avatarUrl = (hash) => (hash ? `https://avatars.akamai.steamstatic.com/${encodeURIComponent(hash)}_full.jpg` : "img/logo.png");

const state = {
  settings: {},
  mode: "wizard",
  step: 0,
  maxStep: 0,
  engine: { phase: "checking", pct: 0, err: null },
  engineAwake: null, // keepAwake value the running engine was started with
  signin: { kind: "form" },
  draft: null, // the account the wizard is setting up or editing (saved to settings.accounts by "Start farming")
  bots: {}, // ASF bot name -> last bot object from ASF
  loggedOnSince: {}, // bot -> ms
  seen: {}, // bot -> { status, input } from the previous poll, for notifications
  cards: {}, // bot -> { at, games, err } (inventory for the sets panel)
  feed: null, // showcasemaker.com feed: sales + set sizes/prices (null when off or offline)
  dashInputError: null,
  accountOpen: null, // bot whose account menu is open
};

// ------------------------------------------------------------------ settings
async function saveSettings(patch) {
  state.settings = await api.settingsSet(patch);
}
const S = () => state.settings;

// ------------------------------------------------------------------ accounts
// Several Steam accounts = several ASF bots. settings.accounts holds one entry per account:
// { bot, login, name, avatar, level, farmMode, order, chosenText, skipRefundable }; settings.current is the one the
// dashboard shows. App-wide options (keepAwake, autostart, tray, updates, feed, notifications) stay top-level.
const accountsList = () => S().accounts || [];
const accountOf = (bot) => accountsList().find((a) => a.bot === bot) || (state.draft?.bot === bot ? state.draft : null);
const cur = () => accountsList().find((a) => a.bot === S().current) || accountsList()[0] || null;
const D = () => state.draft || {}; // the account the wizard works on
const botOf = (bot) => state.bots[bot] ?? null;
const nameOf = (bot) => botOf(bot)?.Nickname || accountOf(bot)?.name || accountOf(bot)?.login || "";

function newAccount() {
  const used = new Set(accountsList().map((a) => a.bot));
  let bot = FIRST_BOT;
  for (let n = 2; used.has(bot); n++) bot = `acc${n}`;
  return { bot, login: "", farmMode: "all", order: "fast", chosenText: "", skipRefundable: true, level: 0 };
}

async function saveAccount(bot, patch) {
  if (state.draft?.bot === bot) Object.assign(state.draft, patch);
  if (!accountsList().some((a) => a.bot === bot)) return;
  await saveSettings({ accounts: accountsList().map((a) => (a.bot === bot ? { ...a, ...patch } : a)) });
}

/** 0.1.x kept one account in flat keys (login, account, farmMode, …); move it into the list as bot "main". */
async function migrateSettings() {
  const s = S();
  if (s.accounts || !s.login) return;
  const acc = { bot: FIRST_BOT, login: s.login, name: s.account?.name || "", avatar: s.account?.avatar || null, level: s.level || 0,
    farmMode: s.farmMode || "all", order: s.order || "fast", chosenText: s.chosenText || "", skipRefundable: s.skipRefundable !== false };
  await saveSettings({ accounts: s.wizardDone ? [acc] : [], current: FIRST_BOT, login: null, account: null, farmMode: null, order: null, chosenText: null, skipRefundable: null });
  if (!s.wizardDone) state.draft = acc;
}

// ------------------------------------------------------------------ engine
let engineBoot = null;
function bootEngine() {
  engineBoot ??= (async () => {
    try {
      setEngine("checking");
      const info = await api.engineInfo();
      if (!info.installed || !info.upToDate) {
        setEngine("downloading", 0);
        await api.engineInstall(({ done, total }) => setEngine("downloading", total ? Math.round((done / total) * 100) : 0));
      }
      if (!info.running) {
        setEngine("starting");
        await api.engineStart(!!S().keepAwake);
      }
      state.engineAwake = !!S().keepAwake;
      setEngine("ready");
    } catch (e) {
      engineBoot = null;
      setEngine("error", 0, String(e?.message || e));
      throw e;
    }
  })();
  return engineBoot;
}

// engine_start restarts the engine when the requested mode differs from the running one.
async function engineMode(interactive) {
  await bootEngine();
  setEngine("starting");
  try {
    await api.engineStart(!!S().keepAwake, interactive);
    state.engineAwake = !!S().keepAwake;
    setEngine("ready");
  } catch (e) {
    setEngine("error", 0, String(e?.message || e));
    throw e;
  }
}

async function restartEngineIfNeeded() {
  if (state.engineAwake === !!S().keepAwake) return;
  await engineMode(false);
}

function setEngine(phase, pct = 0, err = null) {
  state.engine = { phase, pct, err };
  renderEngineChip();
  if (state.mode === "wizard" && STEPS[state.step] === "signin") renderStep();
}

function renderEngineChip() {
  const chip = $("#engineChip");
  const { phase, pct, err } = state.engine;
  const tone = { ready: "good", error: "bad" }[phase] || "busy";
  chip.dataset.tone = tone;
  let text = t(`engine.${phase === "error" ? "failed" : phase}`, { pct });
  chip.innerHTML = `<i></i><span>${esc(text)}</span>`;
  if (phase === "error") {
    chip.title = t(`engine.err_${err}`) !== `engine.err_${err}` ? t(`engine.err_${err}`) : err;
    chip.insertAdjacentHTML("beforeend", `<button class="link" data-action="engine-retry">${esc(t("engine.retry"))}</button>`);
  } else {
    chip.title = "";
  }
}

// ------------------------------------------------------------------ chrome
function renderChrome() {
  applyI18n();
  const ready = LANGS.filter((l) => l.ready);
  $("#lang .lang__name").textContent = (ready.find((l) => l.code === getLang()) || ready[0]).name;
  $("#lang .lang__menu").innerHTML = ready
    .map((l) => `<li><button type="button" role="option" data-lang="${l.code}" aria-selected="${l.code === getLang()}"><span>${esc(l.name)}</span><small>${l.code.toUpperCase()}</small></button></li>`)
    .join("");
  $("#demoBadge").hidden = !isDemo;
  $("#btnSettings").hidden = state.mode !== "dash";
  $("#aboutEngine").textContent = t("about.engine", { v: "ArchiSteamFarm 6.3.11.7" });
  renderEngineChip();
  renderAccounts(true);
}

// ------------------------------------------------------------------ accounts (title bar)
function accountChips() {
  return accountsList().map((a) => ({
    bot: a.bot,
    login: a.login,
    name: nameOf(a.bot),
    avatar: botOf(a.bot)?.AvatarHash ?? a.avatar ?? null,
    online: !!botOf(a.bot)?.IsConnectedAndLoggedOn,
    current: state.mode === "dash" && a.bot === cur()?.bot,
  }));
}

/** Remembers name and avatar once Steam has signed the account in, so the title bar shows them on the next start. */
async function rememberAccount(bot, b) {
  if (!b?.IsConnectedAndLoggedOn) return;
  const a = accountOf(bot);
  if (!a || (a.name === (b.Nickname || "") && a.avatar === (b.AvatarHash || null))) return;
  await saveAccount(bot, { name: b.Nickname || "", avatar: b.AvatarHash || null });
  renderAccounts(true);
}

let accountsKey = "";
function renderAccounts(force) {
  const box = $("#accounts");
  const list = accountChips();
  const canAdd = state.mode === "dash";
  const key = JSON.stringify([list, state.accountOpen, getLang(), canAdd]);
  if (!force && key === accountsKey) return;
  accountsKey = key;
  box.hidden = !list.length;
  const open = list.find((a) => a.bot === state.accountOpen);
  box.innerHTML = list.map((a) => `<button type="button" class="acc${a.bot === state.accountOpen ? " is-open" : ""}${a.current && list.length > 1 ? " is-current" : ""}" data-account="${esc(a.bot)}"
      title="${esc(a.name)}" aria-label="${esc(t("account.menu"))}: ${esc(a.name)}" aria-haspopup="menu" aria-expanded="${a.bot === state.accountOpen}">
      <img src="${esc(avatarUrl(a.avatar))}" alt=""><i class="acc__dot" data-on="${a.online}"></i></button>`).join("")
    + (canAdd ? `<button type="button" class="acc acc--add" data-action="add-account" title="${esc(t("account.add"))}" aria-label="${esc(t("account.add"))}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` : "")
    + (open ? `<div class="acc__menu" role="menu">
      <div class="acc__head"><img src="${esc(avatarUrl(open.avatar))}" alt="">
        <div><b>${esc(open.name)}</b><small><i class="acc__dot" data-on="${open.online}"></i>${esc(open.login)} · ${esc(t(open.online ? "account.online" : "account.offline"))}</small></div></div>
      <button type="button" class="acc__item" role="menuitem" data-action="add-account">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        ${esc(t("account.add"))}</button>
      <button type="button" class="acc__item acc__item--danger" role="menuitem" data-action="logout" data-bot="${esc(open.bot)}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/></svg>
        ${esc(t("account.logout"))}</button>
      <small class="acc__note">${esc(t("account.logoutNote"))}</small></div>` : "");
}

/** Yes / no question in the app's own window; resolves true for yes. */
function ask(title, text, yesLabel) {
  const d = $("#ask");
  $(".ask__title", d).textContent = title;
  $(".ask__text", d).textContent = text;
  $("#askYes").textContent = yesLabel;
  applyI18n(d);
  d.showModal();
  $("#askYes").focus();
  // Answer straight from the buttons (and Esc), not from the dialog's "close" event, which can arrive late.
  return new Promise((resolve) => {
    const answer = (yes) => (e) => {
      e?.preventDefault();
      d.close();
      resolve(yes);
    };
    $("#askYes").onclick = answer(true);
    $(".ask__bar [value=no]", d).onclick = answer(false);
    d.oncancel = answer(false);
  });
}

async function logout(bot) {
  bot ||= D().bot || cur()?.bot;
  const saved = accountsList().some((a) => a.bot === bot);
  state.accountOpen = null;
  renderAccounts();
  if (!(await ask(t("account.logoutTitle", { name: nameOf(bot) || accountOf(bot)?.login || "" }), t("account.logoutConfirm"), t("account.logout")))) return;
  if (state.draft?.bot === bot) signIn.cancel();
  const rest = accountsList().filter((a) => a.bot !== bot);
  // Show at once that we are leaving: stopping the bot and deleting its files takes a few seconds.
  await saveSettings({ accounts: rest, current: rest.some((a) => a.bot === S().current) ? S().current : rest[0]?.bot || "", wizardDone: rest.length > 0 });
  delete state.bots[bot];
  delete state.cards[bot];
  if (!rest.length) {
    clearInterval(pollTimer);
    state.mode = "wizard";
    state.draft = newAccount();
    state.signin = { kind: "leaving" };
    state.step = 1;
    state.maxStep = 1;
    render();
    await stopBot(bot);
    await deleteBot(bot);
    state.signin = { kind: "form" };
    render();
    return;
  }
  if (state.mode === "wizard" && (state.draft?.bot === bot || !saved)) {
    // Signed out of the account the wizard was showing: a new one starts from an empty form, an edited one goes back.
    if (saved) toDash();
    else {
      state.draft = { ...newAccount(), bot };
      state.signin = { kind: "form" };
      renderWizard();
    }
  } else render();
  await stopBot(bot);
  await deleteBot(bot);
}

function render() {
  renderChrome();
  if (state.mode === "dash") renderDash();
  else renderWizard();
}

// ------------------------------------------------------------------ wizard
// The wizard runs for the first account, for "Add account" and for Settings (editing the current account).
function openWizard(draft, step, signin) {
  state.draft = draft;
  state.mode = "wizard";
  state.signin = signin;
  state.step = step;
  state.maxStep = signin.kind === "ok" ? STEPS.length - 1 : step;
  state.accountOpen = null;
  render();
}

/** Back to the dashboard without saving; an account that was being added is dropped from ASF again. */
async function toDash() {
  const d = state.draft;
  signIn.cancel();
  state.draft = null;
  state.mode = "dash";
  render();
  startPolling();
  if (d && !accountsList().some((a) => a.bot === d.bot)) {
    await stopBot(d.bot);
    await deleteBot(d.bot);
  }
}

function renderWizard() {
  const canLeave = S().wizardDone && accountsList().length > 0;
  $("#view").innerHTML = `
    <div class="wiz">
      <nav class="rail" aria-label="Steps"><ol>
        ${STEPS.map((s, i) => `<li><button data-action="goto" data-step="${i}" class="${i === state.step ? "is-on" : i <= state.maxStep ? "is-done" : ""}"${i <= state.maxStep ? "" : " disabled"}>${esc(t(`steps.${s}`))}</button></li>`).join("")}
      </ol>${canLeave ? `<button class="rail__back" data-action="to-dash">← ${esc(t("app.toDash"))}</button>` : ""}</nav>
      <section class="step" id="step"></section>
    </div>`;
  renderStep();
}

function head(key) {
  return `<p class="eyebrow">${esc(t(`${key}.eyebrow`))}</p>
    <h1 class="title"><span>${esc(t(`${key}.title1`))}</span><span class="accent">${esc(t(`${key}.title2`))}</span></h1>
    <p class="lead">${esc(t(`${key}.lead`))}</p>`;
}

function bar({ back = true, next = true, nextOk = true, nextLabel = t("app.next") } = {}) {
  return `<div class="step__bar">
    ${back && state.step > 0 ? `<button class="btn" data-action="back">${esc(t("app.back"))}</button>` : ""}
    <span class="spacer"></span>
    ${next ? `<button class="btn btn--primary" data-action="next"${nextOk ? "" : " disabled"}>${esc(nextLabel)}</button>` : ""}
  </div>`;
}

const stepRenderers = {
  intro() {
    return `<div class="step__body">${head("intro")}
      <div class="facts">
        ${[1, 2, 3, 4].map((n) => `<div class="fact"><b>${esc(t(`intro.f${n}t`))}</b><p>${esc(t(`intro.f${n}`))}</p></div>`).join("")}
      </div>
      <div class="calc">
        <h3>${esc(t("intro.calcTitle"))}</h3>
        <label>${esc(t("intro.calcLevel"))} <input class="input" type="number" min="0" max="5000" id="lvl" value="${esc(D().level ?? 0)}"></label>
        <output id="lvlOut"></output>
        <small>${esc(t("intro.calcNote"))}</small>
      </div></div>${bar()}`;
  },

  signin() {
    const si = state.signin;
    const ready = state.engine.phase === "ready";
    let body = "";
    if (si.kind === "form" || si.kind === "error" || si.kind === "password") {
      body = `<form id="signinForm" autocomplete="off">
        <label class="field"><span>${esc(t("signin.login"))}</span>
          <input class="input" name="login" id="login" value="${esc(D().login || "")}" autocomplete="username" spellcheck="false" required>
          <small>${esc(t("signin.loginHint"))}</small></label>
        <label class="field"><span>${esc(t("signin.password"))}</span>
          <input class="input" type="password" name="password" id="password" autocomplete="current-password" required></label>
        ${si.kind === "error" ? `<div class="error">${esc(t(`signin.err_${si.reason || "generic"}`))}</div>` : `<div class="note">${esc(t("signin.privacy"))}</div>`}
        <div class="form-actions">
          <button class="btn btn--primary" type="submit"${ready ? "" : " disabled"}>${esc(t("signin.submit"))}</button>
          <button class="btn" type="button" data-action="signin-qr"${ready ? "" : " disabled"}>${esc(t("signin.qrButton"))}</button>
          ${ready ? "" : `<span class="spinner" style="margin:0">${esc(t(`engine.${state.engine.phase === "error" ? "failed" : state.engine.phase}`, { pct: state.engine.pct }))}</span>`}
        </div></form>`;
    } else if (si.kind === "qr") {
      body = qrBox(si.url);
    } else if (si.kind === "leaving") {
      body = `<div class="spinner">${esc(t("account.leaving"))}</div>`;
    } else if (si.kind === "connecting") {
      body = `<div class="spinner">${esc(t("signin.connecting"))}</div>`;
    } else if (si.kind === "email" || si.kind === "app" || si.kind === "parental") {
      body = guardBox(si.kind, si.reason);
    } else if (si.kind === "ok") {
      const b = si.bot || {};
      body = `<div class="who"><img class="avatar" src="${esc(avatarUrl(b.AvatarHash))}" alt="">
        <div><b>${esc(t("signin.signedIn", { name: b.Nickname || D().login }))}</b><p>${esc(t("signin.signedInLead"))}</p></div>
        <button class="btn btn--sm btn--quiet" type="button" data-action="logout">${esc(t("account.logout"))}</button></div>
        <p style="margin-top:14px"><button class="link" data-action="signin-reset">${esc(t("signin.another"))}</button></p>`;
    }
    return `<div class="step__body">${head("signin")}${body}</div>${bar({ nextOk: si.kind === "ok" })}`;
  },

  what() {
    const mode = D().farmMode || "all";
    const order = D().order || "fast";
    const ids = parseAppIds(D().chosenText);
    return `<div class="step__body">${head("what")}
      <div class="choices">
        ${["all", "chosen"].map((m) => `<label class="choice"><input type="radio" name="farmMode" value="${m}"${mode === m ? " checked" : ""}>
          <b>${esc(t(`what.${m}`))}</b><small>${esc(t(`what.${m}Hint`))}</small></label>`).join("")}
      </div>
      <div ${mode === "chosen" ? "" : "hidden"} id="chosenBox">
        <label class="field" style="max-width:none"><textarea class="input" id="chosenText" placeholder="${esc(t("what.chosenPlaceholder"))}">${esc(D().chosenText || "")}</textarea>
        <small id="chosenCount">${esc(t("what.chosenCount", { n: ids.length }))}</small></label>
      </div>
      <h3 class="sub">${esc(t("what.order"))}</h3>
      <div class="choices choices--4">
        ${["fast", "most", "new", "any"].map((o) => `<label class="choice"><input type="radio" name="order" value="${o}"${order === o ? " checked" : ""}>
          <b>${esc(t(`what.o_${o}`))}</b><small>${esc(t(`what.o_${o}Hint`))}</small></label>`).join("")}
      </div>
      <label class="check"><input type="checkbox" id="skipRefundable"${D().skipRefundable !== false ? " checked" : ""}>
        <span><b>${esc(t("what.refund"))}</b><small>${esc(t("what.refundHint"))}</small></span></label>
      </div>${bar({ nextOk: mode === "all" || ids.length > 0 })}`;
  },

  options() {
    const tg = (key, id, on) => `<label class="toggle"><b>${esc(t(`options.${key}`))}</b><input type="checkbox" id="${id}"${on ? " checked" : ""}><small>${esc(t(`options.${key}Hint`))}</small></label>`;
    const linked = !!S().telegram?.chatId;
    return `<div class="step__body">${head("options")}
      <div class="toggles">
        <label class="toggle toggle--fixed"><b>${esc(t("options.play"))}</b><input type="checkbox" checked disabled><small>${esc(t("options.playHint"))}</small></label>
        ${tg("awake", "keepAwake", !!S().keepAwake)}
        ${tg("autostart", "autostart", !!S().autostart)}
        ${tg("tray", "minimizeToTray", S().minimizeToTray !== false)}
        <label class="toggle"><b>${esc(t("options.notify"))}</b><input type="checkbox" id="notifyWindows"${S().notifyWindows !== false ? " checked" : ""}>
          <small>${esc(t("options.notifyHint"))} <button class="link" type="button" data-action="tg-open">${esc(t("options.telegram"))}: ${esc(t(linked ? "options.telegramOn" : "options.telegramSetup"))}</button></small></label>
        ${tg("updates", "autoUpdate", S().autoUpdate !== false)}
        ${tg("feed", "feed", S().feed !== false)}
      </div></div>${bar()}`;
  },

  start() {
    const s = D();
    const games = s.farmMode === "chosen" ? t("start.gamesChosen", { n: parseAppIds(s.chosenText).length }) : t("start.gamesAll");
    return `<div class="step__body">${head("start")}
      <dl class="summary">
        <div><dt>${esc(t("start.account"))}</dt><dd>${esc(state.signin.bot?.Nickname || s.name || s.login || "—")}</dd></div>
        <div><dt>${esc(t("start.games"))}</dt><dd>${esc(games)}</dd></div>
        <div><dt>${esc(t("start.order"))}</dt><dd>${esc(t(`what.o_${s.order || "fast"}`))}</dd></div>
      </dl>
      <div class="error" id="startErr" hidden></div>
      <div style="margin-top:28px"><button class="btn btn--primary btn--big" data-action="finish">${esc(t("start.button"))}</button></div>
      </div>${bar({ next: false })}`;
  },
};

function guardBox(kind, reason) {
  const k = { email: "email", app: "app", parental: "parental" }[kind];
  const steps = kind === "parental" ? [] : t(`signin.${k}Steps`);
  return `<div class="guard">
    <div><h3>${esc(t(`signin.${k}Title`))}</h3><p>${esc(t(`signin.${k}Lead`))}</p>
      ${steps.length ? `<ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>
    <form id="codeForm" data-kind="${kind}">
      <span class="label">${esc(t("signin.code"))}</span>
      <input class="input input--code" id="code" maxlength="${kind === "parental" ? 8 : 5}" autocomplete="one-time-code" spellcheck="false" required>
      <button class="btn btn--primary" type="submit">${esc(t("signin.confirm"))}</button>
    </form>
    ${kind === "app" ? `<small>${esc(t("signin.appNote"))}</small>` : ""}
  </div>${reason === "code" ? `<div class="error">${esc(t("signin.err_code"))}</div>` : ""}`;
}

function qrBox(url) {
  let svg = "";
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(url);
    qr.make();
    svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch (e) {
    console.error("qr", e);
  }
  return `<div class="guard">
    <div><h3>${esc(t("signin.qrTitle"))}</h3><p>${esc(t("signin.qrLead", { login: D().login || "" }))}</p>
      <ol>${t("signin.qrSteps").map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>
    <div class="qr">${svg}</div>
    <small>${esc(t("signin.qrNote"))} <button class="link" data-action="qr-cancel">${esc(t("signin.qrCancel"))}</button></small>
  </div>`;
}

function renderStep() {
  const el = $("#step");
  if (!el) return;
  const name = STEPS[state.step];
  // Keep what the user is typing when the step re-renders because of an engine/sign-in update.
  const typed = { login: $("#login")?.value, password: $("#password")?.value, code: $("#code")?.value };
  el.innerHTML = stepRenderers[name]();
  if ($("#login") && typed.login != null) $("#login").value = typed.login;
  if ($("#password") && typed.password) $("#password").value = typed.password;
  if ($("#code") && typed.code) $("#code").value = typed.code;
  if (name === "intro") updateCalc();
  ($("#code") || (name === "signin" && !$("#login")?.value ? $("#login") : null))?.focus();
}

function updateCalc() {
  const out = $("#lvlOut");
  if (!out) return;
  const r = nextSlot($("#lvl").value);
  out.textContent = t("intro.calcResult", r);
}

async function goto(step) {
  state.step = Math.max(0, Math.min(STEPS.length - 1, step));
  state.maxStep = Math.max(state.maxStep, state.step);
  renderWizard();
}

// ------------------------------------------------------------------ sign-in
const signIn = new SignIn(
  (st) => {
    state.signin = st;
    if (st.kind === "ok" && state.draft) {
      const bot = state.draft.bot;
      state.loggedOnSince[bot] = Date.now();
      state.bots[bot] = st.bot;
      Object.assign(state.draft, { name: st.bot.Nickname || "", avatar: st.bot.AvatarHash || null });
      rememberAccount(bot, st.bot);
    }
    if (state.mode === "wizard") renderStep();
  },
  { toInteractive: () => engineMode(true), toHeadless: () => engineMode(false) },
);

/** The same Steam login twice would be two bots fighting over one account. */
function takenLogin(login) {
  return accountsList().some((a) => a.bot !== D().bot && a.login.toLowerCase() === login.toLowerCase());
}

async function onQrSignIn() {
  const login = $("#login")?.value.trim();
  if (!login || takenLogin(login)) {
    // Say why nothing starts instead of silently focusing the field.
    state.signin = { kind: "error", reason: login ? "dup" : "login" };
    renderStep();
    $("#login")?.focus();
    return;
  }
  state.draft.login = login;
  try {
    await signIn.beginQr(D());
  } catch (e) {
    console.error(e);
    state.signin = { kind: "error", reason: "qr" };
    renderStep();
  }
}

async function onSignInSubmit(form) {
  const login = form.login.value.trim();
  const password = form.password.value;
  if (!login || !password) return;
  if (takenLogin(login)) {
    state.signin = { kind: "error", reason: "dup" };
    renderStep();
    return;
  }
  state.draft.login = login;
  try {
    await bootEngine();
    if (state.signin.kind === "password") await signIn.submitPassword(password);
    else await signIn.begin(D(), password);
  } catch (e) {
    console.error(e);
    state.signin = { kind: "error", reason: "generic" };
    renderStep();
  }
}

async function onCodeSubmit(form) {
  const value = $("#code", form).value.trim();
  const type = { email: INPUT.SteamGuard, app: INPUT.TwoFactor, parental: INPUT.Parental }[form.dataset.kind];
  if (!value) return;
  if (state.mode === "dash") return submitDashInput(type, value);
  try {
    await signIn.submitCode(type, value);
  } catch {
    state.signin = { kind: form.dataset.kind, reason: "code" };
    renderStep();
  }
}

// ------------------------------------------------------------------ finish
async function finish(btn) {
  btn.disabled = true;
  btn.textContent = t("start.saving");
  const err = $("#startErr");
  const d = { ...state.draft };
  try {
    const list = accountsList().some((a) => a.bot === d.bot) ? accountsList().map((a) => (a.bot === d.bot ? d : a)) : [...accountsList(), d];
    await saveSettings({ wizardDone: true, accounts: list, current: d.bot });
    try {
      await api.setAutostart(!!S().autostart);
    } catch (e) {
      console.warn("autostart", e);
    }
    await restartEngineIfNeeded();
    await saveBot(d.bot, botConfig(d)); // farming no longer paused by default
    // ASF reloads the bot after a config change; wait for it before touching its queue.
    const ids = d.farmMode === "chosen" ? parseAppIds(d.chosenText) : [];
    if (ids.length) {
      for (let i = 0; i < 20 && !(await getBot(d.bot)); i++) await new Promise((r) => setTimeout(r, 750));
      await queueGames(d.bot, ids);
    }
    await startBot(d.bot);
    state.draft = null;
    state.mode = "dash";
    if (S().feed !== false && !state.feed) loadFeed();
    render();
    startPolling();
  } catch (e) {
    console.error(e);
    err.hidden = false;
    err.textContent = String(e?.message || e);
    btn.disabled = false;
    btn.textContent = t("start.button");
  }
}

// ------------------------------------------------------------------ dashboard
function renderDash() {
  const a = cur() || {};
  $("#view").innerHTML = `
    <div class="dash">
      <section class="panel dash__head" id="dHead"></section>
      <section class="sale" id="dSale" hidden></section>
      <section class="panel attention" id="dInput" hidden></section>
      <div class="dash__grid">
        <div class="dash__main">
          <section class="panel now" id="dNow"></section>
          <section class="panel stats" id="dStats"></section>
          <section class="panel queue" id="dQueue"></section>
        </div>
        <div class="dash__side">
          <section class="panel level" id="dLevel">
            <span class="label">${esc(t("dash.levelTitle1"))} ${esc(t("dash.levelTitle2"))}</span>
            <label class="level__row"><span>${esc(t("dash.levelYour"))}</span><input class="input" type="number" min="0" max="5000" id="lvl" value="${esc(a.level ?? 0)}"></label>
            <div class="bar"><i id="lvlBar"></i></div>
            <div class="level__meta"><span id="lvlA"></span><span id="lvlB"></span></div>
            <button class="btn btn--sm btn--primary" data-href="${SITE}">${esc(t("dash.site"))}</button>
          </section>
          <section class="panel sets" id="dSets"></section>
        </div>
      </div>
    </div>`;
  updateLevel();
  updateDash();
  updateSale();
  updateSets();
}

function updateLevel() {
  const r = nextSlot($("#lvl")?.value ?? cur()?.level ?? 0);
  if (!$("#lvlBar")) return;
  $("#lvlBar").style.width = `${Math.max(4, r.progress * 100)}%`;
  $("#lvlA").textContent = t("dash.levelProgress", r);
  $("#lvlB").textContent = t("dash.levelNeed", r);
}

function fmtMinutes(min) {
  if (min <= 0) return "—";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return `${d} ${t("time.d")} ${h} ${t("time.h")}`;
  if (h) return `${h} ${t("time.h")} ${m} ${t("time.m")}`;
  return `${m} ${t("time.m")}`;
}
const fmtUsd = (cents) => new Intl.NumberFormat(getLang(), { style: "currency", currency: "USD" }).format((cents || 0) / 100);
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(getLang(), { day: "numeric", month: "long" });

function updateDash() {
  if (!$("#dHead")) return;
  const bot = cur()?.bot;
  const b = botOf(bot);
  const status = botStatus(b, { loggedOnSince: state.loggedOnSince[bot] });
  const cf = b?.CardsFarmer || {};
  const toFarm = cf.GamesToFarm || [];
  const current = cf.CurrentGamesFarming?.[0] || null;
  const running = b?.KeepRunning;
  const others = accountsList().filter((a) => a.bot !== bot);

  $("#dHead").innerHTML = `
    <div class="who-inline"><img class="avatar" src="${esc(avatarUrl(b?.AvatarHash ?? cur()?.avatar))}" alt="">
      <div><b>${esc(nameOf(bot))}</b><div class="status" data-s="${status}"><i></i>${esc(t(`dash.status_${status}`))}</div></div></div>
    ${others.length ? `<div class="tabs" role="tablist">${accountsList().map((a) => {
      const st = botStatus(botOf(a.bot), { loggedOnSince: state.loggedOnSince[a.bot] });
      return `<button type="button" role="tab" class="tab${a.bot === bot ? " is-on" : ""}" data-action="switch-account" data-bot="${esc(a.bot)}" aria-selected="${a.bot === bot}">
        <img src="${esc(avatarUrl(botOf(a.bot)?.AvatarHash ?? a.avatar))}" alt=""><span>${esc(nameOf(a.bot))}</span><i class="status__dot" data-s="${st}"></i></button>`;
    }).join("")}</div>` : ""}
    <div class="actions">
      ${running && b?.IsConnectedAndLoggedOn ? (cf.Paused
        ? `<button class="btn btn--primary" data-action="resume">${esc(t("dash.resume"))}</button>`
        : `<button class="btn" data-action="pause">${esc(t("dash.pause"))}</button>`) : ""}
      ${running ? `<button class="btn" data-action="stop">${esc(t("dash.stop"))}</button>`
        : `<button class="btn btn--primary" data-action="start-bot">${esc(t("dash.startBot"))}</button>`}
    </div>`;

  const inputBox = $("#dInput");
  const need = b?.RequiredInput;
  const needKey = `${bot}:${need || 0}`;
  if (need === INPUT.Password) {
    if (inputBox.dataset.need !== needKey) {
      inputBox.innerHTML = `<form id="dashPassword" class="attention__form"><p class="label">${esc(t("dash.needPassword"))}</p>
        <div class="attention__row"><input class="input" type="password" name="password" placeholder="${esc(t("signin.password"))}" aria-label="${esc(t("signin.password"))}" required>
        <button class="btn btn--primary" type="submit">${esc(t("dash.passwordSubmit"))}</button>
        <button class="btn" type="button" data-action="relogin">${esc(t("signin.qrButton"))}</button></div>
        <small>${esc(t("signin.privacy"))}</small></form>`;
    }
  } else if ([INPUT.SteamGuard, INPUT.TwoFactor, INPUT.Parental].includes(need)) {
    const kind = { [INPUT.SteamGuard]: "email", [INPUT.TwoFactor]: "app", [INPUT.Parental]: "parental" }[need];
    if (inputBox.dataset.need !== needKey) inputBox.innerHTML = guardBox(kind, state.dashInputError);
  } else {
    inputBox.innerHTML = "";
  }
  inputBox.dataset.need = needKey;
  inputBox.hidden = !need;

  $("#dNow").innerHTML = current
    ? `<img src="${capsule(current.AppID)}" alt="">
       <div><span class="label">${esc(t("dash.now"))}</span><h3>${esc(current.GameName)}</h3>
       <p>${esc(t("dash.cardsInGame", { n: current.CardsRemaining }))} · ${esc(t("dash.hours", { h: (+current.HoursPlayed || 0).toFixed(1) }))}</p></div>`
    : `<div class="ph">♦</div><div><span class="label">${esc(t("dash.now"))}</span><p>${esc(t("dash.nothing"))}</p></div>`;

  const cards = toFarm.reduce((s, g) => s + (g.CardsRemaining || 0), 0);
  $("#dStats").innerHTML = `
    <div><b>${cards}</b><span>${esc(t("dash.cardsLeft"))}</span></div>
    <div><b>${toFarm.length}</b><span>${esc(t("dash.gamesLeft"))}</span></div>
    <div><b>${esc(fmtMinutes(spanMinutes(cf.TimeRemaining)))}</b><span>${esc(t("dash.timeLeft"))}</span></div>`;

  const rest = toFarm.filter((g) => g.AppID !== current?.AppID);
  $("#dQueue").innerHTML = `<span class="label">${esc(t("dash.queue"))}</span>
    ${rest.length ? `<ul>${rest.slice(0, 30).map((g) => `<li>
        <img src="${capsule(g.AppID)}" alt="" loading="lazy">
        <div><b>${esc(g.GameName)}</b><small>${esc(t("dash.hours", { h: (+g.HoursPlayed || 0).toFixed(1) }))}</small></div>
        <span class="cards-pill">${g.CardsRemaining}</span>
        <div class="row-actions">
          <button class="btn btn--sm" data-action="farm-next" data-app="${g.AppID}">${esc(t("dash.farmNext"))}</button>
          <button class="btn btn--sm" data-action="skip" data-app="${g.AppID}" data-name="${esc(g.GameName)}">${esc(t("dash.skip"))}</button>
        </div></li>`).join("")}</ul>`
      : `<p class="empty">${esc(t("dash.queueEmpty"))}</p>`}`;
}

// ------------------------------------------------------------------ Steam sales (from the feed)
/** The sale running now, or the next one within 30 days: { sale, now, days }. */
function saleNews(today = new Date().toISOString().slice(0, 10)) {
  const sales = (state.feed?.sales || []).filter((s) => s.kind === "sale" && s.end >= today).sort((a, b) => a.start.localeCompare(b.start));
  const s = sales[0];
  if (!s) return null;
  if (s.start <= today) return { sale: s, now: true, days: 0 };
  const days = Math.round((Date.parse(s.start) - Date.parse(today)) / 864e5);
  return days <= 30 ? { sale: s, now: false, days } : null;
}

function updateSale() {
  const box = $("#dSale");
  if (!box) return;
  const n = saleNews();
  box.hidden = !n;
  if (!n) return;
  const { sale, now, days } = n;
  const text = now
    ? t("sale.now", { name: sale.name, date: fmtDate(sale.end) })
    : t("sale.soon", { name: sale.name, n: days, date: fmtDate(sale.start) });
  box.innerHTML = `<i aria-hidden="true">★</i><p><b>${esc(text)}</b> ${esc(t(sale.rewards?.includes("stickers") ? "sale.stickers" : "sale.plain"))}</p>
    ${now ? `<button class="btn btn--sm btn--primary" data-href="https://store.steampowered.com/explore/">${esc(t("sale.open"))}</button>` : ""}`;
}

// ------------------------------------------------------------------ sets close to a badge (inventory + feed)
async function loadFeed() {
  if (S().feed === false) {
    state.feed = null;
    return;
  }
  state.feed = await api.feedGet().catch(() => null);
  updateSale();
  updateSets();
}

let setsLoading = null;
function loadSets(bot, force) {
  const c = state.cards[bot];
  if (!state.feed || setsLoading || (!force && c && Date.now() - c.at < SETS_EVERY)) return;
  if (!botOf(bot)?.IsConnectedAndLoggedOn) return;
  setsLoading = (async () => {
    try {
      state.cards[bot] = { at: Date.now(), games: await cardsByGame(bot) };
    } catch (e) {
      console.warn("inventory", e);
      state.cards[bot] = { at: Date.now(), games: null, err: true };
    } finally {
      setsLoading = null;
    }
    if (cur()?.bot === bot) updateSets();
  })();
}

function updateSets() {
  const box = $("#dSets");
  if (!box) return;
  const bot = cur()?.bot;
  const c = state.cards[bot];
  const headHtml = `<div class="sets__head"><span class="label">${esc(t("sets.title"))}</span>
    ${c?.games ? `<button class="link" data-action="sets-reload" title="${esc(t("sets.reload"))}">↻</button>` : ""}</div>`;
  let body;
  if (!state.feed) body = `<p class="empty">${esc(t(S().feed === false ? "sets.off" : "sets.nofeed"))}</p>`;
  else if (!c) body = `<p class="empty">${esc(t(botOf(bot)?.IsConnectedAndLoggedOn ? "sets.loading" : "sets.waiting"))}</p>`;
  else if (!c.games) body = `<p class="empty">${esc(t("sets.err"))}</p>`;
  else {
    const rows = nearSets(c.games, state.feed.sets);
    body = rows.length
      // A row opens the badge page (full set: craft it) or the market filtered to this game's cards.
      ? `<ul>${rows.map((r) => `<li role="link" tabindex="0" title="${esc(t(r.full ? "sets.craft" : "sets.buy"))}" data-href="${r.full ? `https://steamcommunity.com/my/gamecards/${r.appid}/` : `https://steamcommunity.com/market/search?appid=753&category_753_Game%5B%5D=tag_app_${r.appid}&category_753_cardborder%5B%5D=tag_cardborder_0&category_753_item_class%5B%5D=tag_item_class_2`}">
          <img src="${capsule(r.appid)}" alt="" loading="lazy">
          <div><b>${esc(r.name || `App ${r.appid}`)}</b><small>${esc(r.full ? t("sets.full") : t("sets.missing", { n: r.missing, price: fmtUsd(r.price) }))}</small></div>
          <span class="cards-pill${r.full ? " is-full" : ""}">${r.have}/${r.size}</span>
        </li>`).join("")}</ul><small class="sets__note">${esc(t("sets.note"))}</small>`
      : `<p class="empty">${esc(t("sets.empty"))}</p>`;
  }
  box.innerHTML = headHtml + body;
}

async function submitDashInput(type, value) {
  const bot = cur()?.bot;
  try {
    await sendInput(bot, type, value);
    state.dashInputError = null;
    await startBot(bot);
  } catch {
    state.dashInputError = "code";
    $("#dInput").dataset.need = "";
  }
  pollOnce();
}

// ------------------------------------------------------------------ notifications
// Windows notification and/or the user's own Telegram bot, when farming on an account ends or Steam needs input.
function notify(kind, bot) {
  const title = t(`notify.${kind}Title`);
  const body = t(`notify.${kind}Body`, { name: nameOf(bot) });
  if (S().notifyWindows !== false) api.notifyToast(title, body).catch((e) => console.warn("toast", e));
  const tg = S().telegram;
  if (tg?.token && tg?.chatId) api.telegramSend(tg.token, tg.chatId, `${title}\n${body}`).catch((e) => console.warn("telegram", e));
}

function watchForNews(bot, b) {
  const status = botStatus(b, { loggedOnSince: state.loggedOnSince[bot] });
  const input = b?.RequiredInput || 0;
  const prev = state.seen[bot];
  // "farmed": this account farmed since SCMFARM started; right after the last card ASF shows "scanning" for a while.
  const farmed = (prev?.farmed || status === "farming") && status !== "done";
  state.seen[bot] = { status, input, farmed };
  if (!prev) return; // first look after start: nothing has changed yet
  if (prev.farmed && status === "done") notify("done", bot);
  // The wizard asks for codes itself while it signs this account in.
  const signingIn = state.mode === "wizard" && state.draft?.bot === bot;
  if (input && !prev.input && !signingIn) notify("input", bot);
}

// ------------------------------------------------------------------ polling
let pollTimer = null;
async function pollOnce() {
  const list = accountsList();
  const got = await getBots(list.map((a) => a.bot));
  for (const a of list) {
    const b = got[a.bot] ?? null;
    state.bots[a.bot] = b;
    if (b?.IsConnectedAndLoggedOn) state.loggedOnSince[a.bot] ||= Date.now();
    else state.loggedOnSince[a.bot] = 0;
    watchForNews(a.bot, b);
    rememberAccount(a.bot, b);
  }
  if (state.mode === "dash") {
    updateDash();
    loadSets(cur()?.bot);
  }
  renderAccounts();
}
function startPolling() {
  clearInterval(pollTimer);
  if (!accountsList().length) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, 3000);
}

async function switchAccount(bot) {
  if (!accountsList().some((a) => a.bot === bot) || bot === cur()?.bot) return;
  await saveSettings({ current: bot });
  state.dashInputError = null;
  if (state.mode === "dash") renderDash();
  renderAccounts(true);
  loadSets(bot);
}

// ------------------------------------------------------------------ Telegram setup
function openTelegram() {
  const d = $("#tg");
  const tg = S().telegram || {};
  $("#tgToken").value = tg.token || "";
  tgStatus(tg.chatId ? "linked" : "");
  applyI18n(d);
  $(".tg__steps", d).innerHTML = t("telegram.steps").map((s) => `<li>${esc(s)}</li>`).join("");
  $("#tgOff").hidden = !tg.token;
  d.showModal();
}

function tgStatus(key, error) {
  const p = $("#tgStatus");
  p.className = error ? "error" : key ? "note" : "";
  p.textContent = key ? t(`telegram.${key}`) : "";
  p.hidden = !key;
}

async function telegramLink(test) {
  const token = $("#tgToken").value.trim();
  if (!token) return tgStatus("err_bad_token", true);
  tgStatus("working");
  try {
    let chatId = S().telegram?.token === token ? S().telegram.chatId : null;
    if (!chatId || !test) chatId = await api.telegramLink(token);
    await saveSettings({ telegram: { token, chatId } });
    if (test) await api.telegramSend(token, chatId, t("telegram.testText"));
    tgStatus(test ? "sent" : "linked");
    $("#tgOff").hidden = false;
  } catch (e) {
    const code = String(e?.message || e);
    tgStatus(["bad_token", "no_chat", "offline"].includes(code) ? `err_${code}` : "err_generic", true);
  }
  if (state.mode === "wizard" && STEPS[state.step] === "options") renderStep();
}

// ------------------------------------------------------------------ events
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action],[data-href]");
  if (!el) return;
  if (el.dataset.href) {
    e.preventDefault();
    api.openExternal(el.dataset.href);
    return;
  }
  const a = el.dataset.action;
  const bot = cur()?.bot;
  if (a === "next") {
    await persistStep();
    goto(state.step + 1);
  } else if (a === "back") goto(state.step - 1);
  else if (a === "goto") goto(Number(el.dataset.step));
  else if (a === "finish") finish(el);
  else if (a === "to-dash") toDash();
  else if (a === "add-account") {
    signIn.cancel();
    openWizard(newAccount(), 1, { kind: "form" });
    $("#login")?.focus();
  } else if (a === "switch-account") switchAccount(el.dataset.bot);
  else if (a === "signin-reset") {
    signIn.cancel();
    await stopBot(D().bot);
    state.signin = { kind: "form" };
    state.maxStep = state.step;
    renderWizard();
  } else if (a === "signin-qr") onQrSignIn();
  else if (a === "qr-cancel") {
    await signIn.cancelQr().catch(console.warn);
    state.signin = { kind: "form" };
    renderStep();
  } else if (a === "relogin") {
    openWizard({ ...cur() }, 1, { kind: "form" });
    state.maxStep = STEPS.length - 1;
    renderWizard();
  } else if (a === "engine-retry") bootEngine().catch(() => {});
  else if (a === "logout") logout(el.dataset.bot);
  else if (a === "open-licenses") api.openLicenses().catch(console.warn);
  else if (a === "remove-pc") removeFromPc();
  else if (a === "tg-open") openTelegram();
  else if (a === "tg-link") telegramLink(false);
  else if (a === "tg-test") telegramLink(true);
  else if (a === "tg-off") {
    await saveSettings({ telegram: null });
    $("#tgToken").value = "";
    $("#tgOff").hidden = true;
    tgStatus("removed");
    if (state.mode === "wizard") renderStep();
  } else if (a === "sets-reload") {
    loadSets(bot, true);
    state.cards[bot] = null;
    updateSets();
  } else if (a === "pause") { await pauseFarming(bot); pollOnce(); }
  else if (a === "resume") { await resumeFarming(bot); pollOnce(); }
  else if (a === "stop") { await stopBot(bot); pollOnce(); }
  else if (a === "start-bot") { await startBot(bot); pollOnce(); }
  else if (a === "farm-next") { await farmNext(bot, el.dataset.app).catch(console.warn); pollOnce(); }
  else if (a === "skip") {
    if (await ask(t("dash.skip"), t("dash.skipConfirm", { name: el.dataset.name }), t("dash.skip"))) {
      await skipGame(bot, el.dataset.app).catch(console.warn);
      pollOnce();
    }
  }
});

$("#btnSettings").addEventListener("click", () => {
  const a = cur();
  if (!a) return;
  const b = botOf(a.bot);
  openWizard({ ...a }, 2, b?.IsConnectedAndLoggedOn ? { kind: "ok", bot: b } : { kind: "form" });
  state.maxStep = STEPS.length - 1;
  renderWizard();
});
$("#btnAbout").addEventListener("click", () => $("#about").showModal());

// ------------------------------------------------------------------ language menu
const langBox = $("#lang");
function langMenu(open) {
  langBox.classList.toggle("is-open", open);
  $(".lang__btn", langBox).setAttribute("aria-expanded", String(open));
  $(".lang__menu", langBox).hidden = !open;
}
$(".lang__btn", langBox).addEventListener("click", () => langMenu(!langBox.classList.contains("is-open")));
$(".lang__menu", langBox).addEventListener("click", async (e) => {
  const b = e.target.closest("[data-lang]");
  if (!b) return;
  langMenu(false);
  if (b.dataset.lang === getLang()) return;
  setLang(b.dataset.lang);
  await saveSettings({ lang: b.dataset.lang });
  render();
});
document.addEventListener("pointerdown", (e) => {
  if (!langBox.contains(e.target)) langMenu(false);
  if (state.accountOpen && !$("#accounts").contains(e.target)) { state.accountOpen = null; renderAccounts(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches?.("li[data-href]")) api.openExternal(e.target.dataset.href);
  if (e.key !== "Escape") return;
  langMenu(false);
  if (state.accountOpen) { state.accountOpen = null; renderAccounts(); }
});
// An avatar opens its account menu and, on the dashboard, shows that account.
$("#accounts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-account]");
  if (!b) return;
  langMenu(false);
  state.accountOpen = state.accountOpen === b.dataset.account ? null : b.dataset.account;
  if (state.mode === "dash") switchAccount(b.dataset.account);
  renderAccounts();
});

// ------------------------------------------------------------------ window frame
// The window has no Windows frame (tauri.conf.json "decorations": false): the top bar is the title bar.
const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
if (appWindow) {
  $("#winCtl").hidden = false;
  document.documentElement.classList.add("is-app");
  const syncMax = async () => document.documentElement.classList.toggle("is-max", await appWindow.isMaximized());
  $("#winCtl").addEventListener("click", (e) => {
    const b = e.target.closest("[data-win]");
    if (!b) return;
    if (b.dataset.win === "min") appWindow.minimize();
    else if (b.dataset.win === "max") appWindow.toggleMaximize();
    else appWindow.close(); // goes to the tray when that option is on (lib.rs)
  });
  $("#titlebar").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button,input,select,a,.lang,.wc")) return;
    if (e.detail === 2) appWindow.toggleMaximize();
    else appWindow.startDragging();
  });
  appWindow.onResized(syncMax);
  syncMax();
  // An app, not a page: no browser menu on right click (text fields keep theirs).
  document.addEventListener("contextmenu", (e) => { if (!e.target.closest("input,textarea")) e.preventDefault(); });
}

document.addEventListener("submit", (e) => {
  if (e.target.method === "dialog") return; // <dialog> forms close their dialog themselves
  e.preventDefault();
  const f = e.target;
  if (f.id === "signinForm") onSignInSubmit(f);
  else if (f.id === "codeForm") onCodeSubmit(f);
  else if (f.id === "dashPassword") submitDashInput(INPUT.Password, f.password.value);
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "lvl") {
    updateCalc();
    updateLevel();
    const level = Number(el.value) || 0;
    if (state.mode === "dash") saveAccount(cur()?.bot, { level });
    else state.draft.level = level;
  } else if (el.id === "chosenText") {
    state.draft.chosenText = el.value;
    const n = parseAppIds(el.value).length;
    $("#chosenCount").textContent = t("what.chosenCount", { n });
    const next = $('[data-action="next"]');
    if (next) next.disabled = n === 0;
  } else if (el.id === "code") {
    el.value = el.value.replace(/\s/g, "").toUpperCase();
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.name === "farmMode" || el.name === "order") {
    state.draft[el.name] = el.value;
    renderStep();
  } else if (el.id === "skipRefundable") {
    state.draft.skipRefundable = el.checked;
  } else if (["keepAwake", "autostart", "minimizeToTray", "autoUpdate", "feed", "notifyWindows"].includes(el.id)) {
    state.settings[el.id] = el.checked;
  }
});

/** Saves the current step's app-wide answers before moving on (the account's own answers are saved by "finish"). */
async function persistStep() {
  const s = state.settings;
  if (STEPS[state.step] === "options") {
    await saveSettings({ keepAwake: !!s.keepAwake, autostart: !!s.autostart, minimizeToTray: s.minimizeToTray !== false,
      autoUpdate: s.autoUpdate !== false, feed: s.feed !== false, notifyWindows: s.notifyWindows !== false });
    if (S().feed === false) state.feed = null;
  }
}

// ------------------------------------------------------------------ self-update (portable exe)
// At start: when showcasemaker.com lists a newer SCMFARM, download it (Rust checks the checksum and the release
// signature), and the app restarts into it. Offline or no release yet: nothing happens.
async function updateAtStart() {
  // The user can switch the update check off in the options step.
  if (S().autoUpdate === false) {
    state.appVersion = await api.appVersion().catch(() => "");
    $("#aboutVersion").textContent = state.appVersion ? t("about.version", { v: state.appVersion }) : "";
    return;
  }
  const r = await api.updateCheck().catch(() => null);
  state.appVersion = r?.current || "";
  $("#aboutVersion").textContent = state.appVersion ? t("about.version", { v: state.appVersion }) : "";
  if (!r?.available) return;
  const box = $("#updating");
  const pct = (p) => {
    const v = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    $("#updBar").style.width = `${Math.max(3, v)}%`;
    $(".upd__pct", box).textContent = `${v}%`;
  };
  $(".upd__title", box).textContent = t("update.title", { v: r.latest });
  $(".upd__lead", box).textContent = t("update.lead");
  pct({ done: 0, total: 0 });
  box.hidden = false;
  try {
    await api.updateInstall(pct);
    await new Promise(() => {}); // the app is restarting
  } catch (e) {
    console.warn("update", e);
    $(".upd__lead", box).textContent = t(String(e) === "folder_not_writable" ? "update.locked" : "update.failed");
    $(".upd__pct", box).textContent = "";
    await new Promise((r2) => setTimeout(r2, 3500));
    box.hidden = true;
  }
}

async function removeFromPc() {
  $("#about").close();
  if (!(await ask(t("remove.title"), t("remove.text"), t("remove.yes")))) return;
  clearInterval(pollTimer);
  signIn.cancel();
  await api.removeFromPc(true);
}

// ------------------------------------------------------------------ boot
(async function main() {
  state.settings = await api.settingsGet();
  setLang(detectLang(S().lang));
  await migrateSettings();
  if (S().wizardDone && accountsList().length) state.mode = "dash";
  else state.draft ??= newAccount();
  render();
  await updateAtStart(); // returns when there is nothing to install or the update failed
  loadFeed();
  try {
    await bootEngine();
    if (state.mode === "dash") startPolling();
  } catch (e) {
    console.error("engine", e);
  }
})();

// Hide game art that Steam doesn't have (inline onerror handlers are blocked by the CSP).
document.addEventListener("error", (e) => {
  if (e.target instanceof HTMLImageElement) e.target.style.visibility = "hidden";
}, true);

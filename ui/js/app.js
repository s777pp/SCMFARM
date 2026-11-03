import { api, isDemo } from "./backend.js";
import { LANGS, applyI18n, detectLang, getLang, setLang, t } from "./i18n.js";
import {
  INPUT, SignIn, botConfig, botStatus, farmNext, getBot, nextSlot, parseAppIds, pauseFarming, queueGames,
  resumeFarming, saveBot, sendInput, skipGame, spanMinutes, startBot, stopBot,
} from "./farm.js";

const SITE = "https://showcasemaker.com";
const STEPS = ["intro", "signin", "what", "options", "start"];
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const capsule = (id) => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${Number(id)}/header.jpg`;
const avatarUrl = (hash) => (hash ? `https://avatars.akamai.steamstatic.com/${encodeURIComponent(hash)}_full.jpg` : "img/icon.svg");

const state = {
  settings: {},
  mode: "wizard",
  step: 0,
  maxStep: 0,
  engine: { phase: "checking", pct: 0, err: null },
  engineAwake: null, // keepAwake value the running engine was started with
  signin: { kind: "form" },
  bot: null,
  loggedOnSince: 0,
  dashInputError: null,
};

// ------------------------------------------------------------------ settings
async function saveSettings(patch) {
  state.settings = await api.settingsSet(patch);
}
const S = () => state.settings;

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

async function restartEngineIfNeeded() {
  if (state.engineAwake === !!S().keepAwake) return;
  await api.engineStop();
  engineBoot = null;
  await bootEngine();
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
  const sel = $("#lang");
  sel.innerHTML = LANGS.filter((l) => l.ready)
    .map((l) => `<option value="${l.code}"${l.code === getLang() ? " selected" : ""}>${esc(l.name)}</option>`)
    .join("");
  $("#demoBadge").hidden = !isDemo;
  $("#btnSettings").hidden = state.mode !== "dash";
  $("#aboutEngine").textContent = t("about.engine", { v: "ArchiSteamFarm 6.3.11.7" });
  renderEngineChip();
}

function render() {
  renderChrome();
  if (state.mode === "dash") renderDash();
  else renderWizard();
}

// ------------------------------------------------------------------ wizard
function renderWizard() {
  $("#view").innerHTML = `
    <div class="wiz">
      <nav class="rail panel" aria-label="Steps"><ol>
        ${STEPS.map((s, i) => `<li><button data-action="goto" data-step="${i}" class="${i === state.step ? "is-on" : i <= state.maxStep ? "is-done" : ""}"${i <= state.maxStep ? "" : " disabled"}>${esc(t(`steps.${s}`))}</button></li>`).join("")}
      </ol></nav>
      <section class="panel step" id="step"></section>
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
        <label>${esc(t("intro.calcLevel"))} <input class="input" type="number" min="0" max="5000" id="lvl" value="${esc(S().level ?? 0)}"></label>
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
          <input class="input" name="login" id="login" value="${esc(S().login || "")}" autocomplete="username" spellcheck="false" required>
          <small>${esc(t("signin.loginHint"))}</small></label>
        <label class="field"><span>${esc(t("signin.password"))}</span>
          <input class="input" type="password" name="password" id="password" autocomplete="current-password" required></label>
        ${si.kind === "error" ? `<div class="error">${esc(t(`signin.err_${si.reason || "generic"}`))}</div>` : ""}
        <div class="note">${esc(t("signin.privacy"))}</div>
        <div class="step__bar" style="border:0;padding-top:0">
          <button class="btn btn--primary" type="submit"${ready ? "" : " disabled"}>${esc(t("signin.submit"))}</button>
          ${ready ? "" : `<span class="spinner" style="margin:0">${esc(t(`engine.${state.engine.phase === "error" ? "failed" : state.engine.phase}`, { pct: state.engine.pct }))}</span>`}
        </div></form>`;
    } else if (si.kind === "connecting") {
      body = `<div class="spinner">${esc(t("signin.connecting"))}</div>`;
    } else if (si.kind === "email" || si.kind === "app" || si.kind === "parental") {
      body = guardBox(si.kind, si.reason);
    } else if (si.kind === "ok") {
      const b = si.bot || {};
      body = `<div class="who"><img class="avatar" src="${esc(avatarUrl(b.AvatarHash))}" alt="">
        <div><b>${esc(t("signin.signedIn", { name: b.Nickname || S().login }))}</b><p>${esc(t("signin.signedInLead"))}</p></div></div>
        <p style="margin-top:14px"><button class="link" data-action="signin-reset">${esc(t("signin.another"))}</button></p>`;
    }
    return `<div class="step__body">${head("signin")}${body}</div>${bar({ nextOk: si.kind === "ok" })}`;
  },

  what() {
    const mode = S().farmMode || "all";
    const order = S().order || "fast";
    const ids = parseAppIds(S().chosenText);
    return `<div class="step__body">${head("what")}
      <div class="choices">
        ${["all", "chosen"].map((m) => `<label class="choice"><input type="radio" name="farmMode" value="${m}"${mode === m ? " checked" : ""}>
          <b>${esc(t(`what.${m}`))}</b><small>${esc(t(`what.${m}Hint`))}</small></label>`).join("")}
      </div>
      <div ${mode === "chosen" ? "" : "hidden"} id="chosenBox">
        <label class="field" style="max-width:none"><textarea class="input" id="chosenText" placeholder="${esc(t("what.chosenPlaceholder"))}">${esc(S().chosenText || "")}</textarea>
        <small id="chosenCount">${esc(t("what.chosenCount", { n: ids.length }))}</small></label>
      </div>
      <h3 class="sub">${esc(t("what.order"))}</h3>
      <div class="choices choices--4">
        ${["fast", "most", "new", "any"].map((o) => `<label class="choice"><input type="radio" name="order" value="${o}"${order === o ? " checked" : ""}>
          <b>${esc(t(`what.o_${o}`))}</b><small>${esc(t(`what.o_${o}Hint`))}</small></label>`).join("")}
      </div>
      <label class="check"><input type="checkbox" id="skipRefundable"${S().skipRefundable !== false ? " checked" : ""}>
        <span><b>${esc(t("what.refund"))}</b><small>${esc(t("what.refundHint"))}</small></span></label>
      </div>${bar({ nextOk: mode === "all" || ids.length > 0 })}`;
  },

  options() {
    const tg = (key, id, on) => `<label class="toggle"><b>${esc(t(`options.${key}`))}</b><input type="checkbox" id="${id}"${on ? " checked" : ""}><small>${esc(t(`options.${key}Hint`))}</small></label>`;
    return `<div class="step__body">${head("options")}
      <div class="toggles">
        <label class="toggle toggle--fixed"><b>${esc(t("options.play"))}</b><input type="checkbox" checked disabled><small>${esc(t("options.playHint"))}</small></label>
        ${tg("awake", "keepAwake", !!S().keepAwake)}
        ${tg("autostart", "autostart", !!S().autostart)}
        ${tg("tray", "minimizeToTray", S().minimizeToTray !== false)}
      </div></div>${bar()}`;
  },

  start() {
    const s = S();
    const games = s.farmMode === "chosen" ? t("start.gamesChosen", { n: parseAppIds(s.chosenText).length }) : t("start.gamesAll");
    return `<div class="step__body">${head("start")}
      <dl class="summary">
        <div><dt>${esc(t("start.account"))}</dt><dd>${esc(state.signin.bot?.Nickname || s.login || "—")}</dd></div>
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
const signIn = new SignIn((st) => {
  state.signin = st;
  if (st.kind === "ok") state.loggedOnSince = Date.now();
  if (state.mode === "wizard") renderStep();
});

async function onSignInSubmit(form) {
  const login = form.login.value.trim();
  const password = form.password.value;
  if (!login || !password) return;
  await saveSettings({ login });
  try {
    await bootEngine();
    if (state.signin.kind === "password") await signIn.submitPassword(password);
    else await signIn.begin(S(), password);
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
  try {
    await saveSettings({ wizardDone: true });
    try {
      await api.setAutostart(!!S().autostart);
    } catch (e) {
      console.warn("autostart", e);
    }
    await restartEngineIfNeeded();
    await saveBot(botConfig(S())); // farming no longer paused by default
    // ASF reloads the bot after a config change; wait for it before touching its queue.
    const ids = S().farmMode === "chosen" ? parseAppIds(S().chosenText) : [];
    if (ids.length) {
      for (let i = 0; i < 20 && !(await getBot()); i++) await new Promise((r) => setTimeout(r, 750));
      await queueGames(ids);
    }
    await startBot();
    state.mode = "dash";
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
  $("#view").innerHTML = `
    <div class="dash">
      <section class="panel dash__head" id="dHead"></section>
      <section class="panel attention" id="dInput" hidden></section>
      <div class="dash__grid">
        <div style="display:grid;gap:18px;align-content:start">
          <section class="panel now" id="dNow"></section>
          <section class="panel stats" id="dStats"></section>
          <section class="panel queue" id="dQueue"></section>
        </div>
        <section class="panel level" id="dLevel">
          <h2 class="title title--sm"><span>${esc(t("dash.levelTitle1"))}</span><span class="accent">${esc(t("dash.levelTitle2"))}</span></h2>
          <p class="lead">${esc(t("dash.levelLead"))}</p>
          <label class="level__row"><span>${esc(t("dash.levelYour"))}</span><input class="input" type="number" min="0" max="5000" id="lvl" value="${esc(S().level ?? 0)}"></label>
          <div class="bar"><i id="lvlBar"></i></div>
          <div class="level__meta"><span id="lvlA"></span><span id="lvlB"></span></div>
          <button class="btn btn--primary" data-href="${SITE}">${esc(t("dash.site"))}</button>
        </section>
      </div>
    </div>`;
  updateLevel();
  updateDash();
}

function updateLevel() {
  const r = nextSlot($("#lvl")?.value ?? S().level ?? 0);
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

function updateDash() {
  if (!$("#dHead")) return;
  const b = state.bot;
  const status = botStatus(b, { loggedOnSince: state.loggedOnSince });
  const cf = b?.CardsFarmer || {};
  const toFarm = cf.GamesToFarm || [];
  const current = cf.CurrentGamesFarming?.[0] || null;
  const running = b?.KeepRunning;

  $("#dHead").innerHTML = `
    <div class="who-inline"><img class="avatar" src="${esc(avatarUrl(b?.AvatarHash))}" alt="">
      <div><b>${esc(b?.Nickname || S().login || "")}</b><div class="status" data-s="${status}"><i></i>${esc(t(`dash.status_${status}`))}</div></div></div>
    <div class="actions">
      ${running && b?.IsConnectedAndLoggedOn ? (cf.Paused
        ? `<button class="btn btn--primary" data-action="resume">${esc(t("dash.resume"))}</button>`
        : `<button class="btn" data-action="pause">${esc(t("dash.pause"))}</button>`) : ""}
      ${running ? `<button class="btn" data-action="stop">${esc(t("dash.stop"))}</button>`
        : `<button class="btn btn--primary" data-action="start-bot">${esc(t("dash.startBot"))}</button>`}
    </div>`;

  const inputBox = $("#dInput");
  const need = b?.RequiredInput;
  if (need === INPUT.Password) {
    if (inputBox.dataset.need !== "2") {
      inputBox.innerHTML = `<form id="dashPassword"><p class="label">${esc(t("dash.needPassword"))}</p>
        <label class="field"><span>${esc(t("signin.password"))}</span><input class="input" type="password" name="password" required></label>
        <button class="btn btn--primary" style="margin-top:12px" type="submit">${esc(t("dash.passwordSubmit"))}</button></form>
        <div class="note">${esc(t("signin.privacy"))}</div>`;
    }
  } else if ([INPUT.SteamGuard, INPUT.TwoFactor, INPUT.Parental].includes(need)) {
    const kind = { [INPUT.SteamGuard]: "email", [INPUT.TwoFactor]: "app", [INPUT.Parental]: "parental" }[need];
    if (inputBox.dataset.need !== String(need)) inputBox.innerHTML = guardBox(kind, state.dashInputError);
  } else {
    inputBox.innerHTML = "";
  }
  inputBox.dataset.need = String(need || 0);
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

async function submitDashInput(type, value) {
  try {
    await sendInput(type, value);
    state.dashInputError = null;
    await startBot();
  } catch {
    state.dashInputError = "code";
    $("#dInput").dataset.need = "";
  }
  pollOnce();
}

let pollTimer = null;
async function pollOnce() {
  const b = await getBot();
  state.bot = b;
  if (b?.IsConnectedAndLoggedOn) state.loggedOnSince ||= Date.now();
  else state.loggedOnSince = 0;
  if (state.mode === "dash") updateDash();
}
function startPolling() {
  clearInterval(pollTimer);
  pollOnce();
  pollTimer = setInterval(pollOnce, 3000);
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
  if (a === "next") {
    await persistStep();
    goto(state.step + 1);
  } else if (a === "back") goto(state.step - 1);
  else if (a === "goto") goto(Number(el.dataset.step));
  else if (a === "finish") finish(el);
  else if (a === "signin-reset") {
    signIn.cancel();
    await stopBot();
    state.signin = { kind: "form" };
    state.maxStep = state.step;
    renderWizard();
  } else if (a === "engine-retry") bootEngine().catch(() => {});
  else if (a === "pause") { await pauseFarming(); pollOnce(); }
  else if (a === "resume") { await resumeFarming(); pollOnce(); }
  else if (a === "stop") { await stopBot(); pollOnce(); }
  else if (a === "start-bot") { await startBot(); pollOnce(); }
  else if (a === "farm-next") { await farmNext(el.dataset.app).catch(console.warn); pollOnce(); }
  else if (a === "skip") {
    if (confirm(t("dash.skipConfirm", { name: el.dataset.name }))) {
      await skipGame(el.dataset.app).catch(console.warn);
      pollOnce();
    }
  }
});

$("#btnSettings").addEventListener("click", () => {
  clearInterval(pollTimer);
  state.mode = "wizard";
  state.signin = state.bot?.IsConnectedAndLoggedOn ? { kind: "ok", bot: state.bot } : { kind: "form" };
  state.maxStep = STEPS.length - 1;
  state.step = 2;
  render();
});
$("#btnAbout").addEventListener("click", () => $("#about").showModal());
$("#lang").addEventListener("change", async (e) => {
  setLang(e.target.value);
  await saveSettings({ lang: e.target.value });
  render();
});

document.addEventListener("submit", (e) => {
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
    saveSettings({ level: Number(el.value) || 0 });
  } else if (el.id === "chosenText") {
    state.settings.chosenText = el.value;
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
    state.settings[el.name] = el.value;
    renderStep();
  } else if (el.id === "skipRefundable") {
    state.settings.skipRefundable = el.checked;
  } else if (["keepAwake", "autostart", "minimizeToTray"].includes(el.id)) {
    state.settings[el.id] = el.checked;
  }
});

/** Saves the current step's answers before moving on. */
async function persistStep() {
  const s = state.settings;
  const name = STEPS[state.step];
  if (name === "what") {
    await saveSettings({ farmMode: s.farmMode || "all", order: s.order || "fast", chosenText: s.chosenText || "", skipRefundable: s.skipRefundable !== false });
  } else if (name === "options") {
    await saveSettings({ keepAwake: !!s.keepAwake, autostart: !!s.autostart, minimizeToTray: s.minimizeToTray !== false });
  }
}

// ------------------------------------------------------------------ boot
(async function main() {
  state.settings = await api.settingsGet();
  setLang(detectLang(S().lang));
  if (S().wizardDone) state.mode = "dash";
  render();
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

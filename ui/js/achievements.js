// "Achievements" screen (src-tauri/src/achievements.rs does the Steam side, ported from Steam Achievement Manager).
// Left: the games whose achievement list Steam keeps on this PC, a search and "open by appid". Right: the chosen game's
// achievements; ticks are collected and applied in one go. Before every call to Steam the farming of the account that is
// signed in to the Steam client is paused for those few seconds (Steam sees the game as running meanwhile) and resumed.

const ICON_CDN = "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps";

/** ASF's `owns <bot> regex/.*` answer -> [{appid, name}]. Lines read "<bot> <words in ASF's language>: app/ID | Name". */
export function parseOwned(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/(?:^|[\s:])(?:app\/)?(\d{1,10}) \| (.+)$/);
    if (m && !/sub\/\d+ \|/.test(line)) out.push({ appid: Number(m[1]), name: m[2].trim() });
  }
  return out;
}

/** scmfarm://letters?w=WORD&g=APPID:HASH.HASH,APPID:HASH -> {word, games: [{appid, hashes}]} or null.
 * The site's "Achievement letters" tool sends the icons it chose (40-hex icon hashes); every part is checked here. */
export function parseLetters(link) {
  let url;
  try { url = new URL(String(link || "")); } catch { return null; }
  if (url.protocol !== "scmfarm:" || (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase() !== "letters") return null;
  const word = (url.searchParams.get("w") || "").slice(0, 21);
  const games = [];
  let icons = 0;
  for (const part of (url.searchParams.get("g") || "").split(",")) {
    const m = part.match(/^(\d{1,10}):([0-9a-f]{40}(?:\.[0-9a-f]{40})*)$/i);
    if (!m) return null;
    const hashes = [...new Set(m[2].toLowerCase().split("."))];
    icons += hashes.length;
    games.push({ appid: Number(m[1]), hashes });
  }
  return games.length && games.length <= 21 && icons <= 21 ? { word, games } : null;
}

async function owned(bot, ask) {
  return parseOwned(await ask(bot));
}

export function mountAchievements(ctx) {
  const { view, t, esc, api, lang, settings, saveSettings, ask, bots, hold, release, ownedGames, letters, lettersClose, openSite } = ctx;
  const st = { games: null, gamesErr: null, steam: null, query: "", appid: null, data: null, loading: false, err: null,
    changes: new Map(), filter: "all", find: "", note: null, busy: false };

  view.innerHTML = `
    <div class="ach">
      <aside class="panel ach__games">
        <div class="ach__head"><b>${esc(t("ach.games"))}</b><button class="btn btn--sm" data-ach="reload">${esc(t("ach.reload"))}</button></div>
        <input class="input" id="achQuery" placeholder="${esc(t("ach.search"))}" autocomplete="off" spellcheck="false">
        <div class="ach__list" id="achList"></div>
        <form class="ach__byid" id="achById"><input class="input" name="appid" inputmode="numeric" pattern="[0-9]*" placeholder="${esc(t("ach.byId"))}">
          <button class="btn btn--sm" type="submit">${esc(t("ach.openId"))}</button></form>
        <small class="ach__credit">${esc(t("ach.credit"))}</small>
      </aside>
      <section class="panel ach__main" id="achMain"></section>
    </div>`;

  const $ = (sel) => view.querySelector(sel);

  // ------------------------------------------------------------ the Steam client and the farm
  /** The SCMFARM account that is signed in to the Steam client right now (its farming must step aside), or null. */
  function sameAccount() {
    const user = st.steam?.user;
    if (!user) return null;
    for (const [bot, b] of Object.entries(bots() || {})) {
      if (b?.SteamID && Number(b.SteamID) === Number(user)) return bot;
    }
    return null;
  }
  async function aroundSteam(job) {
    st.steam = await api.achSteam().catch(() => null);
    if (!st.steam?.installed) throw "noSteam";
    if (!st.steam.user) throw "steam";
    const bot = sameAccount();
    const b = bot ? bots()[bot] : null;
    const farming = !!(b?.KeepRunning && b?.IsConnectedAndLoggedOn && !b?.CardsFarmer?.Paused);
    st.note = farming ? t("ach.paused") : bot ? null : t("ach.otherAccount");
    paintMain();
    if (farming) await hold(bot);
    try {
      return await job();
    } finally {
      if (farming) await release(bot);
    }
  }
  function errorText(e) {
    const code = String(e?.message || e || "");
    if (code === "noSteam") return t("ach.noSteam");
    if (["steam", "owned", "timeout", "schema", "load"].includes(code)) return t(`ach.e_${code}`);
    return t("ach.e_other", { e: code });
  }

  // ------------------------------------------------------------ games
  async function loadGames() {
    st.games = null;
    st.gamesErr = null;
    paintGames();
    st.steam = await api.achSteam().catch(() => null);
    let local = [];
    try {
      local = st.steam?.installed ? await api.achGames(lang()) : [];
    } catch (e) {
      st.gamesErr = errorText(e);
    }
    // Steam keeps achievement lists only of games run on this PC, so the full list comes from ASF: every game the
    // account owns (it is signed in as that account anyway). Games without a stored list show no count yet.
    const byId = new Map(local.map((g) => [g.appid, g]));
    const sorted = () => [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    st.games = sorted();
    paintGames();
    if (!st.appid) paintMain();
    // Right after SCMFARM starts ASF may still be signing in: wait for it (up to two minutes) instead of giving up.
    const run = (st.gamesRun = (st.gamesRun || 0) + 1);
    st.ownedState = "wait";
    paintGames();
    for (let i = 0; i < 60 && run === st.gamesRun && view.isConnected; i++) {
      const bot = sameAccount();
      if (bot && bots()[bot]?.IsConnectedAndLoggedOn) {
        const list = await owned(bot, ownedGames).catch(() => null);
        if (list?.length && run === st.gamesRun) {
          for (const g of list) if (!byId.has(g.appid)) byId.set(g.appid, { appid: g.appid, name: g.name, count: null });
          st.games = sorted();
          st.ownedState = "ok";
          paintGames();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (run === st.gamesRun) { st.ownedState = "local"; paintGames(); }
  }
  function paintGames() {
    const list = $("#achList");
    if (!st.games) { list.innerHTML = `<p class="ach__empty"><span class="ach-spin"></span></p>`; return; }
    if (!st.steam?.installed) { list.innerHTML = `<p class="ach__empty">${esc(t("ach.noSteam"))}</p>`; return; }
    const q = st.query.trim().toLowerCase();
    const status = st.ownedState === "wait" ? `<p class="ach__status"><span class="ach-spin"></span>${esc(t("ach.ownedWait"))}</p>`
      : st.ownedState === "local" ? `<p class="ach__status">${esc(t("ach.ownedLocal"))}</p>` : "";
    const shown = st.games.filter((g) => !q || g.name.toLowerCase().includes(q) || String(g.appid) === q);
    list.innerHTML = status + (shown.length
      ? shown.map((g) => `<button type="button" class="ach__game${g.appid === st.appid ? " is-on" : ""}" data-ach="game" data-app="${g.appid}">
          <img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/capsule_184x69.jpg" alt="" loading="lazy">
          <span><b>${esc(g.name || g.appid)}</b><small>${g.count == null ? "" : esc(t("ach.count", { n: g.count }))}</small></span></button>`).join("")
      : `<p class="ach__empty">${esc(st.gamesErr || (st.games.length ? "—" : t("ach.noGames")))}</p>`);
  }

  // ------------------------------------------------------------ one game
  async function openGame(appid) {
    if (st.busy || !appid) return;
    st.appid = appid;
    st.data = null;
    st.err = null;
    st.changes.clear();
    st.loading = true;
    paintGames();
    paintMain();
    try {
      st.data = await aroundSteam(() => api.achLoad(appid, lang()));
      if (st.games && !st.games.some((g) => g.appid === appid)) loadGames();   // Steam has just stored its schema
    } catch (e) {
      st.err = errorText(e);
    }
    st.loading = false;
    paintMain();
  }

  function wanted(a) { return st.changes.has(a.id) ? st.changes.get(a.id) : a.achieved; }
  function toggle(id) {
    const a = st.data?.achievements.find((x) => x.id === id);
    if (!a || a.protected || st.busy) return;
    const next = !wanted(a);
    if (next === a.achieved) st.changes.delete(id); else st.changes.set(id, next);
    paintMain();
  }

  async function apply() {
    if (!st.changes.size || st.busy) return;
    if (!settings().achWarned) {
      if (!(await ask(t("ach.warnTitle"), t("ach.warnText"), t("ach.warnOk")))) return;
      await saveSettings({ achWarned: true });
    }
    const set = [...st.changes].filter(([, on]) => on).map(([id]) => id);
    const clear = [...st.changes].filter(([, on]) => !on).map(([id]) => id);
    st.busy = true;
    st.err = null;
    paintMain();
    try {
      const out = await aroundSteam(() => api.achApply(st.appid, set, clear, lang()));
      const failed = out.stored?.failed?.length || 0;
      st.data = out;
      st.changes.clear();
      st.note = failed ? t("ach.partly", { n: failed }) : t("ach.applied", { n: set.length + clear.length });
    } catch (e) {
      st.err = errorText(e);
    }
    st.busy = false;
    paintMain();
  }

  function fmtDate(sec) {
    try { return new Date(sec * 1000).toLocaleDateString(lang()); } catch { return ""; }
  }

  // ------------------------------------------------------------ "Achievement letters" from the site
  st.letters = letters ? { ...letters, status: {}, running: false, done: false } : null;
  function lettersPanel() {
    const L = st.letters;
    const n = L.games.reduce((sum, g) => sum + g.hashes.length, 0);
    const rows = L.games.map((g) => {
      const name = st.games?.find((x) => x.appid === g.appid)?.name || `app ${g.appid}`;
      const s = L.status[g.appid];
      const text = !s ? t("ach.lettersWait") : s.err ? s.err : s.running ? t("ach.loading")
        : [s.done ? t("ach.lettersDone", { n: s.done }) : "", s.have ? t("ach.lettersHave", { n: s.have }) : "", s.missing ? t("ach.lettersMissing", { n: s.missing }) : ""].filter(Boolean).join(" · ");
      return `<li><b>${esc(name)}</b><span class="${s?.err ? "error-text" : ""}">${s?.running ? '<span class="ach-spin"></span>' : ""}${esc(text)}</span></li>`;
    }).join("");
    return `<div class="ach__letters"><h2>${esc(t("ach.lettersTitle", { w: L.word || "…" }))}</h2>
      <p>${esc(t("ach.lettersLead", { n, g: L.games.length }))}</p><ul>${rows}</ul>
      ${L.done ? (Object.values(L.status).some((s) => s.done || s.have)
        ? `<p class="ach__hint">${esc(t("ach.lettersNext"))}</p><button class="btn btn--primary" data-ach="letters-site">${esc(t("ach.lettersSite"))}</button>` : "")
        : `<button class="btn btn--primary" data-ach="letters-go" ${L.running ? "disabled" : ""}>${L.running ? `<span class="ach-spin"></span>` : ""}${esc(t("ach.lettersGo"))}</button>`}
      <button class="btn" data-ach="letters-close" ${L.running ? "disabled" : ""}>${esc(t("ach.lettersClose"))}</button></div>`;
  }
  async function runLetters() {
    const L = st.letters;
    if (!L || L.running) return;
    if (!settings().achWarned) {
      if (!(await ask(t("ach.warnTitle"), t("ach.warnText"), t("ach.warnOk")))) return;
      await saveSettings({ achWarned: true });
    }
    L.running = true;
    for (const g of L.games) {
      L.status[g.appid] = { running: true };
      paintMain();
      try {
        const data = await aroundSteam(() => api.achLoad(g.appid, lang()));
        const strip = (icon) => String(icon || "").toLowerCase().replace(/\.[a-z]+$/, "");
        const hits = data.achievements.filter((a) => g.hashes.includes(strip(a.icon)) || g.hashes.includes(strip(a.iconGray)));
        const set = hits.filter((a) => !a.achieved && !a.protected).map((a) => a.id);
        const status = { have: hits.filter((a) => a.achieved).length, missing: g.hashes.length - hits.length };
        if (set.length) {
          const out = await aroundSteam(() => api.achApply(g.appid, set, [], lang()));
          status.done = set.length - (out.stored?.failed?.length || 0);
        }
        L.status[g.appid] = status;
      } catch (e) {
        L.status[g.appid] = { err: errorText(e) };
      }
      paintMain();
    }
    L.running = false;
    L.done = true;
    paintMain();
  }

  function paintMain() {
    const main = $("#achMain");
    if (st.letters && !st.appid) {
      main.innerHTML = lettersPanel();
      return;
    }
    if (!st.appid) {
      main.innerHTML = `<div class="ach__intro"><h2>${esc(t("ach.title"))}</h2><p>${esc(t("ach.lead"))}</p>
        <p class="ach__hint">${esc(st.steam && !st.steam.user && st.steam.installed ? t("ach.steamOff") : t("ach.pick"))}</p></div>`;
      return;
    }
    const game = st.data?.game || st.games?.find((g) => g.appid === st.appid)?.name || st.appid;
    const head = `<div class="ach__top"><img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${st.appid}/header.jpg" alt="">
      <div><h2>${esc(game)}</h2>${st.data ? progress() : ""}</div></div>`;
    const note = st.note ? `<p class="ach__note">${esc(st.note)}</p>` : "";
    if (st.loading || (!st.data && !st.err)) {
      main.innerHTML = `${head}${note}<p class="ach__wait"><span class="ach-spin"></span>${esc(t("ach.loading"))}</p>`;
      return;
    }
    if (!st.data) {
      main.innerHTML = `${head}${note}<p class="error">${esc(st.err)}</p>`;
      return;
    }
    const q = st.find.trim().toLowerCase();
    const items = st.data.achievements.filter((a) => {
      const on = wanted(a);
      if (st.filter === "locked" && on) return false;
      if (st.filter === "unlocked" && !on) return false;
      return !q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q);
    });
    const filters = ["all", "locked", "unlocked"].map((f) =>
      `<button type="button" class="ach__segbtn${st.filter === f ? " is-on" : ""}" data-ach="filter" data-f="${f}">${esc(t(`ach.${f}`))}</button>`).join("");
    const rows = items.map((a) => {
      const on = wanted(a), changed = st.changes.has(a.id);
      const icon = (on ? a.icon : a.iconGray) || a.icon;
      const meta = [a.percent != null ? t("ach.global", { p: a.percent.toFixed(1) }) : "", a.achieved && a.unlocked && !changed ? t("ach.unlockedOn", { date: fmtDate(a.unlocked) }) : ""].filter(Boolean).join(" · ");
      return `<label class="ach__row${on ? " is-on" : ""}${changed ? " is-changed" : ""}${a.protected ? " is-locked" : ""}" ${a.protected ? `title="${esc(t("ach.protected"))}"` : ""}>
        <input type="checkbox" data-ach-toggle="${esc(a.id)}" ${on ? "checked" : ""} ${a.protected || st.busy ? "disabled" : ""}>
        ${icon ? `<img src="${ICON_CDN}/${st.appid}/${esc(icon)}" alt="" loading="lazy">` : `<span class="ach__ph">★</span>`}
        <span class="ach__text"><b>${esc(a.name)}</b><small>${esc(a.desc || (a.hidden ? t("ach.hidden") : ""))}</small>
          <em>${a.protected ? `🔒 ${esc(t("ach.protected"))}` : a.hidden && a.desc ? esc(t("ach.hidden")) : ""}${meta ? `<i>${esc(meta)}</i>` : ""}</em></span>
        <span class="ach__box" aria-hidden="true"></span></label>`;
    }).join("");
    const lockedFree = st.data.achievements.some((a) => !a.protected && !wanted(a));
    main.innerHTML = `${head}${note}${st.err ? `<p class="error">${esc(st.err)}</p>` : ""}
      <div class="ach__tools"><div class="ach__seg">${filters}</div>
        <input class="input" id="achFind" placeholder="${esc(t("ach.searchAch"))}" value="${esc(st.find)}" autocomplete="off" spellcheck="false">
        ${lockedFree ? `<button class="btn btn--sm" data-ach="all-locked" ${st.busy ? "disabled" : ""}>${esc(t("ach.selectLocked"))}</button>` : ""}</div>
      <div class="ach__rows">${rows || `<p class="ach__empty">—</p>`}</div>
      <div class="ach__bar">
        ${st.changes.size ? `<button class="btn" data-ach="undo" ${st.busy ? "disabled" : ""}>${esc(t("ach.undo"))}</button>` : "<span></span>"}
        <button class="btn btn--primary" data-ach="apply" ${!st.changes.size || st.busy ? "disabled" : ""}>${st.busy ? `<span class="ach-spin"></span>${esc(t("ach.applying"))}` : esc(t("ach.apply", { n: st.changes.size }))}</button>
      </div>`;
    const find = $("#achFind");
    find?.addEventListener("input", () => {
      st.find = find.value;
      const pos = find.selectionStart;
      paintMain();
      const again = $("#achFind"); again.focus(); again.setSelectionRange(pos, pos);
    });
  }
  function progress() {
    const list = st.data.achievements, done = list.filter((a) => a.achieved).length;
    return `<div class="ach__progress"><span>${esc(t("ach.progress", { a: done, b: list.length }))}</span>
      <div class="bar"><i style="width:${list.length ? (done / list.length) * 100 : 0}%"></i></div></div>`;
  }

  // ------------------------------------------------------------ events
  view.addEventListener("click", (e) => {
    const el = e.target.closest("[data-ach]");
    if (!el) return;
    const what = el.dataset.ach;
    if (what === "game") openGame(Number(el.dataset.app));
    else if (what === "reload") { loadGames(); if (st.appid) openGame(st.appid); }
    else if (what === "filter") { st.filter = el.dataset.f; paintMain(); }
    else if (what === "undo") { st.changes.clear(); paintMain(); }
    else if (what === "letters-go") runLetters();
    else if (what === "letters-close") { st.letters = null; lettersClose?.(); paintMain(); }
    else if (what === "letters-site") openSite();
    else if (what === "apply") apply();
    else if (what === "all-locked") {
      st.data.achievements.forEach((a) => { if (!a.protected && !a.achieved) st.changes.set(a.id, true); else if (!a.protected && st.changes.get(a.id) === false) st.changes.delete(a.id); });
      paintMain();
    }
  });
  view.addEventListener("change", (e) => {
    const id = e.target.dataset?.achToggle;
    if (id != null) toggle(id);
  });
  $("#achQuery").addEventListener("input", (e) => { st.query = e.target.value; paintGames(); });
  $("#achById").addEventListener("submit", (e) => {
    e.preventDefault();
    const appid = Number(new FormData(e.target).get("appid"));
    if (appid > 0) openGame(appid);
  });

  paintMain();
  loadGames();
}

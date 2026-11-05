// "Free right now" strip on the farm dashboard (showcasemaker.com /api/scmfarm/free, src-tauri extras.rs free_get).
// Steam items that are free to keep are claimed through ASF (`addlicense <bots> sub/<id>`) on every signed-in account,
// by a button or, with "Claim by myself" on, as soon as they appear. Key giveaways on other sites open in the browser.
// New items are announced once (Windows / Telegram, like the other notifications).

const EVERY = 30 * 60 * 1000;

export function createFree(ctx) {
  const { t, esc, api, settings, saveSettings, onlineBots, command, notify, openExternal } = ctx;
  const st = { data: null, busy: new Set(), err: null, timer: null };

  const claimed = () => settings().freeClaimed || {};
  const keyOf = (item, kind) => (kind === "keys" ? `k${item.id}` : `s${item.subid}`);

  async function claim(item, auto) {
    const bots = onlineBots();
    if (!bots.length || !item.subid || st.busy.has(item.subid)) return;
    st.busy.add(item.subid);
    st.err = null;
    paint();
    try {
      await command(`addlicense ${bots.join(",")} sub/${item.subid}`);
      await saveSettings({ freeClaimed: { ...claimed(), [item.subid]: Math.floor(Date.now() / 1000) } });
      if (auto) notify(t("free.claimedTitle"), t("free.claimedBody", { name: item.name, n: bots.length }));
    } catch (e) {
      st.err = t("free.err", { e: String(e?.message || e) });
    }
    st.busy.delete(item.subid);
    paint();
  }

  async function load() {
    if (settings().feed === false) { st.data = null; paint(); return; }
    const data = await api.freeGet().catch(() => null);
    if (!data) return;
    st.data = data;
    // Announce what is new since the last look (the first look only remembers, so an update does not flood).
    const seen = settings().freeSeen;
    const now = [...data.steam.map((i) => keyOf(i, "steam")), ...data.keys.map((i) => keyOf(i, "keys"))];
    const fresh = Array.isArray(seen) ? [...data.steam.map((i) => ["steam", i]), ...data.keys.map((i) => ["keys", i])].filter(([k, i]) => !seen.includes(keyOf(i, k))) : [];
    if (!Array.isArray(seen) || fresh.length) await saveSettings({ freeSeen: [...new Set([...(seen || []), ...now])].slice(-300) });
    for (const [kind, item] of fresh) {
      if (!(kind === "steam" && settings().freeAuto)) notify(t("free.newTitle"), t(kind === "keys" ? "free.newKey" : "free.newBody", { name: item.name }));
    }
    // With "Claim by myself" on, everything free and not taken yet is claimed (again later if no account was online).
    if (settings().freeAuto) for (const item of data.steam) if (!claimed()[item.subid]) await claim(item, true);
    paint();
  }

  function start() {
    clearInterval(st.timer);
    load();
    setTimeout(load, 2 * 60 * 1000);   // right after start ASF is still signing in: look again once it is
    st.timer = setInterval(load, EVERY);
  }

  function worth(item) {
    if (typeof item.worth === "number" && item.worth > 0) return `$${(item.worth / 100).toFixed(2)}`;
    return item.worth && item.worth !== "N/A" ? String(item.worth) : "";
  }

  function paint() {
    const box = document.getElementById("dFree");
    if (!box) return;
    const d = st.data;
    const steam = d?.steam || [], keys = d?.keys || [];
    box.hidden = !steam.length && !keys.length;
    if (box.hidden) return;
    const done = claimed();
    const row = (item, kind) => {
      const was = worth(item);
      const tag = item.kind === "dlc" ? t("free.dlc") : "";
      let action;
      if (kind === "keys") action = `<button class="btn btn--sm" data-free-open="${esc(item.url)}">${esc(t("free.open"))}</button>`;
      else if (done[item.subid]) action = `<span class="free__done">✓ ${esc(t("free.claimed"))}</span>`;
      else if (st.busy.has(item.subid)) action = `<span class="free__done"><span class="ach-spin"></span>${esc(t("free.claiming"))}</span>`;
      else action = `<button class="btn btn--sm btn--primary" data-free-claim="${item.subid}" ${onlineBots().length ? "" : "disabled"}>${esc(t("free.claim"))}</button>`;
      return `<div class="free__item">
        <span class="free__name"><b title="${esc(item.name)}">${esc(item.name)}</b>
          <small>${[kind === "keys" ? t("free.keys") : t("free.steam"), tag, was && t("free.worth", { p: was }), item.ends ? t("free.until", { d: item.ends }) : ""].filter(Boolean).map(esc).join(" · ")}</small></span>
        ${action}</div>`;
    };
    box.innerHTML = `<div class="free__head"><b>🎁 ${esc(t("free.title"))}</b>
        <label class="free__auto"><input type="checkbox" data-free-auto ${settings().freeAuto ? "checked" : ""}><span>${esc(t("free.auto"))}</span></label></div>
      <div class="free__list">${[...steam.map((i) => row(i, "steam")), ...keys.slice(0, 3).map((i) => row(i, "keys"))].join("")}</div>
      ${st.err ? `<p class="free__err">${esc(st.err)}</p>` : ""}`;
  }

  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-free-claim]");
    if (c) {
      const item = st.data?.steam.find((i) => String(i.subid) === c.dataset.freeClaim);
      if (item) claim(item, false);
      return;
    }
    const o = e.target.closest("[data-free-open]");
    if (o) openExternal(o.dataset.freeOpen);
  });
  document.addEventListener("change", async (e) => {
    if (!e.target.matches?.("[data-free-auto]")) return;
    await saveSettings({ freeAuto: e.target.checked });
    // Turned on: claim what is free right now and not taken yet.
    if (e.target.checked) for (const item of st.data?.steam || []) if (!claimed()[item.subid]) await claim(item, true);
  });

  return { start, load, paint };
}

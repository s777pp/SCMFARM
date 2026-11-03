// UI strings. en and ru are complete; the other site languages are registered so adding one is a single
// file in locales/ plus `ready: true` here. Missing keys always fall back to English.
import en from "./locales/en.js";
import ru from "./locales/ru.js";

export const LANGS = [
  { code: "en", name: "English", ready: true },
  { code: "ru", name: "Русский", ready: true },
  { code: "de", name: "Deutsch", ready: false },
  { code: "tr", name: "Türkçe", ready: false },
  { code: "fr", name: "Français", ready: false },
  { code: "uk", name: "Українська", ready: false },
  { code: "es", name: "Español", ready: false },
  { code: "pt", name: "Português", ready: false },
];

const DICTS = { en, ru };
let current = "en";

export function detectLang(saved) {
  const ok = (c) => LANGS.some((l) => l.code === c && l.ready);
  if (saved && ok(saved)) return saved;
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  if (ok(nav)) return nav;
  // Belarusian / Kazakh / Ukrainian users get Russian until their language is ready.
  if (["be", "kk", "uk"].includes(nav)) return "ru";
  return "en";
}

export function setLang(code) {
  current = DICTS[code] ? code : "en";
  document.documentElement.lang = current;
}

export function getLang() {
  return current;
}

function lookup(dict, key) {
  return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

export function t(key, vars) {
  let s = lookup(DICTS[current], key);
  if (s === undefined) s = lookup(en, key);
  if (s === undefined) return key;
  if (typeof s !== "string" || !vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Fills every [data-i18n] element under `root`. */
export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

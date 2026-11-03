// UI strings in the eight languages of showcasemaker.com, one file per language in locales/.
// Missing keys always fall back to English.
import en from "./locales/en.js";
import ru from "./locales/ru.js";
import de from "./locales/de.js";
import tr from "./locales/tr.js";
import fr from "./locales/fr.js";
import uk from "./locales/uk.js";
import es from "./locales/es.js";
import pt from "./locales/pt.js";

export const LANGS = [
  { code: "en", name: "English", ready: true },
  { code: "ru", name: "Русский", ready: true },
  { code: "de", name: "Deutsch", ready: true },
  { code: "tr", name: "Türkçe", ready: true },
  { code: "fr", name: "Français", ready: true },
  { code: "uk", name: "Українська", ready: true },
  { code: "es", name: "Español", ready: true },
  { code: "pt", name: "Português", ready: true },
];

const DICTS = { en, ru, de, tr, fr, uk, es, pt };
let current = "en";

export function detectLang(saved) {
  const ok = (c) => LANGS.some((l) => l.code === c && l.ready);
  if (saved && ok(saved)) return saved;
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  if (ok(nav)) return nav;
  // Belarusian and Kazakh users get Russian.
  if (["be", "kk"].includes(nav)) return "ru";
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

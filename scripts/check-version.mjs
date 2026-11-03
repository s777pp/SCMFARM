// Fails if package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml disagree on name/version,
// or if a release tag (v1.2.3) does not match them. Keeps every build's product name and version consistent.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versions = { "package.json": pkg.version, "tauri.conf.json": conf.version, "Cargo.toml": cargo };
const tag = (process.env.GITHUB_REF || "").match(/^refs\/tags\/v(.+)$/)?.[1];
if (tag) versions["git tag"] = tag;

const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  console.error("Version mismatch:", versions);
  process.exit(1);
}
if (conf.productName !== "SCMFARM") {
  console.error(`productName must be "SCMFARM", got "${conf.productName}"`);
  process.exit(1);
}
console.log(`SCMFARM ${pkg.version}: versions consistent`, versions);

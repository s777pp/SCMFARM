// Writes latest.json for a release: version, SHA-256 of SCMFARM.exe and an ed25519 signature over
// "SCMFARM <version> <sha256>". The app (src-tauri/src/updater.rs) installs an update only when this signature
// matches its built-in public key, so a hacked mirror cannot push a fake exe.
//
//   RELEASE_KEY="<PEM of the private key>" node scripts/sign-release.mjs src-tauri/target/release/SCMFARM.exe latest.json "notes"
//
// The private key lives only in the GitHub secret RELEASE_KEY (and the owner's offline copy), never in the repo.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [exe, out = "latest.json", notes = ""] = process.argv.slice(2);
const pem = process.env.RELEASE_KEY;
if (!exe || !pem) {
  console.error("usage: RELEASE_KEY=<pem> node scripts/sign-release.mjs <SCMFARM.exe> [latest.json] [notes]");
  process.exit(1);
}
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;
const data = readFileSync(exe);
const sha256 = createHash("sha256").update(data).digest("hex");
const signature = sign(null, Buffer.from(`SCMFARM ${version} ${sha256}`), createPrivateKey(pem)).toString("hex");
const manifest = { version, file: "SCMFARM.exe", size: data.length, sha256, signature, notes, date: new Date().toISOString() };
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`SCMFARM ${version}: ${data.length} bytes, sha256 ${sha256}`);

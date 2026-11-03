//! Self-update of the single SCMFARM.exe (there is no installer).
//!
//! On start the UI calls `update_check`. When the site lists a newer release, `update_install` downloads it next to
//! the running exe, checks its SHA-256 and the release signature (ed25519 over "SCMFARM <version> <sha256>", made in
//! CI by scripts/sign-release.mjs with the key whose public half is `RELEASE_PUBLIC_KEY`), swaps the files (Windows
//! lets a running exe be renamed, not deleted) and starts the new exe, which deletes the old file once this process
//! has exited. The manifest comes from showcasemaker.com, which mirrors the GitHub release (see README "Releases").

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const MANIFEST_URL: &str = "https://showcasemaker.com/api/scmfarm/latest";
/// Public half of the release signing key (private half: GitHub secret `RELEASE_KEY`, never in the repo).
const RELEASE_PUBLIC_KEY: &str = "bf7b990cb622f9ba961e4f933f70646d1f798eb62215b4a6ff2958306be53451";

#[derive(Deserialize)]
struct Manifest {
    version: String,
    url: String,
    sha256: String,
    signature: String,
    #[serde(default)]
    notes: Option<String>,
}

fn parts(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// True when `latest` is a higher version than `current` (numeric, "1.10.0" > "1.9.2").
fn newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parts(latest), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .user_agent(concat!("SCMFARM/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_manifest() -> Result<Manifest, String> {
    client(10)?
        .get(MANIFEST_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .json::<Manifest>()
        .await
        .map_err(|e| e.to_string())
}

fn verify_signature(m: &Manifest) -> Result<(), String> {
    let key: [u8; 32] = hex::decode(RELEASE_PUBLIC_KEY)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or("bad_public_key")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "bad_public_key")?;
    let sig: [u8; 64] = hex::decode(m.signature.trim())
        .ok()
        .and_then(|s| s.try_into().ok())
        .ok_or("bad_signature")?;
    let message = format!("SCMFARM {} {}", m.version, m.sha256.to_lowercase());
    key.verify(message.as_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| "bad_signature".to_string())
}

fn sibling(ext: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.with_extension(ext))
}

/// Called first thing on start: after an update the new exe waits until the old process has exited (its file can
/// then be deleted) before Tauri's single-instance check runs, and leftovers of a broken download are removed.
pub fn finish_previous_update() {
    let waiting = std::env::args().any(|a| a == "--updated");
    if let Ok(old) = sibling("exe.old") {
        for _ in 0..(if waiting { 80 } else { 1 }) {
            if !old.exists() || fs::remove_file(&old).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    if let Ok(part) = sibling("exe.new") {
        let _ = fs::remove_file(part);
    }
}

/// Is there a newer SCMFARM? Never fails: offline or no release yet just means "no update".
#[tauri::command]
pub async fn update_check() -> Value {
    let current = env!("CARGO_PKG_VERSION");
    if cfg!(debug_assertions) {
        return json!({ "current": current, "available": false }); // `npm run dev` never replaces itself
    }
    match fetch_manifest().await {
        Ok(m) => json!({ "current": current, "latest": m.version, "available": newer(&m.version, current), "notes": m.notes }),
        Err(e) => json!({ "current": current, "available": false, "error": e }),
    }
}

/// Downloads, verifies and installs the newer version, then restarts into it.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let m = fetch_manifest().await?;
    if !newer(&m.version, env!("CARGO_PKG_VERSION")) {
        return Err("no_update".into());
    }
    if !m.url.starts_with("https://") {
        return Err("bad_url".into());
    }
    verify_signature(&m)?;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let part = sibling("exe.new")?;
    let old = sibling("exe.old")?;
    let res = client(600)?
        .get(&m.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let total = res.content_length().unwrap_or(0);
    let mut file = fs::File::create(&part).map_err(|_| "folder_not_writable".to_string())?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        let _ = app.emit("update-progress", json!({ "done": done, "total": total }));
    }
    drop(file);
    if hex::encode(hasher.finalize()) != m.sha256.to_lowercase() {
        let _ = fs::remove_file(&part);
        return Err("checksum".into());
    }
    let _ = fs::remove_file(&old);
    fs::rename(&exe, &old).map_err(|_| "folder_not_writable".to_string())?;
    if let Err(e) = fs::rename(&part, &exe) {
        let _ = fs::rename(&old, &exe);
        return Err(e.to_string());
    }
    let mut cmd = Command::new(&exe);
    cmd.arg("--updated");
    if let Err(e) = cmd.spawn() {
        // Could not start the new exe: put the old one back so the user is never left without the program.
        let _ = fs::rename(&exe, &part);
        let _ = fs::rename(&old, &exe);
        return Err(e.to_string());
    }
    app.exit(0); // stops the engine (lib.rs RunEvent::Exit); the new exe then deletes SCMFARM.exe.old
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{newer, verify_signature, Manifest};

    fn manifest(version: &str, sha: &str) -> Manifest {
        Manifest {
            version: version.into(),
            url: "https://example.org/SCMFARM.exe".into(),
            sha256: sha.into(),
            // made by scripts/sign-release.mjs's code with the release key over "SCMFARM 9.9.9 abab…ab"
            signature: "8b653c4574ed5cd6c2052386db1732889871504f59b971c757dcc8e940380b010e8ade9ee843adb2ea9d596113ef967a7505c038402da1a7bc6e38a2cf86af03".into(),
            notes: None,
        }
    }

    #[test]
    fn release_signature_from_the_ci_script_is_accepted() {
        assert!(verify_signature(&manifest("9.9.9", &"ab".repeat(32))).is_ok());
        assert!(verify_signature(&manifest("9.9.9", &"AB".repeat(32))).is_ok()); // hash case does not matter
    }

    #[test]
    fn changed_version_or_hash_is_rejected() {
        assert!(verify_signature(&manifest("9.9.8", &"ab".repeat(32))).is_err());
        assert!(verify_signature(&manifest("9.9.9", &"cd".repeat(32))).is_err());
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("1.10.0", "1.9.2"));
        assert!(newer("v0.1.1", "0.1.0"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.1.0", "0.2.0"));
    }
}

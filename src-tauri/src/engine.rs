//! The farming engine: an unmodified ArchiSteamFarm (ASF) build that runs hidden next to the app.
//!
//! We download the pinned official release once, verify its SHA-512, write ASF.json / IPC.config
//! ourselves (IPC on 127.0.0.1 only, random port, random password) and talk to it over its REST API.
//! See docs/RESEARCH.md for the reasoning behind every setting.

use std::fs;
use std::io::Cursor;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter, Manager, State};

pub const ASF_VERSION: &str = "6.3.11.7";
const ASF_URL: &str =
    "https://github.com/JustArchiNET/ArchiSteamFarm/releases/download/6.3.11.7/ASF-win-x64.zip";
const ASF_SHA512: &str = "95d8b91c944fd7c47e6dae71d89b65ee81cb219689fd67fe91da665297b7da32ee567c8ebb96b7b7a653b2ea43ed62e8d176b53d0f7e078309443802d2bd7167";
const ASF_EXE: &str = "ArchiSteamFarm.exe";
const VERSION_MARKER: &str = ".showcase-farm-engine";

/// Windows CREATE_NO_WINDOW: start the console app without a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Running {
    child: Child,
    port: u16,
    password: String,
}

#[derive(Default)]
pub struct Engine {
    running: Mutex<Option<Running>>,
}

impl Engine {
    fn endpoint(&self) -> Result<(u16, String), String> {
        let mut guard = self.running.lock().map_err(|_| "engine lock poisoned")?;
        let alive = match guard.as_mut() {
            Some(r) => matches!(r.child.try_wait(), Ok(None)),
            None => false,
        };
        if alive {
            if let Some(r) = guard.as_ref() {
                return Ok((r.port, r.password.clone()));
            }
        }
        *guard = None;
        Err("engine_not_running".into())
    }

    fn is_running(&self) -> bool {
        self.endpoint().is_ok()
    }

    /// Asks ASF to exit, then kills it if it is still there after a few seconds.
    pub async fn stop(&self) {
        let endpoint = self.endpoint().ok();
        if let Some((port, password)) = endpoint {
            let _ = call(port, &password, "POST", "/Api/ASF/Exit", None).await;
        }
        let taken = self.running.lock().ok().and_then(|mut g| g.take());
        if let Some(mut r) = taken {
            for _ in 0..40 {
                if matches!(r.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

fn engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("asf"))
        .map_err(|e| e.to_string())
}

fn installed_version(dir: &Path) -> Option<String> {
    if !dir.join(ASF_EXE).is_file() {
        return None;
    }
    fs::read_to_string(dir.join(VERSION_MARKER))
        .ok()
        .map(|s| s.trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    installed: bool,
    up_to_date: bool,
    version: &'static str,
    running: bool,
}

#[tauri::command]
pub fn engine_info(app: AppHandle, engine: State<'_, Engine>) -> Result<EngineInfo, String> {
    let installed = installed_version(&engine_dir(&app)?);
    Ok(EngineInfo {
        installed: installed.is_some(),
        up_to_date: installed.as_deref() == Some(ASF_VERSION),
        version: ASF_VERSION,
        running: engine.is_running(),
    })
}

#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

/// Downloads the pinned ASF release, checks its SHA-512 and unpacks it. Keeps an existing
/// `config/` folder (bot configs and the Steam login token) when replacing an older version.
#[tauri::command]
pub async fn engine_install(app: AppHandle, engine: State<'_, Engine>) -> Result<(), String> {
    if engine.is_running() {
        return Err("engine_running".into());
    }
    let dir = engine_dir(&app)?;

    let response = reqwest::Client::builder()
        .user_agent(concat!("ShowcaseFarm/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?
        .get(ASF_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download_failed: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut hasher = Sha512::new();
    let mut stream = response.bytes_stream();
    let mut last_emit = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download_failed: {e}"))?;
        hasher.update(&chunk);
        bytes.extend_from_slice(&chunk);
        let done = bytes.len() as u64;
        if done - last_emit > 256 * 1024 || done == total {
            last_emit = done;
            let _ = app.emit("engine-progress", Progress { done, total });
        }
    }
    if hex::encode(hasher.finalize()) != ASF_SHA512 {
        return Err("checksum_mismatch".into());
    }

    let tmp = dir.with_extension("new");
    if tmp.exists() {
        fs::remove_dir_all(&tmp).map_err(|e| e.to_string())?;
    }
    zip::ZipArchive::new(Cursor::new(bytes))
        .and_then(|mut z| z.extract(&tmp))
        .map_err(|e| format!("unpack_failed: {e}"))?;

    if dir.exists() {
        let old_config = dir.join("config");
        if old_config.is_dir() {
            let new_config = tmp.join("config");
            if new_config.exists() {
                fs::remove_dir_all(&new_config).map_err(|e| e.to_string())?;
            }
            fs::rename(&old_config, &new_config).map_err(|e| e.to_string())?;
        }
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(VERSION_MARKER), ASF_VERSION).map_err(|e| e.to_string())?;
    Ok(())
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

fn random_password() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn write_configs(dir: &Path, port: u16, password: &str) -> Result<(), String> {
    let config = dir.join("config");
    fs::create_dir_all(&config).map_err(|e| e.to_string())?;
    let global = json!({
        "Headless": true,
        "IPC": true,
        "IPCPassword": password,
        "AutoRestart": false,
        "UpdateChannel": 0,
        "UpdatePeriod": 0,
        "SteamOwnerID": 0,
        "FilterBadBots": false
    });
    let ipc = json!({
        "Kestrel": { "Endpoints": { "HTTP4": { "Url": format!("http://127.0.0.1:{port}") } } }
    });
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
    fs::write(config.join("ASF.json"), pretty(&global)).map_err(|e| e.to_string())?;
    fs::write(config.join("IPC.config"), pretty(&ipc)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Starts ASF hidden and waits until its IPC answers. `keep_awake` passes `--system-required`,
/// which stops Windows from sleeping while ASF runs.
#[tauri::command]
pub async fn engine_start(
    app: AppHandle,
    engine: State<'_, Engine>,
    keep_awake: Option<bool>,
) -> Result<(), String> {
    if engine.is_running() {
        return Ok(());
    }
    let dir = engine_dir(&app)?;
    if installed_version(&dir).is_none() {
        return Err("engine_not_installed".into());
    }
    let port = free_port()?;
    let password = random_password();
    write_configs(&dir, port, &password)?;

    let mut cmd = Command::new(dir.join(ASF_EXE));
    cmd.arg("--no-restart")
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if keep_awake.unwrap_or(false) {
        cmd.arg("--system-required");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("start_failed: {e}"))?;
    *engine.running.lock().map_err(|_| "engine lock poisoned")? = Some(Running {
        child,
        port,
        password: password.clone(),
    });

    for _ in 0..180 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !engine.is_running() {
            return Err("engine_exited".into());
        }
        if call(port, &password, "GET", "/Api/ASF", None).await.is_ok() {
            return Ok(());
        }
    }
    engine.stop().await;
    Err("engine_timeout".into())
}

#[tauri::command]
pub async fn engine_stop(engine: State<'_, Engine>) -> Result<(), String> {
    engine.stop().await;
    Ok(())
}

async fn call(
    port: u16,
    password: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{port}{path}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url).header("Authentication", password);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    // ASF answers errors with a GenericResponse too; hand it to the UI instead of a bare status.
    match res.json::<Value>().await {
        Ok(v) => Ok(v),
        Err(_) => Err(format!("http_{}", status.as_u16())),
    }
}

/// Proxies one ASF IPC call. Only `/Api/...` paths, only to our own engine on 127.0.0.1.
#[tauri::command]
pub async fn asf_request(
    engine: State<'_, Engine>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !path.starts_with("/Api/") || path.contains("..") {
        return Err("bad_path".into());
    }
    let (port, password) = engine.endpoint()?;
    call(port, &password, &method, &path, body).await
}

/// Last lines of ASF's log, used to explain sign-in failures (e.g. InvalidPassword, RateLimitExceeded).
#[tauri::command]
pub fn engine_log_tail(app: AppHandle, lines: Option<usize>) -> Result<Vec<String>, String> {
    // ASF writes the current log to log.txt next to the exe; logs/ only holds archives.
    let path = engine_dir(&app)?.join("log.txt");
    let text = fs::read_to_string(path).unwrap_or_default();
    let n = lines.unwrap_or(40);
    let all: Vec<&str> = text.lines().collect();
    Ok(all[all.len().saturating_sub(n)..]
        .iter()
        .map(|s| s.to_string())
        .collect())
}

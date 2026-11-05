//! Things a portable single exe has to do itself: carry its licences (Apache-2.0 asks for a copy with every
//! distribution) and remove itself from the PC (SignPath Foundation asks every program to be removable).

use std::fs;
use std::process::Command;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::engine::Engine;

const LICENSES: [(&str, &str); 6] = [
    ("SCMFARM-LICENSE.txt", include_str!("../../LICENSE")),
    ("NOTICE.txt", include_str!("../../NOTICE")),
    ("ArchiSteamFarm-LICENSE.txt", include_str!("../../licenses/ArchiSteamFarm-LICENSE.txt")),
    ("Montserrat-OFL.txt", include_str!("../../licenses/Montserrat-OFL.txt")),
    ("qrcode-generator-MIT.txt", include_str!("../../licenses/qrcode-generator-MIT.txt")),
    // The achievements code is ported from Steam Achievement Manager (src/achievements.rs).
    ("SteamAchievementManager-zlib.txt", include_str!("../../licenses/SteamAchievementManager-zlib.txt")),
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Writes the licences into the app data folder and opens that folder.
#[tauri::command]
pub fn open_licenses(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("licenses");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, text) in LICENSES {
        fs::write(dir.join(name), text).map_err(|e| e.to_string())?;
    }
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// "Remove SCMFARM from this PC": stops the engine, turns autostart off, deletes the engine, the Steam sign-in token
/// and the settings, then quits. The WebView profile and the exe itself are in use until we exit, so a hidden
/// command deletes them a few seconds later.
#[tauri::command]
pub async fn remove_from_pc(app: AppHandle, engine: State<'_, Engine>, delete_exe: bool) -> Result<(), String> {
    engine.stop().await;
    let _ = app.autolaunch().disable();
    crate::links::unregister();   // the scmfarm:// link handler (HKCU\Software\Classes\scmfarm)
    for dir in [app.path().app_data_dir(), app.path().app_config_dir()].into_iter().flatten() {
        let _ = fs::remove_dir_all(dir);
    }
    let mut later = Vec::new();
    if let Ok(local) = app.path().app_local_data_dir() {
        later.push(format!("rmdir /s /q \"{}\"", local.display()));
    }
    if delete_exe {
        if let Ok(exe) = std::env::current_exe() {
            later.push(format!("del /f /q \"{}\"", exe.display()));
        }
    }
    if !later.is_empty() {
        let script = format!("timeout /t 3 /nobreak >nul & {}", later.join(" & "));
        let mut cmd = Command::new("cmd");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // /s: cmd takes everything between the outer quotes verbatim, so the quoted paths inside survive.
            cmd.raw_arg(format!("/s /c \"{script}\"")).creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(not(windows))]
        cmd.args(["-c", &script]);
        let _ = cmd.spawn();
    }
    app.exit(0);
    Ok(())
}

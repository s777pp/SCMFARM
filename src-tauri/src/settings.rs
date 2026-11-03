//! App settings (wizard answers, language, window behaviour) as one JSON file in the app config dir.
//! The Steam password is never part of this file.

use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle) -> Map<String, Value> {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn flag(app: &AppHandle, key: &str) -> bool {
    load(app).get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Value {
    Value::Object(load(&app))
}

/// Merges `patch` into the stored settings and returns the result.
#[tauri::command]
pub fn settings_set(app: AppHandle, patch: Map<String, Value>) -> Result<Value, String> {
    let mut current = load(&app);
    for (k, v) in patch {
        if k.to_ascii_lowercase().contains("password") {
            return Err("refusing to store a password".into());
        }
        current.insert(k, v);
    }
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(current.clone())).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(Value::Object(current))
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| e.to_string())
}

/// Opens an https link in the user's browser (showcasemaker.com, Steam help pages).
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") {
        return Err("only https links".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

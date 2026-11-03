//! Things around farming that reach outside the PC, each one optional and described in README "Privacy":
//! - Windows notifications (local, no network);
//! - the user's own Telegram bot (token from @BotFather): messages go straight from this PC to api.telegram.org;
//! - the showcasemaker.com feed: Steam sale dates and card set sizes/prices, the same JSON for everyone, fetched at
//!   most once a day and cached in the app data folder. Nothing about the user is sent.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

const FEED_URL: &str = "https://showcasemaker.com/api/scmfarm/feed";
const FEED_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const TELEGRAM: &str = "https://api.telegram.org";

fn client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .user_agent(concat!("SCMFARM/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notify_toast(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// A bot token looks like "123456789:AA…" (digits, colon, letters/digits/-/_). Anything else never reaches a URL.
fn valid_token(token: &str) -> bool {
    match token.split_once(':') {
        Some((id, secret)) => {
            !id.is_empty()
                && id.bytes().all(|b| b.is_ascii_digit())
                && secret.len() >= 20
                && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }
        None => false,
    }
}

/// The chat of the newest private message to the bot (the user sends it /start), from `getUpdates` JSON.
fn chat_from_updates(v: &Value) -> Option<i64> {
    v["result"]
        .as_array()?
        .iter()
        .rev()
        .filter_map(|u| u.get("message").or_else(|| u.get("my_chat_member")))
        .find_map(|m| m["chat"]["id"].as_i64().filter(|_| m["chat"]["type"] == "private"))
}

async fn telegram(token: &str, method: &str, body: Value) -> Result<Value, String> {
    if !valid_token(token) {
        return Err("bad_token".into());
    }
    let r = client(15)?
        .post(format!("{TELEGRAM}/bot{token}/{method}"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "offline".to_string())?;
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    if v["ok"] == true {
        Ok(v)
    } else if v["error_code"] == 401 || v["error_code"] == 404 {
        Err("bad_token".into())
    } else {
        Err(v["description"].as_str().unwrap_or("telegram_error").to_string())
    }
}

/// Finds the chat the user opened with their bot. Err("no_chat") until they have sent it a message.
#[tauri::command]
pub async fn telegram_link(token: String) -> Result<i64, String> {
    let v = telegram(token.trim(), "getUpdates", json!({ "limit": 50, "timeout": 0 })).await?;
    chat_from_updates(&v).ok_or_else(|| "no_chat".into())
}

#[tauri::command]
pub async fn telegram_send(token: String, chat_id: i64, text: String) -> Result<(), String> {
    telegram(token.trim(), "sendMessage", json!({ "chat_id": chat_id, "text": text, "disable_web_page_preview": true }))
        .await
        .map(|_| ())
}

fn feed_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("feed.json"))
}

fn read_cache(path: &PathBuf) -> Option<(Value, Duration)> {
    let age = fs::metadata(path).ok()?.modified().ok()?.elapsed().unwrap_or_default();
    let v = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    Some((v, age))
}

/// A feed is usable when it has the version we understand; unknown fields are ignored.
fn valid_feed(v: &Value) -> bool {
    v["v"] == 1 && v["sales"].is_array() && v["sets"].is_object()
}

/// The cached feed when it is younger than a day, else a fresh one (falling back to the old cache when offline).
/// None when there is neither: the UI then simply shows no sales and no set prices.
#[tauri::command]
pub async fn feed_get(app: AppHandle) -> Option<Value> {
    let path = feed_path(&app)?;
    let cached = read_cache(&path);
    if let Some((v, age)) = &cached {
        if *age < FEED_MAX_AGE && valid_feed(v) {
            return Some(v.clone());
        }
    }
    let fresh = async {
        let r = client(30).ok()?.get(FEED_URL).send().await.ok()?.error_for_status().ok()?;
        r.json::<Value>().await.ok().filter(valid_feed)
    }
    .await;
    match fresh {
        Some(v) => {
            if let Some(dir) = path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::write(&path, serde_json::to_vec(&v).unwrap_or_default());
            Some(v)
        }
        None => {
            // Offline or the site is down: an old cache is better than nothing; the next start tries again.
            cached.map(|(v, _)| v).filter(valid_feed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        // Built at run time so no token-shaped literal sits in the source (secret scanners flag those).
        let secret = "x".repeat(35);
        assert!(valid_token(&format!("123456789:{secret}")));
        assert!(!valid_token("123456789:short"));
        assert!(!valid_token(&format!("abc:{secret}")));
        assert!(!valid_token(&format!("123:{secret}/../x")));
        assert!(!valid_token(""));
    }

    #[test]
    fn chat_id_from_updates() {
        let v = json!({"ok": true, "result": [
            {"update_id": 1, "message": {"chat": {"id": -100, "type": "group"}, "text": "hi"}},
            {"update_id": 2, "message": {"chat": {"id": 4242, "type": "private"}, "text": "/start"}},
        ]});
        assert_eq!(chat_from_updates(&v), Some(4242));
        assert_eq!(chat_from_updates(&json!({"ok": true, "result": []})), None);
    }

    #[test]
    fn feed_shape() {
        assert!(valid_feed(&json!({"v": 1, "updated": "x", "sales": [], "sets": {"620": [9, 412]}})));
        assert!(!valid_feed(&json!({"v": 2, "sales": [], "sets": {}})));
        assert!(!valid_feed(&json!({"v": 1, "sales": {}})));
    }
}

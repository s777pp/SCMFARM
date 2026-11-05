//! `scmfarm://` links from showcasemaker.com (2026-11-06: "Achievement letters" → "Open in SCMFARM").
//!
//! The exe is portable, so on every start it registers the scheme for the current user only
//! (HKCU\Software\Classes\scmfarm → "<this exe>" "%1"); "Remove from this PC" deletes the key again.
//! Windows starts the exe with the link as an argument: a fresh start keeps it for the UI (`link_take`), and a second
//! start while SCMFARM runs is caught by the single-instance plugin, which hands the link over as the
//! `scmfarm-link` event. The UI checks everything in the link (ui/js/achievements.js parseLetters).

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub const SCHEME: &str = "scmfarm";
const MAX_LINK: usize = 4096;

#[derive(Default)]
pub struct Pending(pub Mutex<Option<String>>);

/// The first argument that is one of our links.
pub fn find(args: &[String]) -> Option<String> {
    args.iter()
        .find(|a| a.len() <= MAX_LINK && a.to_ascii_lowercase().starts_with("scmfarm://"))
        .cloned()
}

pub fn keep(app: &AppHandle, link: String) {
    if let Some(p) = app.try_state::<Pending>() {
        *p.0.lock().unwrap() = Some(link.clone());
    }
    let _ = app.emit("scmfarm-link", link);
}

/// A link SCMFARM was started with, once.
#[tauri::command]
pub fn link_take(pending: tauri::State<'_, Pending>) -> Option<String> {
    pending.0.lock().unwrap().take()
}

#[cfg(windows)]
mod reg {
    use std::ffi::c_void;
    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const REG_SZ: u32 = 1;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegSetKeyValueW(key: isize, sub: *const u16, name: *const u16, kind: u32, data: *const c_void, size: u32) -> i32;
        fn RegDeleteTreeW(key: isize, sub: *const u16) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub fn set(sub: &str, name: Option<&str>, value: &str) -> bool {
        let data = wide(value);
        let name_w = name.map(wide);
        unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, wide(sub).as_ptr(), name_w.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()), REG_SZ,
                data.as_ptr() as *const c_void, (data.len() * 2) as u32) == 0
        }
    }
    pub fn delete(sub: &str) {
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, wide(sub).as_ptr());
        }
    }
}

/// HKCU\Software\Classes\scmfarm pointing at this exe (nothing system-wide, no admin rights).
pub fn register() {
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else { return };
        let key = format!("Software\\Classes\\{SCHEME}");
        let ok = reg::set(&key, None, "URL:SCMFARM")
            && reg::set(&key, Some("URL Protocol"), "")
            && reg::set(&format!("{key}\\DefaultIcon"), None, &format!("\"{}\",0", exe.display()))
            && reg::set(&format!("{key}\\shell\\open\\command"), None, &format!("\"{}\" \"%1\"", exe.display()));
        if !ok {
            eprintln!("scmfarm:// could not be registered");
        }
    }
}

pub fn unregister() {
    #[cfg(windows)]
    reg::delete(&format!("Software\\Classes\\{SCHEME}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_our_links() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(find(&args(&["SCMFARM.exe", "--minimized"])), None);
        assert_eq!(find(&args(&["x", "SCMFARM://letters?w=HI"])).as_deref(), Some("SCMFARM://letters?w=HI"));
        assert_eq!(find(&args(&["x", "https://evil", "scmfarm://a"])).as_deref(), Some("scmfarm://a"));
        let long = format!("scmfarm://{}", "a".repeat(MAX_LINK));
        assert_eq!(find(&[long]), None);
    }
}

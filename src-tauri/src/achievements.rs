//! Achievements of the user's own games, the way Steam Achievement Manager does it (gibbed/SteamAchievementManager,
//! zlib licence, Copyright (c) 2024 Rick (rick 'at' gibbed 'dot' us); licences/SteamAchievementManager-zlib.txt).
//! The interface layouts, the binary KeyValues format and the protection rule below are ported from it.
//!
//! How it works: SCMFARM starts ITSELF again as a short-lived helper (`SCMFARM.exe --achievements <appid> read|apply`)
//! with `SteamAppId=<appid>`. The helper loads `steamclient64.dll` from the user's own Steam folder (nothing from
//! Steamworks is shipped), connects to the running, signed-in Steam client, asks for the user's stats of that game,
//! optionally sets / clears achievements and stores them, prints one JSON line and exits. While it runs Steam sees
//! that game as running, so the UI pauses farming of the same account first (ui/js/achievements.js).
//!
//! Names, descriptions, icons, hidden and protected flags come from the game's schema that Steam keeps in
//! `<Steam>/appcache/stats/UserGameStatsSchema_<appid>.bin` (Steam downloads it when the stats are requested).
//! Protected achievements ((permission & 3) != 0) are set by the game's servers only and are never touched.
//!
//! The helper takes lists (`apply` reads {"set": [ids], "clear": [ids]} on stdin), so a whole list from
//! showcasemaker.com (the achievement letters tool) can later be applied in one go.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

// ------------------------------------------------------------------ binary KeyValues (SAM.Game/KeyValue.cs)
#[derive(Debug, Clone, PartialEq)]
pub enum Kv {
    Section(Vec<(String, Kv)>),
    Str(String),
    Int(i32),
    Float(f32),
    U32(u32),
    U64(u64),
}

static MISSING: Kv = Kv::Section(Vec::new());

impl Kv {
    /// Child by name, case-insensitive like SAM; a missing child is an empty section.
    pub fn get(&self, key: &str) -> &Kv {
        if let Kv::Section(items) = self {
            if let Some((_, v)) = items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)) {
                return v;
            }
        }
        &MISSING
    }
    pub fn children(&self) -> &[(String, Kv)] {
        match self {
            Kv::Section(items) => items,
            _ => &[],
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Kv::Str(s) if !s.is_empty() => Some(s),
            _ => None,
        }
    }
    pub fn int(&self) -> i64 {
        match self {
            Kv::Int(v) => *v as i64,
            Kv::Float(v) => *v as i64,
            Kv::U32(v) => *v as i64,
            Kv::U64(v) => (*v & 0xFFFF_FFFF) as i64,
            Kv::Str(s) => s.trim().parse().unwrap_or(0),
            Kv::Section(_) => 0,
        }
    }
}

fn cstr(b: &[u8], i: &mut usize) -> Option<String> {
    let end = b.get(*i..)?.iter().position(|&c| c == 0)? + *i;
    let s = String::from_utf8_lossy(&b[*i..end]).into_owned();
    *i = end + 1;
    Some(s)
}

fn take<const N: usize>(b: &[u8], i: &mut usize) -> Option<[u8; N]> {
    let out: [u8; N] = b.get(*i..*i + N)?.try_into().ok()?;
    *i += N;
    Some(out)
}

fn section(b: &[u8], i: &mut usize, depth: usize) -> Option<Kv> {
    if depth > 64 {
        return None;
    }
    let mut items = Vec::new();
    loop {
        let kind = *b.get(*i)?;
        *i += 1;
        if kind == 8 {
            return Some(Kv::Section(items));
        }
        let name = cstr(b, i)?;
        let value = match kind {
            0 => section(b, i, depth + 1)?,
            1 => Kv::Str(cstr(b, i)?),
            2 => Kv::Int(i32::from_le_bytes(take::<4>(b, i)?)),
            3 => Kv::Float(f32::from_le_bytes(take::<4>(b, i)?)),
            4 | 6 => Kv::U32(u32::from_le_bytes(take::<4>(b, i)?)),
            7 => Kv::U64(u64::from_le_bytes(take::<8>(b, i)?)),
            _ => return None, // 5 (wide string) is not used by Steam's schemas
        };
        items.push((name, value));
    }
}

pub fn parse_kv(bytes: &[u8]) -> Option<Kv> {
    let mut i = 0;
    section(bytes, &mut i, 0)
}

// ------------------------------------------------------------------ the game's schema
#[derive(Debug, Clone, PartialEq)]
pub struct Achievement {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub icon: String,
    pub icon_gray: String,
    pub hidden: bool,
    pub protected: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Schema {
    pub game: String,
    pub achievements: Vec<Achievement>,
}

/// SCMFARM's language -> Steam's name for it (then English, then the plain value, like SAM).
pub fn steam_language(lang: &str) -> &'static str {
    match lang {
        "ru" => "russian",
        "de" => "german",
        "tr" => "turkish",
        "fr" => "french",
        "uk" => "ukrainian",
        "es" => "spanish",
        "pt" => "brazilian",
        _ => "english",
    }
}

fn localized(kv: &Kv, language: &str, fallback: &str) -> String {
    let alt = if language == "brazilian" { Some("portuguese") } else { None };
    [Some(language), alt, Some("english")]
        .into_iter()
        .flatten()
        .find_map(|l| kv.get(l).str())
        .or_else(|| kv.str())
        .unwrap_or(fallback)
        .to_string()
}

/// Achievements of the "Achievements" / "GroupAchievements" stats (type 4 / 5, by name or by number).
pub fn read_schema(bytes: &[u8], appid: u32, lang: &str) -> Option<Schema> {
    let root = parse_kv(bytes)?;
    let game = root.get(&appid.to_string());
    let language = steam_language(lang);
    let mut achievements = Vec::new();
    for (_, stat) in game.get("stats").children() {
        let kind = match stat.get("type") {
            Kv::Str(s) => match s.to_ascii_lowercase().as_str() {
                "achievements" => 4,
                "groupachievements" => 5,
                "int" | "integer" => 1,
                "float" => 2,
                "avgrate" | "averagerate" => 3,
                _ => stat.get("type_int").int(),
            },
            other => {
                let n = stat.get("type_int").int();
                if n != 0 { n } else { other.int() }
            }
        };
        if kind != 4 && kind != 5 {
            continue;
        }
        for (_, bit) in stat.get("bits").children() {
            let id = bit.get("name").str().unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            let display = bit.get("display");
            let icon = display.get("icon").str().unwrap_or("").to_string();
            achievements.push(Achievement {
                name: localized(display.get("name"), language, &id),
                desc: localized(display.get("desc"), language, ""),
                icon_gray: display.get("icon_gray").str().map(str::to_string).unwrap_or_else(|| icon.clone()),
                icon,
                hidden: display.get("hidden").int() != 0,
                protected: bit.get("permission").int() & 3 != 0,
                id,
            });
        }
    }
    Some(Schema { game: game.get("gamename").str().unwrap_or("").to_string(), achievements })
}

// ------------------------------------------------------------------ the Steam folder and the signed-in user
#[cfg(windows)]
mod reg {
    use std::ffi::c_void;
    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x2;
    const RRF_RT_REG_DWORD: u32 = 0x10;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(key: isize, sub: *const u16, value: *const u16, flags: u32, kind: *mut u32, data: *mut c_void, size: *mut u32) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub fn string(sub: &str, value: &str) -> Option<String> {
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, wide(sub).as_ptr(), wide(value).as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut c_void, &mut size)
        };
        if rc != 0 {
            return None;
        }
        let len = (size as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..len.min(buf.len())]))
    }
    pub fn dword(sub: &str, value: &str) -> Option<u32> {
        let mut data = 0u32;
        let mut size = 4u32;
        let rc = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, wide(sub).as_ptr(), wide(value).as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(),
                &mut data as *mut u32 as *mut c_void, &mut size)
        };
        (rc == 0).then_some(data)
    }
}

pub fn steam_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let path = PathBuf::from(reg::string("Software\\Valve\\Steam", "SteamPath")?);
        return path.join("steamclient64.dll").is_file().then_some(path);
    }
    #[allow(unreachable_code)]
    None
}

/// SteamID64 of the account signed in to the Steam client right now (None: Steam is not running or nobody is in).
pub fn active_user() -> Option<u64> {
    #[cfg(windows)]
    {
        let account = reg::dword("Software\\Valve\\Steam\\ActiveProcess", "ActiveUser")?;
        return (account != 0).then_some(76561197960265728 + account as u64);
    }
    #[allow(unreachable_code)]
    None
}

fn schema_path(steam: &Path, appid: u32) -> PathBuf {
    steam.join("appcache").join("stats").join(format!("UserGameStatsSchema_{appid}.bin"))
}

// ------------------------------------------------------------------ the helper: steamclient64.dll
#[cfg(windows)]
mod client {
    use std::ffi::{c_void, CString};
    use std::path::Path;

    type Ptr = *mut c_void;
    const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 8;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(path: *const u16, file: Ptr, flags: u32) -> Ptr;
        fn GetProcAddress(module: Ptr, name: *const u8) -> Ptr;
        fn SetDllDirectoryW(path: *const u16) -> i32;
    }

    #[repr(C)]
    struct CallbackMsg {
        user: i32,
        id: i32,
        param: *mut u8,
        size: i32,
    }

    type CreateInterface = unsafe extern "C" fn(*const i8, *mut i32) -> Ptr;
    type GetCallback = unsafe extern "C" fn(i32, *mut CallbackMsg, *mut i32) -> u8;
    type FreeCallback = unsafe extern "C" fn(i32) -> u8;

    // vtable slots (SAM.API/Interfaces/ISteamClient018.cs, ISteamUserStats013.cs, ISteamUser012).
    const CLIENT_CREATE_PIPE: usize = 0;
    const CLIENT_RELEASE_PIPE: usize = 1;
    const CLIENT_CONNECT_GLOBAL_USER: usize = 2;
    const CLIENT_RELEASE_USER: usize = 4;
    const CLIENT_GET_USER: usize = 5;
    const CLIENT_GET_USER_STATS: usize = 13;
    const USER_GET_STEAM_ID: usize = 2;
    const STATS_SET_ACHIEVEMENT: usize = 6;
    const STATS_CLEAR_ACHIEVEMENT: usize = 7;
    const STATS_GET_ACHIEVEMENT_AND_UNLOCK_TIME: usize = 8;
    const STATS_STORE: usize = 9;
    const STATS_REQUEST_USER_STATS: usize = 15;
    const STATS_REQUEST_GLOBAL_PERCENTAGES: usize = 33;
    const STATS_GET_ACHIEVED_PERCENT: usize = 36;

    pub const CB_USER_STATS_RECEIVED: i32 = 1101;
    pub const CB_USER_STATS_STORED: i32 = 1102;
    pub const CB_GLOBAL_PERCENTAGES: i32 = 1110;

    unsafe fn slot(obj: Ptr, index: usize) -> *const c_void {
        let vtable = *(obj as *const *const *const c_void);
        *vtable.add(index)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub struct Client {
        client: Ptr,
        pipe: i32,
        user: i32,
        steam_user: Ptr,
        stats: Ptr,
        get_cb: GetCallback,
        free_cb: FreeCallback,
    }

    /// One callback: its id and its first bytes (the game id and the result code).
    pub struct Event {
        pub id: i32,
        pub result: i32,
    }

    impl Client {
        /// Err: "load" (no steamclient64.dll), "steam" (Steam is not running / nobody signed in).
        pub fn open(steam: &Path) -> Result<Client, &'static str> {
            unsafe {
                let dirs = format!("{};{}", steam.display(), steam.join("bin").display());
                SetDllDirectoryW(wide(&dirs).as_ptr());
                let dll = steam.join("steamclient64.dll");
                let module = LoadLibraryExW(wide(&dll.to_string_lossy()).as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH);
                if module.is_null() {
                    return Err("load");
                }
                let create = GetProcAddress(module, b"CreateInterface\0".as_ptr());
                let get_cb = GetProcAddress(module, b"Steam_BGetCallback\0".as_ptr());
                let free_cb = GetProcAddress(module, b"Steam_FreeLastCallback\0".as_ptr());
                if create.is_null() || get_cb.is_null() || free_cb.is_null() {
                    return Err("load");
                }
                let create: CreateInterface = std::mem::transmute(create);
                let version = CString::new("SteamClient018").unwrap();
                let client = create(version.as_ptr(), std::ptr::null_mut());
                if client.is_null() {
                    return Err("load");
                }
                let create_pipe: unsafe extern "C" fn(Ptr) -> i32 = std::mem::transmute(slot(client, CLIENT_CREATE_PIPE));
                let pipe = create_pipe(client);
                if pipe == 0 {
                    return Err("steam");
                }
                let connect: unsafe extern "C" fn(Ptr, i32) -> i32 = std::mem::transmute(slot(client, CLIENT_CONNECT_GLOBAL_USER));
                let user = connect(client, pipe);
                let mut me = Client {
                    client,
                    pipe,
                    user,
                    steam_user: std::ptr::null_mut(),
                    stats: std::ptr::null_mut(),
                    get_cb: std::mem::transmute(get_cb),
                    free_cb: std::mem::transmute(free_cb),
                };
                if user == 0 {
                    return Err("steam");
                }
                let get_iface: unsafe extern "C" fn(Ptr, i32, i32, *const i8) -> Ptr = std::mem::transmute(slot(client, CLIENT_GET_USER));
                let v_user = CString::new("SteamUser012").unwrap();
                me.steam_user = get_iface(client, user, pipe, v_user.as_ptr());
                let get_stats: unsafe extern "C" fn(Ptr, i32, i32, *const i8) -> Ptr = std::mem::transmute(slot(client, CLIENT_GET_USER_STATS));
                let v_stats = CString::new("STEAMUSERSTATS_INTERFACE_VERSION013").unwrap();
                me.stats = get_stats(client, user, pipe, v_stats.as_ptr());
                if me.steam_user.is_null() || me.stats.is_null() {
                    return Err("load");
                }
                Ok(me)
            }
        }

        pub fn steam_id(&self) -> u64 {
            unsafe {
                let f: unsafe extern "C" fn(Ptr, *mut u64) -> *mut u64 = std::mem::transmute(slot(self.steam_user, USER_GET_STEAM_ID));
                let mut id = 0u64;
                f(self.steam_user, &mut id);
                id
            }
        }

        pub fn request_user_stats(&self, steam_id: u64) -> u64 {
            unsafe {
                let f: unsafe extern "C" fn(Ptr, u64) -> u64 = std::mem::transmute(slot(self.stats, STATS_REQUEST_USER_STATS));
                f(self.stats, steam_id)
            }
        }

        pub fn request_global_percentages(&self) -> u64 {
            unsafe {
                let f: unsafe extern "C" fn(Ptr) -> u64 = std::mem::transmute(slot(self.stats, STATS_REQUEST_GLOBAL_PERCENTAGES));
                f(self.stats)
            }
        }

        pub fn achievement(&self, id: &str) -> Option<(bool, u32)> {
            let name = CString::new(id).ok()?;
            unsafe {
                let f: unsafe extern "C" fn(Ptr, *const i8, *mut u8, *mut u32) -> u8 =
                    std::mem::transmute(slot(self.stats, STATS_GET_ACHIEVEMENT_AND_UNLOCK_TIME));
                let (mut done, mut when) = (0u8, 0u32);
                (f(self.stats, name.as_ptr(), &mut done, &mut when) != 0).then_some((done != 0, when))
            }
        }

        pub fn percent(&self, id: &str) -> Option<f32> {
            let name = CString::new(id).ok()?;
            unsafe {
                let f: unsafe extern "C" fn(Ptr, *const i8, *mut f32) -> u8 = std::mem::transmute(slot(self.stats, STATS_GET_ACHIEVED_PERCENT));
                let mut pct = 0f32;
                (f(self.stats, name.as_ptr(), &mut pct) != 0).then_some(pct)
            }
        }

        pub fn set(&self, id: &str, on: bool) -> bool {
            let Ok(name) = CString::new(id) else { return false };
            unsafe {
                let f: unsafe extern "C" fn(Ptr, *const i8) -> u8 =
                    std::mem::transmute(slot(self.stats, if on { STATS_SET_ACHIEVEMENT } else { STATS_CLEAR_ACHIEVEMENT }));
                f(self.stats, name.as_ptr()) != 0
            }
        }

        pub fn store(&self) -> bool {
            unsafe {
                let f: unsafe extern "C" fn(Ptr) -> u8 = std::mem::transmute(slot(self.stats, STATS_STORE));
                f(self.stats) != 0
            }
        }

        /// Callbacks that arrived since the last call.
        pub fn events(&self) -> Vec<Event> {
            let mut out = Vec::new();
            unsafe {
                let mut msg = CallbackMsg { user: 0, id: 0, param: std::ptr::null_mut(), size: 0 };
                let mut call = 0i32;
                while (self.get_cb)(self.pipe, &mut msg, &mut call) != 0 {
                    // UserStatsReceived / UserStatsStored / GlobalAchievementPercentagesReceived: u64 game id, then the result
                    let result = if !msg.param.is_null() && msg.size >= 12 { (msg.param.add(8) as *const i32).read_unaligned() } else { 0 };
                    out.push(Event { id: msg.id, result });
                    (self.free_cb)(self.pipe);
                }
            }
            out
        }
    }

    impl Drop for Client {
        fn drop(&mut self) {
            unsafe {
                let release_user: unsafe extern "C" fn(Ptr, i32, i32) = std::mem::transmute(slot(self.client, CLIENT_RELEASE_USER));
                release_user(self.client, self.pipe, self.user);
                let release_pipe: unsafe extern "C" fn(Ptr, i32) -> u8 = std::mem::transmute(slot(self.client, CLIENT_RELEASE_PIPE));
                release_pipe(self.client, self.pipe);
            }
        }
    }
}

#[derive(Deserialize, Default)]
struct Changes {
    #[serde(default)]
    set: Vec<String>,
    #[serde(default)]
    clear: Vec<String>,
}

/// `SCMFARM.exe --achievements <appid> read|apply`: prints one JSON line and returns the exit code.
pub fn helper_main(args: &[String]) -> i32 {
    let out = helper(args).unwrap_or_else(|e| json!({ "ok": false, "error": e }));
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{out}");
    let _ = stdout.flush();
    0
}

#[cfg(not(windows))]
fn helper(_args: &[String]) -> Result<Value, String> {
    Err("windows".into())
}

#[cfg(windows)]
fn helper(args: &[String]) -> Result<Value, String> {
    let appid: u32 = args.first().and_then(|a| a.parse().ok()).filter(|&a| a > 0).ok_or("appid")?;
    let apply = args.get(1).map(String::as_str) == Some("apply");
    let mut changes = Changes::default();
    if apply {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).map_err(|_| "input")?;
        changes = serde_json::from_str(&input).map_err(|_| "input")?;
    }
    let steam = steam_dir().ok_or("steam")?;
    std::env::set_var("SteamAppId", appid.to_string());
    let client = client::Client::open(&steam).map_err(str::to_string)?;
    let me = client.steam_id();

    // Ask for the stats (Steam downloads the schema too) and wait for UserStatsReceived.
    client.request_user_stats(me);
    let pct_call = client.request_global_percentages();
    let mut got_stats = None;
    let mut got_pct = pct_call == 0;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && (got_stats.is_none() || !got_pct) {
        for e in client.events() {
            if e.id == client::CB_USER_STATS_RECEIVED && got_stats.is_none() {
                got_stats = Some(e.result);
            } else if e.id == client::CB_GLOBAL_PERCENTAGES {
                got_pct = true;
            }
        }
        if got_stats.is_some() && Instant::now() + Duration::from_secs(15) > deadline {
            break; // stats are in; do not wait long for the global percentages
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    match got_stats {
        None => return Err("timeout".into()),
        Some(1) => {}
        Some(2) => return Err("owned".into()),
        Some(n) => return Err(format!("stats:{n}")),
    }
    let bytes = fs::read(schema_path(&steam, appid)).map_err(|_| "schema")?;
    let schema = read_schema(&bytes, appid, "en").ok_or("schema")?;

    let mut stored = Value::Null;
    if apply {
        let allowed: HashMap<&str, bool> = schema.achievements.iter().map(|a| (a.id.as_str(), !a.protected)).collect();
        let mut failed = Vec::new();
        let mut changed = 0;
        for (list, on) in [(&changes.set, true), (&changes.clear, false)] {
            for id in list {
                if allowed.get(id.as_str()) != Some(&true) || !client.set(id, on) {
                    failed.push(id.clone());
                } else {
                    changed += 1;
                }
            }
        }
        if changed > 0 {
            if !client.store() {
                return Err("store".into());
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut result = None;
            while Instant::now() < deadline && result.is_none() {
                result = client.events().into_iter().find(|e| e.id == client::CB_USER_STATS_STORED).map(|e| e.result);
                std::thread::sleep(Duration::from_millis(50));
            }
            stored = json!(result.unwrap_or(0));
        }
        if !failed.is_empty() {
            stored = json!({ "result": stored, "failed": failed });
        }
    }

    let mut states = serde_json::Map::new();
    for a in &schema.achievements {
        if let Some((done, when)) = client.achievement(&a.id) {
            let pct = client.percent(&a.id);
            states.insert(a.id.clone(), json!([done, when, pct]));
        }
    }
    Ok(json!({ "ok": true, "steamid": me.to_string(), "states": states, "stored": stored }))
}

// ------------------------------------------------------------------ Tauri side
fn run_helper(appid: u32, mode: &str, input: Option<String>) -> Result<Value, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = Command::new(exe)
        .args(["--achievements", &appid.to_string(), mode])
        .env("SteamAppId", appid.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.unwrap_or_default().as_bytes());
    }
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(45) {
            let _ = child.kill();
            return Err("timeout".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut text = String::new();
    child.stdout.take().ok_or("output")?.read_to_string(&mut text).map_err(|e| e.to_string())?;
    let out: Value = serde_json::from_str(text.lines().last().unwrap_or("")).map_err(|_| "output".to_string())?;
    if out["ok"] == json!(true) {
        Ok(out)
    } else {
        Err(out["error"].as_str().unwrap_or("helper").to_string())
    }
}

fn achievements_json(schema: &Schema, states: &Value) -> Value {
    let list: Vec<Value> = schema
        .achievements
        .iter()
        .map(|a| {
            let s = &states[&a.id];
            json!({
                "id": a.id, "name": a.name, "desc": a.desc, "icon": a.icon, "iconGray": a.icon_gray,
                "hidden": a.hidden, "protected": a.protected,
                "achieved": s[0].as_bool().unwrap_or(false), "unlocked": s[1].as_u64().unwrap_or(0), "percent": s[2].as_f64(),
            })
        })
        .collect();
    json!({ "game": schema.game, "achievements": list })
}

/// Steam folder found, Steam running and who is signed in to it.
#[tauri::command]
pub fn ach_steam() -> Value {
    json!({ "installed": steam_dir().is_some(), "user": active_user().map(|u| u.to_string()) })
}

/// Games whose achievement schema Steam already keeps on this PC: [{appid, name, count}], by name.
#[tauri::command]
pub async fn ach_games(lang: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let steam = steam_dir().ok_or("steam")?;
        let mut games = Vec::new();
        for entry in fs::read_dir(steam.join("appcache").join("stats")).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(appid) = name.strip_prefix("UserGameStatsSchema_").and_then(|n| n.strip_suffix(".bin")).and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(bytes) = fs::read(entry.path()) else { continue };
            if let Some(schema) = read_schema(&bytes, appid, &lang) {
                if !schema.achievements.is_empty() {
                    games.push(json!({ "appid": appid, "name": schema.game, "count": schema.achievements.len() }));
                }
            }
        }
        games.sort_by_key(|g| g["name"].as_str().unwrap_or("").to_lowercase());
        Ok(json!(games))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One game's achievements with the user's state and the global percentages (runs the helper).
#[tauri::command]
pub async fn ach_load(appid: u32, lang: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_helper(appid, "read", None)?;
        let steam = steam_dir().ok_or("steam")?;
        let bytes = fs::read(schema_path(&steam, appid)).map_err(|_| "schema")?;
        let schema = read_schema(&bytes, appid, &lang).ok_or("schema")?;
        let mut result = achievements_json(&schema, &out["states"]);
        result["appid"] = json!(appid);
        result["steamid"] = out["steamid"].clone();
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unlock `set` and lock `clear` (achievement ids) of one game, then return the new list like `ach_load`.
#[tauri::command]
pub async fn ach_apply(appid: u32, set: Vec<String>, clear: Vec<String>, lang: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let input = json!({ "set": set, "clear": clear }).to_string();
        let out = run_helper(appid, "apply", Some(input))?;
        let steam = steam_dir().ok_or("steam")?;
        let bytes = fs::read(schema_path(&steam, appid)).map_err(|_| "schema")?;
        let schema = read_schema(&bytes, appid, &lang).ok_or("schema")?;
        let mut result = achievements_json(&schema, &out["states"]);
        result["appid"] = json!(appid);
        result["steamid"] = out["steamid"].clone();
        result["stored"] = out["stored"].clone();
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv_bytes() -> Vec<u8> {
        // { "620": { "gamename": "Portal 2", "stats": { "1": { "type": "ACHIEVEMENTS", "bits": {
        //     "0": { "name": "ACH_A", "permission": 0, "display": { "name": { "english": "First", "russian": "Первое" }, "desc": { "english": "Do it" }, "hidden": 1, "icon": "a.jpg", "icon_gray": "a_g.jpg" } },
        //     "1": { "name": "ACH_B", "permission": 2, "display": { "name": "Plain", "icon": "b.jpg" } } } },
        //   "2": { "type_int": 1, "name": "STAT" } } } }
        let mut b = Vec::new();
        fn s(b: &mut Vec<u8>, t: u8, k: &str) {
            b.push(t);
            b.extend_from_slice(k.as_bytes());
            b.push(0);
        }
        fn st(b: &mut Vec<u8>, k: &str, v: &str) {
            s(b, 1, k);
            b.extend_from_slice(v.as_bytes());
            b.push(0);
        }
        fn int(b: &mut Vec<u8>, k: &str, v: i32) {
            s(b, 2, k);
            b.extend_from_slice(&v.to_le_bytes());
        }
        s(&mut b, 0, "620");
        st(&mut b, "gamename", "Portal 2");
        s(&mut b, 0, "stats");
        s(&mut b, 0, "1");
        st(&mut b, "type", "ACHIEVEMENTS");
        s(&mut b, 0, "bits");
        s(&mut b, 0, "0");
        st(&mut b, "name", "ACH_A");
        int(&mut b, "permission", 0);
        s(&mut b, 0, "display");
        s(&mut b, 0, "name");
        st(&mut b, "english", "First");
        st(&mut b, "russian", "Первое");
        b.push(8);
        s(&mut b, 0, "desc");
        st(&mut b, "english", "Do it");
        b.push(8);
        int(&mut b, "hidden", 1);
        st(&mut b, "icon", "a.jpg");
        st(&mut b, "icon_gray", "a_g.jpg");
        b.push(8); // display
        b.push(8); // 0
        s(&mut b, 0, "1");
        st(&mut b, "name", "ACH_B");
        int(&mut b, "permission", 2);
        s(&mut b, 0, "display");
        st(&mut b, "name", "Plain");
        st(&mut b, "icon", "b.jpg");
        b.push(8); // display
        b.push(8); // 1
        b.push(8); // bits
        b.push(8); // stat 1
        s(&mut b, 0, "2");
        int(&mut b, "type_int", 1);
        st(&mut b, "name", "STAT");
        b.push(8); // stat 2
        b.push(8); // stats
        b.push(8); // 620
        b.push(8); // root
        b
    }

    #[test]
    fn schema_reads_names_flags_and_languages() {
        let schema = read_schema(&kv_bytes(), 620, "ru").unwrap();
        assert_eq!(schema.game, "Portal 2");
        assert_eq!(schema.achievements.len(), 2);
        let a = &schema.achievements[0];
        assert_eq!((a.id.as_str(), a.name.as_str(), a.desc.as_str()), ("ACH_A", "Первое", "Do it"));
        assert!(a.hidden && !a.protected);
        assert_eq!((a.icon.as_str(), a.icon_gray.as_str()), ("a.jpg", "a_g.jpg"));
        let b = &schema.achievements[1];
        assert_eq!((b.name.as_str(), b.icon_gray.as_str()), ("Plain", "b.jpg"));
        assert!(b.protected && !b.hidden);
        assert_eq!(read_schema(&kv_bytes(), 620, "de").unwrap().achievements[0].name, "First");
    }

    #[test]
    fn broken_files_do_not_panic() {
        let bytes = kv_bytes();
        for cut in [0, 1, 5, 40, bytes.len() / 2, bytes.len() - 1] {
            let _ = read_schema(&bytes[..cut], 620, "en");
        }
        assert!(parse_kv(&[9, b'x', 0]).is_none());
    }

    /// Every schema Steam keeps on this PC parses (skipped where there is no Steam).
    #[test]
    fn local_schemas_parse() {
        let Some(steam) = steam_dir() else { return };
        let Ok(dir) = fs::read_dir(steam.join("appcache").join("stats")) else { return };
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(appid) = name.strip_prefix("UserGameStatsSchema_").and_then(|n| n.strip_suffix(".bin")).and_then(|n| n.parse().ok()) {
                let bytes = fs::read(entry.path()).unwrap();
                assert!(read_schema(&bytes, appid, "en").is_some(), "{name}");
            }
        }
    }
}

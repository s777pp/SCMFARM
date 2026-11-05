// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `SCMFARM.exe --achievements <appid> read|apply`: the short-lived achievements helper (src/achievements.rs), no window.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--achievements") {
        std::process::exit(showcase_farm_lib::achievements::helper_main(&args[1..]));
    }
    showcase_farm_lib::run()
}

mod engine;
mod settings;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        // A second launch (e.g. from the Start menu while we sit in the tray) just shows the window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(engine::Engine::default())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Showcase Farm", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit / Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Showcase Farm")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Started by Windows autostart: stay in the tray, the UI resumes farming on its own.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if settings::flag(window.app_handle(), "minimizeToTray") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_info,
            engine::engine_install,
            engine::engine_start,
            engine::engine_stop,
            engine::asf_request,
            engine::engine_log_tail,
            settings::settings_get,
            settings::settings_set,
            settings::set_autostart,
            settings::open_external,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Showcase Farm");

    app.run(|app, event| {
        // Never leave a hidden ASF process behind.
        if let RunEvent::Exit = event {
            let engine = app.state::<engine::Engine>();
            tauri::async_runtime::block_on(engine.stop());
        }
    });
}

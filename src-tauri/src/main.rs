#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tasks;
mod intelligence;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

#[derive(Default)]
struct RuntimeState { economy: Mutex<bool> }

#[tauri::command]
fn get_economy(state: State<RuntimeState>) -> Result<bool, String> {
    state.economy.lock().map(|value| *value).map_err(|e| e.to_string())
}

fn change_economy(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let mut value = state.economy.lock().map_err(|e| e.to_string())?;
    *value = enabled;
    app.emit("economy-changed", enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_economy(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    change_economy(&app, enabled)
}

fn show(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("Janela indisponível")?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.emit("window-visible", true).map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn hide(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("Janela indisponível")?;
    window.hide().map_err(|e| e.to_string())?;
    window.emit("window-visible", false).map_err(|e| e.to_string())
}

#[tauri::command]
fn window_action(app: tauri::AppHandle, label: String, visible: bool) -> Result<(), String> {
    if !matches!(label.as_str(), "dashboard" | "assistant") { return Err("Janela inválida".into()); }
    if visible { show(&app, &label) } else { hide(&app, &label) }
}

#[tauri::command]
fn quit(app: tauri::AppHandle) { app.exit(0); }

#[tauri::command]
fn get_visible(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_visible().map_err(|e| e.to_string())
}

#[tauri::command]
async fn interpret_command(
    state: State<'_, intelligence::IntelligenceState>,
    request: intelligence::Request,
) -> Result<intelligence::Preview, intelligence::IntelligenceError> {
    intelligence::interpret(&state, request).await
}

fn main() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .manage(intelligence::IntelligenceState::default())
        .invoke_handler(tauri::generate_handler![interpret_command, get_economy, set_economy, window_action, get_visible, quit, tasks::list_tasks, tasks::save_task, tasks::complete_task, tasks::delete_task])
        .setup(|app| {
            tasks::setup(app)?;
            let dashboard = MenuItem::with_id(app, "dashboard", "Abrir dashboard", true, None::<&str>)?;
            let assistant = MenuItem::with_id(app, "assistant", "Abrir assistente", true, None::<&str>)?;
            let hide_all = MenuItem::with_id(app, "hide", "Ocultar janelas", true, None::<&str>)?;
            let economy = MenuItem::with_id(app, "economy", "Ativar/desativar modo econômico", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "quit", "Encerrar JARVIS", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&dashboard, &assistant, &hide_all, &economy, &exit])?;
            // Ícone RGBA local, sem arquivos externos ou decodificadores adicionais.
            let mut pixels = vec![0u8; 32 * 32 * 4];
            for y in 0..32i32 { for x in 0..32i32 {
                let radius = (x - 16).pow(2) + (y - 16).pow(2);
                if (64..196).contains(&radius) {
                    let i = ((y * 32 + x) * 4) as usize;
                    pixels[i..i + 4].copy_from_slice(&[56, 210, 240, 255]);
                }
            }}
            TrayIconBuilder::with_id("jarvis")
                .icon(tauri::image::Image::new_owned(pixels, 32, 32))
                .tooltip("JARVIS — controle local")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let result = match event.id.as_ref() {
                        "dashboard" => show(app, "dashboard"),
                        "assistant" => show(app, "assistant"),
                        "hide" => hide(app, "dashboard").and_then(|_| hide(app, "assistant")),
                        "economy" => get_economy(app.state()).and_then(|value| change_economy(app, !value)),
                        "quit" => { app.exit(0); Ok(()) },
                        _ => Ok(()),
                    };
                    if let Err(error) = result { eprintln!("Ação da bandeja falhou: {error}"); }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = hide(window.app_handle(), window.label()) {
                    eprintln!("Falha ao ocultar janela: {error}");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Falha ao iniciar JARVIS");
}

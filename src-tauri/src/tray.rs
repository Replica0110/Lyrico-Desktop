use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "lyrico";

struct Labels {
    show: String,
    quit: String,
}

pub(crate) struct TrayState {
    labels: Mutex<Labels>,
    icon: Option<TrayIcon<Wry>>,
}

fn log_tray(level: log::Level, name: &str, error: impl std::fmt::Display) {
    crate::logging::event(
        level,
        "tray",
        name,
        serde_json::json!({ "error": error.to_string() }),
    );
}

/// 按设置创建托盘图标并注册状态；创建失败只记日志，不影响启动。
pub(crate) fn init(app: &AppHandle) {
    let labels = Labels {
        show: "打开主界面".to_string(),
        quit: "退出".to_string(),
    };
    let icon = match build_tray(app, &labels) {
        Ok(icon) => Some(icon),
        Err(error) => {
            log_tray(log::Level::Error, "tray.init.failed", error);
            None
        }
    };
    if let Some(icon) = &icon {
        let visible = crate::config::load_desktop_settings(app)
            .map(|settings| settings.close_to_tray)
            .unwrap_or_else(|error| {
                log_tray(log::Level::Warn, "settings.load.failed", error);
                false
            });
        if let Err(error) = icon.set_visible(visible) {
            log_tray(log::Level::Warn, "tray.visible.failed", error);
        }
    }
    app.manage(TrayState {
        labels: Mutex::new(labels),
        icon,
    });
}

/// 关闭主窗口时的处理方式。
enum CloseDecision {
    /// 允许正常关闭。
    Allow,
    /// 拦截关闭请求并隐藏到托盘。
    Hide,
    /// 拦截关闭请求，通知前端弹窗让用户选择。
    Prompt,
}

/// 拦截主窗口关闭请求：未选择过时先弹窗询问，之后按「最小化到托盘」设置处理。
pub(crate) fn intercept_close(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app = app.clone();
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            match close_decision(&app) {
                CloseDecision::Allow => {}
                CloseDecision::Hide => {
                    api.prevent_close();
                    if let Err(error) = handle.hide() {
                        log_tray(log::Level::Warn, "window.hide.failed", error);
                    }
                }
                CloseDecision::Prompt => {
                    api.prevent_close();
                    let _ = handle.emit("close-tray-prompt", ());
                }
            }
        }
    });
}

/// 同步托盘图标可见性（保存/导入设置后调用）。
pub(crate) fn sync_visibility(app: &AppHandle, visible: bool) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    if let Some(icon) = &state.icon {
        if let Err(error) = icon.set_visible(visible) {
            log_tray(log::Level::Warn, "tray.visible.failed", error);
        }
    }
}

/// 更新托盘右键菜单文案（界面语言变化时由前端调用）。
pub(crate) fn set_labels(app: &AppHandle, show: &str, quit: &str) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let mut labels = state
        .labels
        .lock()
        .map_err(|_| "Tray menu label lock was poisoned")?;
    labels.show = show.to_string();
    labels.quit = quit.to_string();
    let Some(icon) = &state.icon else {
        return Ok(());
    };
    let menu = build_menu(app, &labels)?;
    icon.set_menu(Some(menu)).map_err(|error| error.to_string())
}

fn close_decision(app: &AppHandle) -> CloseDecision {
    let tray_ready = app
        .try_state::<TrayState>()
        .map(|state| state.icon.is_some())
        .unwrap_or(false);
    if !tray_ready {
        return CloseDecision::Allow;
    }
    match crate::config::load_desktop_settings(app) {
        Ok(settings) if settings.close_to_tray_prompted => {
            if settings.close_to_tray {
                CloseDecision::Hide
            } else {
                CloseDecision::Allow
            }
        }
        Ok(_) => CloseDecision::Prompt,
        Err(_) => CloseDecision::Allow,
    }
}

fn build_tray(app: &AppHandle, labels: &Labels) -> Result<TrayIcon<Wry>, String> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "Missing default window icon for tray".to_string())?;
    let menu = build_menu(app, labels)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Lyrico")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
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
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())
}

fn build_menu(app: &AppHandle, labels: &Labels) -> Result<Menu<Wry>, String> {
    let show_item = MenuItem::with_id(app, "show", &labels.show, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    Menu::with_items(app, &[&show_item, &quit_item]).map_err(|error| error.to_string())
}

pub(crate) fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.show() {
        log_tray(log::Level::Warn, "window.show.failed", error);
    }
    if let Err(error) = window.unminimize() {
        log_tray(log::Level::Warn, "window.unminimize.failed", error);
    }
    if let Err(error) = window.set_focus() {
        log_tray(log::Level::Warn, "window.focus.failed", error);
    }
}

use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

use crate::state::{format_hm, format_hms, TrackerSnapshot};

const TRAY_IDLE_BYTES: &[u8] = include_bytes!("../icons/tray-idle.png");
const TRAY_ACTIVE_BYTES: &[u8] = include_bytes!("../icons/tray-active.png");
const TRAY_WARNING_BYTES: &[u8] = include_bytes!("../icons/tray-warning.png");

pub const ID_STATUS: &str = "status";
pub const ID_AUDIT: &str = "audit";
pub const ID_OPEN: &str = "open";
pub const ID_TOGGLE_TIMER: &str = "toggle-timer";
pub const ID_TOGGLE_LOCATION: &str = "toggle-location";
pub const ID_QUIT: &str = "quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayVisualState {
    Idle,
    Active,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CachedTrayUi {
    visual: TrayVisualState,
    status_text: String,
    audit_text: String,
    toggle_text: String,
    toggle_enabled: bool,
    location_text: String,
    location_checked: bool,
    location_enabled: bool,
    quit_text: String,
    quit_enabled: bool,
    tooltip: String,
}

pub struct TrayHandles {
    tray: TrayIcon<Wry>,
    status_item: MenuItem<Wry>,
    audit_item: MenuItem<Wry>,
    toggle_timer_item: MenuItem<Wry>,
    location_item: CheckMenuItem<Wry>,
    quit_item: MenuItem<Wry>,
    cached: Mutex<CachedTrayUi>,
}

fn load_tray_image(state: TrayVisualState) -> tauri::Result<Image<'static>> {
    let bytes = match state {
        TrayVisualState::Idle => TRAY_IDLE_BYTES,
        TrayVisualState::Active => TRAY_ACTIVE_BYTES,
        TrayVisualState::Warning => TRAY_WARNING_BYTES,
    };
    Ok(Image::from_bytes(bytes)?.to_owned())
}

pub fn show_and_focus_main_window(app: &AppHandle<Wry>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn create_tray<F>(app: &AppHandle<Wry>, on_action: F) -> tauri::Result<TrayHandles>
where
    F: Fn(&AppHandle<Wry>, &str) + Send + Sync + 'static,
{
    let status_item =
        MenuItem::with_id(app, ID_STATUS, "○ Not Signed In", false, None::<&str>)?;
    let audit_item =
        MenuItem::with_id(app, ID_AUDIT, "Screenshot Auditing: Idle", false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let open_item = MenuItem::with_id(app, ID_OPEN, "Open SM Office Desk", true, None::<&str>)?;
    let toggle_timer_item =
        MenuItem::with_id(app, ID_TOGGLE_TIMER, "Start Timer", false, None::<&str>)?;
    let location_item = CheckMenuItem::with_id(
        app,
        ID_TOGGLE_LOCATION,
        "Share Live Location",
        false,
        false,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item =
        MenuItem::with_id(app, ID_QUIT, "Quit SM Office Desk", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &audit_item,
            &sep1,
            &open_item,
            &toggle_timer_item,
            &location_item,
            &sep2,
            &quit_item,
        ],
    )?;

    let initial_icon = load_tray_image(TrayVisualState::Idle)?;
    let initial_tooltip = "SM Office Desk — Idle".to_string();

    let tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .icon(initial_icon)
        .tooltip(&initial_tooltip)
        .icon_as_template(false)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| {
            on_action(app_handle, event.id().as_ref());
        })
        .on_tray_icon_event(|tray_icon, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_and_focus_main_window(tray_icon.app_handle());
            }
        })
        .build(app)?;

    Ok(TrayHandles {
        tray,
        status_item,
        audit_item,
        toggle_timer_item,
        location_item,
        quit_item,
        cached: Mutex::new(CachedTrayUi {
            visual: TrayVisualState::Idle,
            status_text: "○ Not Signed In".to_string(),
            audit_text: "Screenshot Auditing: Idle".to_string(),
            toggle_text: "Start Timer".to_string(),
            toggle_enabled: false,
            location_text: "Share Live Location".to_string(),
            location_checked: false,
            location_enabled: false,
            quit_text: "Quit SM Office Desk".to_string(),
            quit_enabled: true,
            tooltip: initial_tooltip,
        }),
    })
}

fn compute_desired_tray_ui(snapshot: &TrackerSnapshot) -> CachedTrayUi {
    let permission_missing = snapshot.permissions.macos_screen_recording_missing
        || snapshot.permissions.wayland_portal_needed
        || snapshot.permissions.message.is_some();
    let ws_connected = snapshot.ws_status == "connected";

    let has_warning = permission_missing
        || snapshot.screen_locked
        || (snapshot.is_tracking && !ws_connected)
        || snapshot.offline_queue_count > 0;

    let visual = if has_warning && snapshot.authenticated {
        TrayVisualState::Warning
    } else if snapshot.is_tracking {
        TrayVisualState::Active
    } else {
        TrayVisualState::Idle
    };

    let status_text = if !snapshot.authenticated {
        "○ Not Signed In".to_string()
    } else if snapshot.is_tracking {
        let elapsed = format_hms(snapshot.elapsed_seconds);
        if ws_connected {
            format!("● Active · {elapsed}")
        } else {
            format!("⚠ Active (Offline) · {elapsed}")
        }
    } else {
        format!("○ Idle · Today {}", format_hm(snapshot.today_total_seconds))
    };

    let audit_text = if !snapshot.authenticated || !snapshot.is_tracking {
        "Screenshot Auditing: Idle".to_string()
    } else if snapshot.screen_locked {
        "Screenshot Auditing: Screen Locked".to_string()
    } else if permission_missing {
        "Screenshot Auditing: Permission Required".to_string()
    } else {
        "Screenshot Auditing: Active".to_string()
    };

    let toggle_text = if snapshot.is_tracking {
        "Stop Timer".to_string()
    } else {
        "Start Timer".to_string()
    };
    let toggle_enabled = snapshot.authenticated;

    let location_checked = snapshot.location.location_enabled;
    let location_enabled = snapshot.authenticated;
    let location_text = if snapshot.location.location_enabled && snapshot.is_tracking {
        "Share Live Location (Live)".to_string()
    } else {
        "Share Live Location".to_string()
    };

    let quit_enabled = !snapshot.is_tracking;
    let quit_text = if snapshot.is_tracking {
        "Quit SM Office Desk (Stop timer first)".to_string()
    } else {
        "Quit SM Office Desk".to_string()
    };

    let tooltip = if !snapshot.authenticated {
        "SM Office Desk — Signed Out".to_string()
    } else if snapshot.is_tracking {
        if permission_missing {
            "SM Office Desk — Permission Required".to_string()
        } else if !ws_connected {
            format!(
                "SM Office Desk — Active (Reconnecting) · {}",
                format_hms(snapshot.elapsed_seconds)
            )
        } else {
            format!(
                "SM Office Desk — Active · {}",
                format_hms(snapshot.elapsed_seconds)
            )
        }
    } else {
        "SM Office Desk — Idle".to_string()
    };

    CachedTrayUi {
        visual,
        status_text,
        audit_text,
        toggle_text,
        toggle_enabled,
        location_text,
        location_checked,
        location_enabled,
        quit_text,
        quit_enabled,
        tooltip,
    }
}

pub fn sync_tray(handles: &TrayHandles, snapshot: &TrackerSnapshot) {
    let next = compute_desired_tray_ui(snapshot);
    let Ok(mut prev) = handles.cached.lock() else {
        return;
    };

    if prev.visual != next.visual {
        if let Ok(img) = load_tray_image(next.visual) {
            let _ = handles.tray.set_icon(Some(img));
        }
    }
    if prev.status_text != next.status_text {
        let _ = handles.status_item.set_text(&next.status_text);
    }
    if prev.audit_text != next.audit_text {
        let _ = handles.audit_item.set_text(&next.audit_text);
    }
    if prev.toggle_text != next.toggle_text {
        let _ = handles.toggle_timer_item.set_text(&next.toggle_text);
    }
    if prev.toggle_enabled != next.toggle_enabled {
        let _ = handles.toggle_timer_item.set_enabled(next.toggle_enabled);
    }
    if prev.location_text != next.location_text {
        let _ = handles.location_item.set_text(&next.location_text);
    }
    if prev.location_checked != next.location_checked {
        let _ = handles.location_item.set_checked(next.location_checked);
    }
    if prev.location_enabled != next.location_enabled {
        let _ = handles.location_item.set_enabled(next.location_enabled);
    }
    if prev.quit_text != next.quit_text {
        let _ = handles.quit_item.set_text(&next.quit_text);
    }
    if prev.quit_enabled != next.quit_enabled {
        let _ = handles.quit_item.set_enabled(next.quit_enabled);
    }
    if prev.tooltip != next.tooltip {
        let _ = handles.tray.set_tooltip(Some(next.tooltip.as_str()));
    }

    *prev = next;
}

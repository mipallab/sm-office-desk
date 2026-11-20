use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisplayState {
    Unlocked,
    ScreenLocked,
    PermissionDenied { os: &'static str, detail: String },
}

/// Checks OS lock screen / display availability cleanly before capture.
pub fn check_display_state() -> DisplayState {
    #[cfg(target_os = "windows")]
    {
        if unsafe { is_windows_input_desktop_locked() } {
            return DisplayState::ScreenLocked;
        }
        DisplayState::Unlocked
    }

    #[cfg(target_os = "macos")]
    {
        if !has_macos_screen_recording_permission() {
            return DisplayState::PermissionDenied {
                os: "macos",
                detail: "Screen Recording permission is required in System Settings > Privacy & Security > Screen Recording.".to_string(),
            };
        }
        if is_macos_screen_locked() {
            return DisplayState::ScreenLocked;
        }
        DisplayState::Unlocked
    }

    #[cfg(target_os = "linux")]
    {
        if is_linux_screen_locked() {
            return DisplayState::ScreenLocked;
        }
        DisplayState::Unlocked
    }
}

/// Classifies capture errors from `xcap` into `ScreenLocked`, `PermissionDenied`, or `None` (transient/other).
pub fn classify_capture_error(err_msg: &str) -> Option<DisplayState> {
    let lower = err_msg.to_ascii_lowercase();

    #[cfg(target_os = "macos")]
    {
        if !has_macos_screen_recording_permission()
            || lower.contains("permission")
            || lower.contains("tcc")
            || lower.contains("not authorized")
            || lower.contains("denied")
        {
            return Some(DisplayState::PermissionDenied {
                os: "macos",
                detail: "Screen Recording permission missing. Grant permission in System Settings and restart tracking.".to_string(),
            });
        }
        if is_macos_screen_locked()
            || lower.contains("failed to copy data")
            || lower.contains("locked")
            || lower.contains("sleep")
            || lower.contains("window server")
        {
            return Some(DisplayState::ScreenLocked);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if unsafe { is_windows_input_desktop_locked() }
            || lower.contains("access is denied")
            || lower.contains("0x80070005")
            || lower.contains("access lost")
            || lower.contains("dxgi_error_access_lost")
            || lower.contains("locked")
            || lower.contains("desktop")
        {
            return Some(DisplayState::ScreenLocked);
        }
    }

    #[cfg(target_os = "linux")]
    {
        if is_linux_screen_locked() || lower.contains("locked") || lower.contains("screensaver") {
            return Some(DisplayState::ScreenLocked);
        }
        if is_wayland_session()
            && (lower.contains("portal")
                || lower.contains("denied")
                || lower.contains("cancel")
                || lower.contains("interaction")
                || lower.contains("pipewire")
                || lower.contains("screenshot")
                || lower.contains("zbus")
                || lower.contains("wayland protocol")
                || lower.contains("cannot find required")
                || lower.contains("org.freedesktop"))
        {
            return Some(DisplayState::PermissionDenied {
                os: "linux",
                detail: "Wayland Screen Capture Setup required. Approve screen sharing in the system prompt.".to_string(),
            });
        }
    }

    if lower.contains("locked") || lower.contains("sleep") {
        return Some(DisplayState::ScreenLocked);
    }

    None
}

pub fn is_wayland_session() -> bool {
    #[cfg(target_os = "linux")]
    {
        let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
        if session_type.eq_ignore_ascii_case("wayland") {
            return true;
        }
        !std::env::var("WAYLAND_DISPLAY")
            .unwrap_or_default()
            .trim()
            .is_empty()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub fn open_os_permission_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        unsafe {
            let _ = CGRequestScreenCaptureAccess();
        }
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map_err(|e| format!("Failed to open macOS System Settings: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:privacy-location"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open Windows Settings: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| {
                std::env::var("XDG_SESSION_DESKTOP")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
            })
            .unwrap_or_default();

        let candidates = linux_settings_candidates(&desktop);
        let mut errors = Vec::with_capacity(candidates.len());
        for (program, args) in candidates {
            match Command::new(program).args(args).spawn() {
                Ok(_) => return Ok(()),
                Err(err) => errors.push(format!("{program}: {err}")),
            }
        }

        Err(format!(
            "Failed to open Linux desktop permission settings ({}). Open your desktop environment's Settings > Privacy/Permissions manually.",
            errors.join("; ")
        ))
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_settings_candidates(desktop: &str) -> [(&'static str, &'static [&'static str]); 3] {
    const NO_ARGS: &[&str] = &[];
    const GNOME_ARGS: &[&str] = &["privacy"];
    let upper = desktop.to_ascii_uppercase();
    if upper.contains("KDE") || upper.contains("PLASMA") {
        [
            ("systemsettings", NO_ARGS),
            ("systemsettings5", NO_ARGS),
            ("gnome-control-center", GNOME_ARGS),
        ]
    } else {
        [
            ("gnome-control-center", GNOME_ARGS),
            ("systemsettings", NO_ARGS),
            ("systemsettings5", NO_ARGS),
        ]
    }
}

/// Verifies / triggers Wayland desktop portal capture authorization cleanly.
/// Returns `Ok(true)` if capture permission succeeded, `Ok(false)` if still blocked.
pub fn probe_screen_capture_permission(_app_data_dir: &Path) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(has_macos_screen_recording_permission());
    }

    #[cfg(target_os = "linux")]
    {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let Some(first) = monitors.first() else {
            return Ok(false);
        };
        match first.capture_image() {
            Ok(_) => Ok(true),
            Err(e) => {
                let msg = e.to_string();
                if matches!(classify_capture_error(&msg), Some(DisplayState::PermissionDenied { .. })) {
                    Ok(false)
                } else {
                    Err(msg)
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        Ok(true)
    }
}

#[cfg(target_os = "windows")]
unsafe fn is_windows_input_desktop_locked() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(
            dw_flags: u32,
            f_inherit: i32,
            dw_desired_access: u32,
        ) -> *mut std::ffi::c_void;
        fn CloseDesktop(h_desktop: *mut std::ffi::c_void) -> i32;
    }
    const DESKTOP_READOBJECTS: u32 = 0x0001;
    let handle = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
    if handle.is_null() {
        return true;
    }
    CloseDesktop(handle);
    false
}

#[cfg(target_os = "macos")]
fn has_macos_screen_recording_permission() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
fn is_macos_screen_locked() -> bool {
    let Ok(output) = Command::new("/usr/sbin/ioreg")
        .args(["-n", "Root", "-d1"])
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.contains("\"CGSSessionScreenIsLocked\" = Yes")
}

#[cfg(target_os = "linux")]
fn is_linux_screen_locked() -> bool {
    if let Ok(session_id) = std::env::var("XDG_SESSION_ID") {
        let trimmed = session_id.trim();
        if !trimmed.is_empty() {
            if let Ok(output) = Command::new("loginctl")
                .args(["show-session", trimmed, "-p", "LockedHint", "--value"])
                .output()
            {
                if String::from_utf8_lossy(&output.stdout).trim() == "yes" {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_classifier_detects_lock_keywords() {
        let state = classify_capture_error("Display is currently locked by user");
        assert_eq!(state, Some(DisplayState::ScreenLocked));
    }

    #[test]
    fn linux_settings_prefers_kde_binaries_for_plasma() {
        let expected_empty: &[&str] = &[];
        let expected_gnome: &[&str] = &["privacy"];

        let kde = linux_settings_candidates("KDE");
        assert_eq!(kde[0], ("systemsettings", expected_empty));
        assert_eq!(kde[1], ("systemsettings5", expected_empty));
        assert_eq!(kde[2], ("gnome-control-center", expected_gnome));

        let plasma = linux_settings_candidates("ubuntu:plasma");
        assert_eq!(plasma[0], ("systemsettings", expected_empty));
    }

    #[test]
    fn linux_settings_prefers_gnome_for_other_desktops() {
        let expected_empty: &[&str] = &[];
        let expected_gnome: &[&str] = &["privacy"];

        let gnome = linux_settings_candidates("ubuntu:GNOME");
        assert_eq!(gnome[0], ("gnome-control-center", expected_gnome));
        assert_eq!(gnome[1], ("systemsettings", expected_empty));
        assert_eq!(gnome[2], ("systemsettings5", expected_empty));

        let unknown = linux_settings_candidates("");
        assert_eq!(unknown[0], ("gnome-control-center", expected_gnome));
    }
}

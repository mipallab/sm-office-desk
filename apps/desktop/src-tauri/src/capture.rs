use image::{imageops, imageops::FilterType, Rgba, RgbaImage};
use xcap::Monitor;

use crate::lock::{check_display_state, classify_capture_error, DisplayState};

pub const MAX_SINGLE_WIDTH: u32 = 1440;
pub const MAX_MULTIMONITOR_WIDTH: u32 = 1600;
pub const MAX_HEIGHT_LIMIT: u32 = 4320;
pub const DEFAULT_WEBP_QUALITY: f32 = 70.0;
pub const MAX_WEBP_BYTES: usize = 524_288; // 512 KB

#[derive(Debug, Clone)]
pub struct RawMonitorFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct EncodedCapture {
    pub webp_bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub monitor_count: u32,
}

#[derive(Debug, Clone)]
pub enum CaptureOutcome {
    Captured(EncodedCapture),
    ScreenLocked { monitor_count: u32 },
    PermissionDenied { os: &'static str, detail: String },
}

#[cfg(target_os = "linux")]
fn decode_raw_frame(bytes: &[u8]) -> Option<RawMonitorFrame> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgba_img = img.to_rgba8();
    let width = rgba_img.width();
    let height = rgba_img.height();
    if width == 0 || height == 0 {
        return None;
    }
    Some(RawMonitorFrame {
        x: 0,
        y: 0,
        width,
        height,
        rgba: rgba_img.into_raw(),
    })
}

/// Attempts Linux Wayland-compatible screen capture using native CLI tools before falling back to xcap.
#[cfg(target_os = "linux")]
pub fn try_linux_external_capture() -> Result<RawMonitorFrame, String> {
    use std::process::Command;

    // 1. Stdout-based capture tools (no temp file needed)
    let stdout_commands: [(&str, &[&str]); 3] = [
        ("flameshot", &["full", "-r"]),
        ("flatpak", &["run", "org.flameshot.Flameshot", "full", "-r"]),
        ("grim", &["-"]),
    ];

    for (cmd, args) in stdout_commands {
        if let Ok(output) = Command::new(cmd).args(args).output() {
            if output.status.success() && !output.stdout.is_empty() {
                if let Some(frame) = decode_raw_frame(&output.stdout) {
                    return Ok(frame);
                }
            }
        }
    }

    // 2. Temp-file-based desktop environment capture tools (GNOME / KDE)
    let tmp_path = std::env::temp_dir().join(format!("sm_desk_capture_{}.png", std::process::id()));
    let tmp_str = tmp_path.to_string_lossy().into_owned();
    let file_commands: [(&str, Vec<&str>); 2] = [
        ("gnome-screenshot", vec!["-f", &tmp_str]),
        ("spectacle", vec!["-b", "-n", "-o", &tmp_str]),
    ];

    for (cmd, args) in file_commands {
        let _ = std::fs::remove_file(&tmp_path);
        if let Ok(status) = Command::new(cmd).args(&args).status() {
            if status.success() {
                let bytes = std::fs::read(&tmp_path);
                let _ = std::fs::remove_file(&tmp_path);
                if let Ok(data) = bytes {
                    if let Some(frame) = decode_raw_frame(&data) {
                        return Ok(frame);
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp_path);
    }

    Err("No Linux screenshot tool (flameshot/grim/gnome-screenshot/spectacle) succeeded".to_string())
}

#[cfg(target_os = "linux")]
fn try_capture_linux_fallback() -> Option<Result<CaptureOutcome, String>> {
    let frame = try_linux_external_capture().ok()?;
    Some((|| {
        let (canvas, count) = stitch_and_scale_monitors(&[frame])?;
        let encoded = encode_webp_under_limit(&canvas, count)?;
        Ok(CaptureOutcome::Captured(encoded))
    })())
}

#[cfg(not(target_os = "linux"))]
fn try_capture_linux_fallback() -> Option<Result<CaptureOutcome, String>> {
    None
}

/// Captures all active displays via `xcap` (with automatic Wayland tool fallback on Linux),
/// stitches proportionally, scales within `1440px` (single) or `1600px` (multi-monitor), and encodes WebP <= 512 KB.
pub fn capture_all_monitors_sync() -> Result<CaptureOutcome, String> {
    match check_display_state() {
        DisplayState::ScreenLocked => {
            return Ok(CaptureOutcome::ScreenLocked { monitor_count: 0 });
        }
        DisplayState::PermissionDenied { os, detail } => {
            if let Some(res) = try_capture_linux_fallback() {
                return res;
            }
            return Ok(CaptureOutcome::PermissionDenied { os, detail });
        }
        DisplayState::Unlocked => {}
    }

    if cfg!(target_os = "linux") && crate::lock::is_wayland_session() {
        if let Some(res) = try_capture_linux_fallback() {
            return res;
        }
    }

    let monitors = match Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            if let Some(res) = try_capture_linux_fallback() {
                return res;
            }
            let msg = e.to_string();
            return match classify_capture_error(&msg) {
                Some(DisplayState::ScreenLocked) => {
                    Ok(CaptureOutcome::ScreenLocked { monitor_count: 0 })
                }
                Some(DisplayState::PermissionDenied { os, detail }) => {
                    Ok(CaptureOutcome::PermissionDenied { os, detail })
                }
                _ => Err(format!("Failed to enumerate monitors: {msg}")),
            };
        }
    };

    if monitors.is_empty() {
        if let Some(res) = try_capture_linux_fallback() {
            return res;
        }
        return Ok(CaptureOutcome::ScreenLocked { monitor_count: 0 });
    }

    let total_monitors = monitors.len() as u32;
    let mut frames = Vec::with_capacity(monitors.len());

    for monitor in monitors {
        let x = monitor.x().unwrap_or(0);
        let y = monitor.y().unwrap_or(0);
        let img = match monitor.capture_image() {
            Ok(img) => img,
            Err(e) => {
                if let Some(res) = try_capture_linux_fallback() {
                    return res;
                }
                let msg = e.to_string();
                return match classify_capture_error(&msg) {
                    Some(DisplayState::ScreenLocked) => Ok(CaptureOutcome::ScreenLocked {
                        monitor_count: total_monitors,
                    }),
                    Some(DisplayState::PermissionDenied { os, detail }) => {
                        Ok(CaptureOutcome::PermissionDenied { os, detail })
                    }
                    _ => Err(format!("Monitor capture failed: {msg}")),
                };
            }
        };

        let width = img.width();
        let height = img.height();
        if width == 0 || height == 0 {
            continue;
        }
        frames.push(RawMonitorFrame {
            x,
            y,
            width,
            height,
            rgba: img.into_raw(),
        });
    }

    if frames.is_empty() {
        return Ok(CaptureOutcome::ScreenLocked {
            monitor_count: total_monitors,
        });
    }

    let (canvas, count) = stitch_and_scale_monitors(&frames)?;
    let encoded = encode_webp_under_limit(&canvas, count)?;
    Ok(CaptureOutcome::Captured(encoded))
}

/// Pure function that computes the bounding box of 1..N monitors (supporting negative coordinates),
/// scales proportionally so width <= 1440px (1 monitor) or <= 1600px (2+ monitors) and height <= 4320px,
/// and composites all monitors onto a single RGBA canvas.
pub fn stitch_and_scale_monitors(frames: &[RawMonitorFrame]) -> Result<(RgbaImage, u32), String> {
    if frames.is_empty() {
        return Err("No monitor frames available to stitch".to_string());
    }

    let mut min_x = i64::MAX;
    let mut min_y = i64::MAX;
    let mut max_x = i64::MIN;
    let mut max_y = i64::MIN;

    for frame in frames {
        if frame.width == 0 || frame.height == 0 {
            return Err("Monitor frame has zero dimension".to_string());
        }
        let expected_len = (frame.width as usize)
            .checked_mul(frame.height as usize)
            .and_then(|v| v.checked_mul(4))
            .ok_or_else(|| "Monitor buffer size overflow".to_string())?;
        if frame.rgba.len() != expected_len {
            return Err("Monitor RGBA buffer length mismatch".to_string());
        }

        let fx0 = i64::from(frame.x);
        let fy0 = i64::from(frame.y);
        let fx1 = fx0 + i64::from(frame.width);
        let fy1 = fy0 + i64::from(frame.height);

        min_x = min_x.min(fx0);
        min_y = min_y.min(fy0);
        max_x = max_x.max(fx1);
        max_y = max_y.max(fy1);
    }

    let raw_w = (max_x - min_x).max(1) as u64;
    let raw_h = (max_y - min_y).max(1) as u64;

    let max_target_w = if frames.len() >= 2 {
        MAX_MULTIMONITOR_WIDTH
    } else {
        MAX_SINGLE_WIDTH
    };

    let scale_w = if raw_w > u64::from(max_target_w) {
        f64::from(max_target_w) / (raw_w as f64)
    } else {
        1.0
    };
    let scale_h = if raw_h > u64::from(MAX_HEIGHT_LIMIT) {
        f64::from(MAX_HEIGHT_LIMIT) / (raw_h as f64)
    } else {
        1.0
    };
    let scale = scale_w.min(scale_h);

    let out_w = ((raw_w as f64 * scale).round() as u32).max(1);
    let out_h = ((raw_h as f64 * scale).round() as u32).max(1);

    let mut canvas = RgbaImage::from_pixel(out_w, out_h, Rgba([15, 23, 42, 255]));

    for frame in frames {
        let mon_img = RgbaImage::from_raw(frame.width, frame.height, frame.rgba.clone())
            .ok_or_else(|| "Failed to construct monitor RgbaImage".to_string())?;

        let dst_x = (((i64::from(frame.x) - min_x) as f64) * scale).round() as i64;
        let dst_y = (((i64::from(frame.y) - min_y) as f64) * scale).round() as i64;
        let dst_w = ((f64::from(frame.width) * scale).round() as u32).max(1);
        let dst_h = ((f64::from(frame.height) * scale).round() as u32).max(1);

        if dst_w != frame.width || dst_h != frame.height {
            let resized = imageops::resize(&mon_img, dst_w, dst_h, FilterType::Triangle);
            imageops::overlay(&mut canvas, &resized, dst_x, dst_y);
        } else {
            imageops::overlay(&mut canvas, &mon_img, dst_x, dst_y);
        }
    }

    Ok((canvas, frames.len() as u32))
}

/// Encodes RGBA canvas to WebP starting at q=70 and steps down quality / width if > 512 KB.
pub fn encode_webp_under_limit(
    canvas: &RgbaImage,
    monitor_count: u32,
) -> Result<EncodedCapture, String> {
    let quality_steps = [DEFAULT_WEBP_QUALITY, 60.0, 50.0, 40.0];
    for quality in quality_steps {
        let bytes = encode_rgba_webp(canvas, quality)?;
        if bytes.len() <= MAX_WEBP_BYTES {
            return Ok(EncodedCapture {
                webp_bytes: bytes,
                width: canvas.width(),
                height: canvas.height(),
                monitor_count,
            });
        }
    }

    // Fallback width step-downs if image entropy keeps WebP > 512 KB
    for fallback_max_w in [1280_u32, 960_u32, 720_u32] {
        let working = if canvas.width() > fallback_max_w {
            let ratio = f64::from(fallback_max_w) / f64::from(canvas.width());
            let new_h = ((f64::from(canvas.height()) * ratio).round() as u32).max(1);
            imageops::resize(canvas, fallback_max_w, new_h, FilterType::Triangle)
        } else {
            canvas.clone()
        };

        for quality in [55.0_f32, 40.0_f32, 28.0_f32] {
            let bytes = encode_rgba_webp(&working, quality)?;
            if bytes.len() <= MAX_WEBP_BYTES {
                return Ok(EncodedCapture {
                    webp_bytes: bytes,
                    width: working.width(),
                    height: working.height(),
                    monitor_count,
                });
            }
        }
    }

    Err("Encoded WebP exceeded 512 KB upload limit even after step-down compression".to_string())
}

fn encode_rgba_webp(img: &RgbaImage, quality: f32) -> Result<Vec<u8>, String> {
    let encoder = webp::Encoder::from_rgba(img.as_raw(), img.width(), img.height());
    let mem = encoder.encode(quality);
    let bytes = mem.to_vec();
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("WebP encoder produced invalid RIFF/WEBP header".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_gradient_frame(x: i32, y: i32, w: u32, h: u32, seed: u8) -> RawMonitorFrame {
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for py in 0..h {
            for px in 0..w {
                let r = ((px + u32::from(seed)) % 256) as u8;
                let g = ((py + u32::from(seed) * 3) % 256) as u8;
                let b = (((px ^ py) + u32::from(seed)) % 256) as u8;
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        RawMonitorFrame {
            x,
            y,
            width: w,
            height: h,
            rgba,
        }
    }

    #[test]
    fn single_4k_monitor_scales_to_1440px_and_encodes_valid_webp() {
        let frame = synthetic_gradient_frame(0, 0, 2560, 1440, 17);
        let (canvas, count) = stitch_and_scale_monitors(&[frame]).unwrap();
        assert_eq!(count, 1);
        assert_eq!(canvas.width(), 1440);
        assert_eq!(canvas.height(), 810);

        let encoded = encode_webp_under_limit(&canvas, count).unwrap();
        assert_eq!(&encoded.webp_bytes[0..4], b"RIFF");
        assert_eq!(&encoded.webp_bytes[8..12], b"WEBP");
        assert!(encoded.webp_bytes.len() <= MAX_WEBP_BYTES);
    }

    #[test]
    fn multi_monitor_with_negative_offset_scales_to_1600px_preserving_aspect_ratio() {
        let left = synthetic_gradient_frame(-1920, 0, 1920, 1080, 5);
        let right = synthetic_gradient_frame(0, 0, 2560, 1440, 99);
        let (canvas, count) = stitch_and_scale_monitors(&[left, right]).unwrap();
        assert_eq!(count, 2);
        assert_eq!(canvas.width(), 1600);
        // raw width = 4480, raw height = 1440 -> 1600 * (1440/4480) = 514
        assert!((513..=515).contains(&canvas.height()));

        let encoded = encode_webp_under_limit(&canvas, count).unwrap();
        assert_eq!(&encoded.webp_bytes[0..4], b"RIFF");
        assert_eq!(&encoded.webp_bytes[8..12], b"WEBP");
        assert!(encoded.webp_bytes.len() <= MAX_WEBP_BYTES);
    }
}

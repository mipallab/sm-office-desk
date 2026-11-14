use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::state::LocationSource;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocationPayload {
    pub location_enabled: bool,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub accuracy_meters: Option<f64>,
    pub location_source: String,
}

impl LocationPayload {
    pub fn disabled() -> Self {
        Self {
            location_enabled: false,
            latitude: None,
            longitude: None,
            accuracy_meters: None,
            location_source: LocationSource::Disabled.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LocationResolveOutcome {
    Disabled(LocationPayload),
    Resolved {
        payload: LocationPayload,
        source_enum: LocationSource,
    },
    NeedsIpOptIn,
}

/// Strict employee consent gate:
/// - When `location_enabled == false`, immediately returns `Disabled` with zero OS or network calls.
/// - When `location_enabled == true`, tries OS native location first; if OS location is denied or
///   unavailable, uses IP approx ONLY if `ip_fallback_opt_in == true`.
pub async fn resolve_location(
    location_enabled: bool,
    ip_fallback_opt_in: bool,
    client: &reqwest::Client,
) -> LocationResolveOutcome {
    if !location_enabled {
        return LocationResolveOutcome::Disabled(LocationPayload::disabled());
    }

    if let Some((lat, lng, acc)) = try_os_native_location().await {
        return LocationResolveOutcome::Resolved {
            payload: LocationPayload {
                location_enabled: true,
                latitude: Some(lat),
                longitude: Some(lng),
                accuracy_meters: Some(acc),
                location_source: LocationSource::OsNative.as_str().to_string(),
            },
            source_enum: LocationSource::OsNative,
        };
    }

    if !ip_fallback_opt_in {
        return LocationResolveOutcome::NeedsIpOptIn;
    }

    if let Some((lat, lng, acc)) = fetch_ip_approx_location(client).await {
        return LocationResolveOutcome::Resolved {
            payload: LocationPayload {
                location_enabled: true,
                latitude: Some(lat),
                longitude: Some(lng),
                accuracy_meters: Some(acc),
                location_source: LocationSource::IpApprox.as_str().to_string(),
            },
            source_enum: LocationSource::IpApprox,
        };
    }

    // Even when opted in, never fabricate (0, 0) coordinates on transient network failure.
    LocationResolveOutcome::Resolved {
        payload: LocationPayload {
            location_enabled: true,
            latitude: None,
            longitude: None,
            accuracy_meters: None,
            location_source: LocationSource::IpApprox.as_str().to_string(),
        },
        source_enum: LocationSource::IpApprox,
    }
}

async fn try_os_native_location() -> Option<(f64, f64, f64)> {
    #[cfg(target_os = "windows")]
    {
        return try_windows_geolocator().await;
    }

    #[cfg(target_os = "linux")]
    {
        return try_linux_geoclue2().await;
    }

    #[cfg(target_os = "macos")]
    {
        return None;
    }
}

#[cfg(target_os = "windows")]
async fn try_windows_geolocator() -> Option<(f64, f64, f64)> {
    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType=WindowsRuntime]
$access = [Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync().GetAwaiter().GetResult()
if ($access -ne [Windows.Devices.Geolocation.GeolocationAccessStatus]::Allowed) { exit 2 }
$geo = New-Object Windows.Devices.Geolocation.Geolocator
$pos = $geo.GetGeopositionAsync().GetAwaiter().GetResult()
$coord = $pos.Coordinate
Write-Output ("{0},{1},{2}" -f $coord.Point.Position.Latitude, $coord.Point.Position.Longitude, $coord.Accuracy)
"#;

    let fut = tokio::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output();

    let output = tokio::time::timeout(Duration::from_secs(4), fut)
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_lat_lng_acc(text.trim())
}

#[cfg(target_os = "linux")]
async fn try_linux_geoclue2() -> Option<(f64, f64, f64)> {
    // Query GeoClue2 manager over D-Bus only when available and permitted; fail gracefully to NeedsIpOptIn.
    let get_client = tokio::process::Command::new("gdbus")
        .args([
            "call",
            "--system",
            "--dest",
            "org.freedesktop.GeoClue2",
            "--object-path",
            "/org/freedesktop/GeoClue2/Manager",
            "--method",
            "org.freedesktop.GeoClue2.Manager.GetClient",
        ])
        .output();

    let out = tokio::time::timeout(Duration::from_secs(2), get_client)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let start_idx = stdout.find('\'')?;
    let rest = &stdout[start_idx + 1..];
    let end_idx = rest.find('\'')?;
    let client_path = &rest[..end_idx];

    let _ = tokio::process::Command::new("gdbus")
        .args([
            "call",
            "--system",
            "--dest",
            "org.freedesktop.GeoClue2",
            "--object-path",
            client_path,
            "--method",
            "org.freedesktop.DBus.Properties.Set",
            "org.freedesktop.GeoClue2.Client",
            "DesktopId",
            "<'com.smoffice.desk'>",
        ])
        .output()
        .await;

    let _ = tokio::process::Command::new("gdbus")
        .args([
            "call",
            "--system",
            "--dest",
            "org.freedesktop.GeoClue2",
            "--object-path",
            client_path,
            "--method",
            "org.freedesktop.GeoClue2.Client.Start",
        ])
        .output()
        .await;

    tokio::time::sleep(Duration::from_millis(600)).await;

    let loc_prop = tokio::process::Command::new("gdbus")
        .args([
            "call",
            "--system",
            "--dest",
            "org.freedesktop.GeoClue2",
            "--object-path",
            client_path,
            "--method",
            "org.freedesktop.DBus.Properties.Get",
            "org.freedesktop.GeoClue2.Client",
            "Location",
        ])
        .output()
        .await
        .ok()?;

    let _ = tokio::process::Command::new("gdbus")
        .args([
            "call",
            "--system",
            "--dest",
            "org.freedesktop.GeoClue2",
            "--object-path",
            client_path,
            "--method",
            "org.freedesktop.GeoClue2.Client.Stop",
        ])
        .output()
        .await;

    let loc_text = String::from_utf8_lossy(&loc_prop.stdout);
    let p_start = loc_text.find('\'')?;
    let p_rest = &loc_text[p_start + 1..];
    let p_end = p_rest.find('\'')?;
    let loc_path = &p_rest[..p_end];
    if loc_path == "/" {
        return None;
    }

    let props = tokio::process::Command::new("gdbus")
        .args([
            "call",
            "--system",
            "--dest",
            "org.freedesktop.GeoClue2",
            "--object-path",
            loc_path,
            "--method",
            "org.freedesktop.DBus.Properties.GetAll",
            "org.freedesktop.GeoClue2.Location",
        ])
        .output()
        .await
        .ok()?;

    if !props.status.success() {
        return None;
    }
    let props_text = String::from_utf8_lossy(&props.stdout);
    let lat = extract_dbus_double(&props_text, "'Latitude': <")?;
    let lng = extract_dbus_double(&props_text, "'Longitude': <")?;
    let acc = extract_dbus_double(&props_text, "'Accuracy': <").unwrap_or(50.0);
    if is_valid_coords(lat, lng) {
        Some((lat, lng, acc.max(0.0)))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn extract_dbus_double(text: &str, needle: &str) -> Option<f64> {
    let idx = text.find(needle)?;
    let after = &text[idx + needle.len()..];
    let end = after.find('>')?;
    after[..end].trim().parse::<f64>().ok()
}

#[allow(dead_code)]
fn parse_lat_lng_acc(csv: &str) -> Option<(f64, f64, f64)> {
    let mut parts = csv.split(',');
    let lat: f64 = parts.next()?.trim().parse().ok()?;
    let lng: f64 = parts.next()?.trim().parse().ok()?;
    let acc: f64 = parts.next()?.trim().parse().ok().unwrap_or(50.0);
    if is_valid_coords(lat, lng) {
        Some((lat, lng, acc.max(0.0)))
    } else {
        None
    }
}

fn is_valid_coords(lat: f64, lng: f64) -> bool {
    lat.is_finite() && lng.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng)
}

#[derive(Debug, Deserialize)]
struct IpWhoResponse {
    success: Option<bool>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct IpApiResponse {
    latitude: Option<f64>,
    longitude: Option<f64>,
}

async fn fetch_ip_approx_location(client: &reqwest::Client) -> Option<(f64, f64, f64)> {
    if let Ok(resp) = client
        .get("https://ipwho.is/")
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<IpWhoResponse>().await {
                if data.success != Some(false) {
                    if let (Some(lat), Some(lng)) = (data.latitude, data.longitude) {
                        if is_valid_coords(lat, lng) {
                            return Some((lat, lng, 5000.0));
                        }
                    }
                }
            }
        }
    }

    if let Ok(resp) = client
        .get("https://ipapi.co/json/")
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<IpApiResponse>().await {
                if let (Some(lat), Some(lng)) = (data.latitude, data.longitude) {
                    if is_valid_coords(lat, lng) {
                        return Some((lat, lng, 5000.0));
                    }
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disabled_location_returns_null_coords_with_zero_network_calls() {
        let client = reqwest::Client::new();
        for opt_in in [false, true] {
            let outcome = resolve_location(false, opt_in, &client).await;
            match outcome {
                LocationResolveOutcome::Disabled(payload) => {
                    assert!(!payload.location_enabled);
                    assert_eq!(payload.latitude, None);
                    assert_eq!(payload.longitude, None);
                    assert_eq!(payload.accuracy_meters, None);
                    assert_eq!(payload.location_source, "disabled");
                }
                other => panic!("Expected Disabled outcome, got {:?}", other),
            }
        }
    }
}

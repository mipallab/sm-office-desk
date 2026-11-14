use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::location::LocationPayload;
use crate::queue::QueuedCapture;
use crate::state::{CompanyInfo, UserProfile, WorkSessionDto};

#[derive(Debug, Clone, Deserialize)]
pub struct ApiErrorBody {
    pub error: ApiErrorDetail,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct ApiCallError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
    pub is_network: bool,
}

impl std::fmt::Display for ApiCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status, self.message)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthTokensResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in_seconds: u64,
    pub user: UserProfile,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeResponse {
    pub user: UserProfile,
    pub company: CompanyInfo,
    pub active_session: Option<WorkSessionDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartSessionResponse {
    pub session: WorkSessionDto,
    pub server_time_utc: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StopSessionResponse {
    pub session: WorkSessionDto,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HeartbeatResponse {
    pub session_id: String,
    pub status: String,
    pub server_time_utc: String,
    pub last_heartbeat_at: String,
    pub duration_seconds: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct ScreenshotUploadResponse {
    screenshot: UploadedScreenshotId,
}

#[derive(Debug, Clone, Deserialize)]
struct UploadedScreenshotId {
    id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatBody {
    pub session_id: String,
    pub screen_locked: bool,
    pub location_enabled: bool,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub accuracy_meters: Option<f64>,
    pub location_source: String,
}

impl HeartbeatBody {
    pub fn from_location(session_id: String, screen_locked: bool, loc: &LocationPayload) -> Self {
        Self {
            session_id,
            screen_locked,
            location_enabled: loc.location_enabled,
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy_meters: loc.accuracy_meters,
            location_source: loc.location_source.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum DesktopWsOutbound {
    #[serde(rename = "auth")]
    Auth {
        token: String,
        client_type: &'static str,
        device_id: String,
        device_os: String,
        device_arch: String,
        app_version: String,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat(HeartbeatBody),
    #[serde(rename = "capture_ack")]
    CaptureAck {
        request_id: String,
        screenshot_id: i64,
        capture_status: String,
    },
    #[serde(rename = "capture_failed")]
    CaptureFailed {
        request_id: String,
        reason: String,
        error_code: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping { ts: i64 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DesktopWsInbound {
    #[serde(rename = "auth_ok")]
    AuthOk {
        user_id: i64,
        server_time_utc: String,
        active_session_id: Option<String>,
        heartbeat_interval_seconds: u64,
    },
    #[serde(rename = "auth_error")]
    AuthError { code: String, message: String },
    #[serde(rename = "CAPTURE_NOW")]
    CaptureNow {
        request_id: String,
        triggered_by_admin_id: i64,
        requested_at: String,
        timeout_seconds: u64,
    },
    #[serde(rename = "FORCE_STOP")]
    ForceStop {
        session_id: Option<String>,
        reason: String,
        message: String,
    },
    #[serde(rename = "pong")]
    Pong { ts: i64, server_time_utc: String },
}

pub fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Server URL is required".to_string());
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("localhost")
            || lower.starts_with("127.0.0.1")
            || lower.starts_with("[::1]")
        {
            format!("http://{trimmed}")
        } else {
            format!("https://{trimmed}")
        }
    };

    let parsed = Url::parse(&with_scheme).map_err(|_| "Enter a valid Server URL (e.g. https://desk.company.com)".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Server URL must start with http:// or https://".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Server URL must include a valid host name".to_string());
    }

    let mut normalized = parsed.to_string();
    while normalized.ends_with('/') {
        normalized.pop();
    }
    Ok(normalized)
}

pub fn to_ws_url(server_url: &str) -> Result<String, String> {
    let normalized = normalize_server_url(server_url)?;
    let mut parsed = Url::parse(&normalized).map_err(|e| e.to_string())?;
    let ws_scheme = match parsed.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => return Err(format!("Unsupported URL scheme: {other}")),
    };
    parsed
        .set_scheme(ws_scheme)
        .map_err(|_| "Failed to switch URL scheme to WebSocket".to_string())?;
    parsed.set_path("/ws");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new() -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| format!("Failed to initialize HTTP client: {e}"))?;
        Ok(Self { http })
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub async fn login(
        &self,
        server_url: &str,
        email: &str,
        password: &str,
        device_id: &str,
        device_arch: &str,
    ) -> Result<AuthTokensResponse, ApiCallError> {
        #[derive(Serialize)]
        struct Body<'a> {
            email: &'a str,
            password: &'a str,
            client_type: &'static str,
            device_id: &'a str,
            device_arch: &'a str,
        }
        let url = format!("{}/api/auth/login", server_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(url)
            .json(&Body {
                email: email.trim(),
                password,
                client_type: "desktop",
                device_id,
                device_arch,
            })
            .send()
            .await
            .map_err(network_err)?;
        decode_json_response(resp).await
    }

    pub async fn refresh(
        &self,
        server_url: &str,
        refresh_token: &str,
    ) -> Result<AuthTokensResponse, ApiCallError> {
        #[derive(Serialize)]
        struct Body<'a> {
            refresh_token: &'a str,
        }
        let url = format!("{}/api/auth/refresh", server_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(url)
            .json(&Body { refresh_token })
            .send()
            .await
            .map_err(network_err)?;
        decode_json_response(resp).await
    }

    pub async fn me(&self, server_url: &str, access_token: &str) -> Result<MeResponse, ApiCallError> {
        let url = format!("{}/api/auth/me", server_url.trim_end_matches('/'));
        let resp = self
            .http
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(network_err)?;
        decode_json_response(resp).await
    }

    pub async fn logout(
        &self,
        server_url: &str,
        access_token: &str,
        device_id: &str,
    ) -> Result<(), ApiCallError> {
        #[derive(Serialize)]
        struct Body<'a> {
            all_devices: bool,
            device_id: &'a str,
        }
        let url = format!("{}/api/auth/logout", server_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .json(&Body {
                all_devices: true,
                device_id,
            })
            .send()
            .await
            .map_err(network_err)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(extract_error(resp).await)
        }
    }

    pub async fn start_session(
        &self,
        server_url: &str,
        access_token: &str,
        device_id: &str,
        device_os: &str,
        device_arch: &str,
        app_version: &str,
        override_existing: bool,
    ) -> Result<StartSessionResponse, ApiCallError> {
        #[derive(Serialize)]
        struct Body<'a> {
            device_id: &'a str,
            device_os: &'a str,
            device_arch: &'a str,
            app_version: &'a str,
            override_existing: bool,
        }
        let url = format!("{}/api/tracker/sessions/start", server_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .json(&Body {
                device_id,
                device_os,
                device_arch,
                app_version,
                override_existing,
            })
            .send()
            .await
            .map_err(network_err)?;
        decode_json_response(resp).await
    }

    pub async fn heartbeat(
        &self,
        server_url: &str,
        access_token: &str,
        body: &HeartbeatBody,
    ) -> Result<HeartbeatResponse, ApiCallError> {
        let url = format!("{}/api/tracker/sessions/heartbeat", server_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .json(body)
            .send()
            .await
            .map_err(network_err)?;
        decode_json_response(resp).await
    }

    pub async fn stop_session(
        &self,
        server_url: &str,
        access_token: &str,
        session_id: &str,
        reason: &str,
    ) -> Result<StopSessionResponse, ApiCallError> {
        #[derive(Serialize)]
        struct Body<'a> {
            session_id: &'a str,
            reason: &'a str,
        }
        let url = format!("{}/api/tracker/sessions/stop", server_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .json(&Body { session_id, reason })
            .send()
            .await
            .map_err(network_err)?;
        decode_json_response(resp).await
    }

    pub async fn upload_screenshot(
        &self,
        server_url: &str,
        access_token: &str,
        capture: &QueuedCapture,
    ) -> Result<i64, ApiCallError> {
        let url = format!("{}/api/tracker/screenshots", server_url.trim_end_matches('/'));

        let mut form = Form::new()
            .text("session_id", capture.meta.session_id.clone())
            .text("capture_type", capture.meta.capture_type.clone())
            .text("capture_status", capture.meta.capture_status.clone())
            .text("monitor_count", capture.meta.monitor_count.to_string())
            .text("width", capture.meta.width.to_string())
            .text("height", capture.meta.height.to_string())
            .text(
                "captured_at_client_monotonic_ms",
                capture.meta.captured_at_client_monotonic_ms.to_string(),
            );

        if let Some(req_id) = &capture.meta.request_id {
            form = form.text("request_id", req_id.clone());
        }

        if capture.meta.capture_status == "ok" && !capture.webp_bytes.is_empty() {
            let file_part = Part::bytes(capture.webp_bytes.clone())
                .file_name("capture.webp")
                .mime_str("image/webp")
                .map_err(|e| ApiCallError {
                    status: 0,
                    code: "CLIENT_ERROR".to_string(),
                    message: e.to_string(),
                    details: None,
                    is_network: false,
                })?;
            form = form.part("file", file_part);
        }

        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .multipart(form)
            .send()
            .await
            .map_err(network_err)?;

        let parsed: ScreenshotUploadResponse = decode_json_response(resp).await?;
        Ok(parsed.screenshot.id)
    }
}

fn network_err(err: reqwest::Error) -> ApiCallError {
    ApiCallError {
        status: 0,
        code: "NETWORK_ERROR".to_string(),
        message: format!("Unable to reach server: {err}"),
        details: None,
        is_network: true,
    }
}

async fn decode_json_response<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, ApiCallError> {
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        resp.json::<T>().await.map_err(|e| ApiCallError {
            status,
            code: "DECODE_ERROR".to_string(),
            message: format!("Invalid server response: {e}"),
            details: None,
            is_network: false,
        })
    } else {
        Err(extract_error_from_status(status, resp).await)
    }
}

async fn extract_error(resp: reqwest::Response) -> ApiCallError {
    let status = resp.status().as_u16();
    extract_error_from_status(status, resp).await
}

async fn extract_error_from_status(status: u16, resp: reqwest::Response) -> ApiCallError {
    let text = resp.text().await.unwrap_or_default();
    if let Ok(env) = serde_json::from_str::<ApiErrorBody>(&text) {
        return ApiCallError {
            status,
            code: env.error.code,
            message: env.error.message,
            details: env.error.details,
            is_network: false,
        };
    }
    ApiCallError {
        status,
        code: format!("HTTP_{status}"),
        message: if text.trim().is_empty() {
            format!("Server returned HTTP {status}")
        } else {
            text.chars().take(200).collect()
        },
        details: None,
        is_network: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_http_https_and_ws_urls() {
        assert_eq!(
            normalize_server_url("https://desk.company.com/").unwrap(),
            "https://desk.company.com"
        );
        assert_eq!(
            normalize_server_url("localhost:3000/").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_server_url("desk.company.com").unwrap(),
            "https://desk.company.com"
        );
        assert_eq!(
            to_ws_url("https://desk.company.com").unwrap(),
            "wss://desk.company.com/ws"
        );
        assert_eq!(
            to_ws_url("http://127.0.0.1:3000").unwrap(),
            "ws://127.0.0.1:3000/ws"
        );
        assert!(normalize_server_url("ftp://example.com").is_err());
        assert!(normalize_server_url("   ").is_err());
    }
}

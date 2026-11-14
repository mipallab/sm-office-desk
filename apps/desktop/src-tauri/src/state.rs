use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocationSource {
    OsNative,
    IpApprox,
    Disabled,
}

impl LocationSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            LocationSource::OsNative => "os_native",
            LocationSource::IpApprox => "ip_approx",
            LocationSource::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub role: String,
    pub designation: String,
    pub salary_type: String,
    pub base_salary: f64,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyInfo {
    pub company_name: String,
    pub company_timezone: String,
    pub currency_code: String,
    pub retention_days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkSessionDto {
    pub id: String,
    pub employee_id: i64,
    pub device_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_heartbeat_at: String,
    pub duration_seconds: i64,
    pub device_os: String,
    pub device_arch: String,
    pub app_version: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationStatus {
    pub location_enabled: bool,
    pub location_source: LocationSource,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub accuracy_meters: Option<f64>,
    pub os_permission_denied: bool,
    pub ip_fallback_opt_in: bool,
    pub prompt_ip_fallback: bool,
}

impl Default for LocationStatus {
    fn default() -> Self {
        Self {
            location_enabled: false,
            location_source: LocationSource::Disabled,
            latitude: None,
            longitude: None,
            accuracy_meters: None,
            os_permission_denied: false,
            ip_fallback_opt_in: false,
            prompt_ip_fallback: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionWarning {
    pub macos_screen_recording_missing: bool,
    pub wayland_portal_needed: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForceStopBanner {
    pub reason: String,
    pub message: String,
    pub occurred_at_iso: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSessionConflictInfo {
    pub active_session_id: String,
    pub active_device_id: String,
    pub active_device_os: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapInfo {
    pub app_version: String,
    pub device_id: String,
    pub short_device_id: String,
    pub device_os: String,
    pub device_arch: String,
    pub default_server_url: Option<String>,
    pub saved_server_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerSnapshot {
    pub authenticated: bool,
    pub user: Option<UserProfile>,
    pub company: Option<CompanyInfo>,
    pub server_url: String,
    pub is_tracking: bool,
    pub session_id: Option<String>,
    pub session_started_at: Option<String>,
    pub elapsed_seconds: u64,
    pub today_total_seconds: u64,
    pub ws_status: String,
    pub offline_queue_count: usize,
    pub screen_locked: bool,
    pub location: LocationStatus,
    pub permissions: PermissionWarning,
    pub force_stop: Option<ForceStopBanner>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedState {
    pub server_url: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub user: Option<UserProfile>,
    pub company: Option<CompanyInfo>,
    pub location_enabled: bool,
    pub ip_fallback_opt_in: bool,
    pub today_date_key: String,
    pub today_accumulated_seconds: u64,
    pub wayland_portal_authorized: bool,
}

#[derive(Debug, Clone)]
pub struct RuntimeState {
    pub app_data_dir: PathBuf,
    pub device_id: String,
    pub device_os: String,
    pub device_arch: String,
    pub persisted: PersistedState,
    pub is_tracking: bool,
    pub session_id: Option<String>,
    pub session_started_at: Option<String>,
    pub session_started_instant: Option<Instant>,
    pub session_base_seconds: u64,
    pub ws_status: String,
    pub offline_queue_count: usize,
    pub screen_locked: bool,
    pub location: LocationStatus,
    pub permissions: PermissionWarning,
    pub force_stop: Option<ForceStopBanner>,
    pub last_error: Option<String>,
    pub tray_notice_sent: bool,
    pub refreshing_tokens: bool,
}

impl RuntimeState {
    pub fn new(app_data_dir: PathBuf, device_id: String, persisted: PersistedState, queue_count: usize) -> Self {
        let mut location = LocationStatus::default();
        location.location_enabled = persisted.location_enabled;
        location.ip_fallback_opt_in = persisted.ip_fallback_opt_in;
        location.location_source = LocationSource::Disabled;

        let authenticated = persisted.access_token.is_some() && persisted.user.is_some();

        Self {
            app_data_dir,
            device_id,
            device_os: current_device_os().to_string(),
            device_arch: current_device_arch().to_string(),
            persisted,
            is_tracking: false,
            session_id: None,
            session_started_at: None,
            session_started_instant: None,
            session_base_seconds: 0,
            ws_status: "disconnected".to_string(),
            offline_queue_count: queue_count,
            screen_locked: false,
            location,
            permissions: PermissionWarning::default(),
            force_stop: None,
            last_error: None,
            tray_notice_sent: false,
            refreshing_tokens: false,
        }
        .with_auth_flag(authenticated)
    }

    fn with_auth_flag(mut self, authenticated: bool) -> Self {
        if !authenticated {
            self.persisted.access_token = None;
            self.persisted.refresh_token = None;
            self.persisted.user = None;
        }
        self
    }

    pub fn current_elapsed_seconds(&self) -> u64 {
        if !self.is_tracking {
            return 0;
        }
        let monotonic_delta = self
            .session_started_instant
            .map(|inst| inst.elapsed().as_secs())
            .unwrap_or(0);
        self.session_base_seconds.saturating_add(monotonic_delta)
    }

    pub fn current_today_total_seconds(&mut self) -> u64 {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        if self.persisted.today_date_key != today {
            self.persisted.today_date_key = today;
            self.persisted.today_accumulated_seconds = 0;
        }
        self.persisted
            .today_accumulated_seconds
            .saturating_add(self.current_elapsed_seconds())
    }

    pub fn snapshot(&mut self) -> TrackerSnapshot {
        let elapsed_seconds = self.current_elapsed_seconds();
        let today_total_seconds = self.current_today_total_seconds();
        let authenticated = self.persisted.access_token.is_some() && self.persisted.user.is_some();

        TrackerSnapshot {
            authenticated,
            user: self.persisted.user.clone(),
            company: self.persisted.company.clone(),
            server_url: self.persisted.server_url.clone().unwrap_or_default(),
            is_tracking: self.is_tracking,
            session_id: self.session_id.clone(),
            session_started_at: self.session_started_at.clone(),
            elapsed_seconds,
            today_total_seconds,
            ws_status: self.ws_status.clone(),
            offline_queue_count: self.offline_queue_count,
            screen_locked: self.screen_locked,
            location: self.location.clone(),
            permissions: self.permissions.clone(),
            force_stop: self.force_stop.clone(),
            last_error: self.last_error.clone(),
        }
    }

    pub fn bootstrap_info(&self) -> BootstrapInfo {
        let default_server_url = option_env!("SM_OFFICE_DEFAULT_SERVER_URL")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        BootstrapInfo {
            app_version: APP_VERSION.to_string(),
            device_id: self.device_id.clone(),
            short_device_id: short_device_id(&self.device_id),
            device_os: self.device_os.clone(),
            device_arch: self.device_arch.clone(),
            default_server_url,
            saved_server_url: self.persisted.server_url.clone(),
        }
    }

    pub fn persist(&self) {
        let _ = save_persisted_state(&self.app_data_dir, &self.persisted);
    }
}

pub fn current_device_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub fn current_device_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    }
}

pub fn short_device_id(device_id: &str) -> String {
    let trimmed = device_id.trim();
    if trimmed.len() <= 8 {
        return trimmed.to_string();
    }
    trimmed.chars().take(8).collect()
}

pub fn load_or_create_device_id(app_data_dir: &Path) -> String {
    let _ = fs::create_dir_all(app_data_dir);
    let path = app_data_dir.join("device_id.txt");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if trimmed.len() >= 4 {
            return trimmed.to_string();
        }
    }
    let host_prefix = hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .map(|h| {
            h.chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(8)
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "desk".to_string());
    let new_id = format!("{}-{}", host_prefix, Uuid::new_v4());
    let _ = write_private_file(&path, new_id.as_bytes());
    new_id
}

pub fn load_persisted_state(app_data_dir: &Path) -> PersistedState {
    let path = app_data_dir.join("app_state.json");
    let Ok(bytes) = fs::read(path) else {
        return PersistedState {
            today_date_key: chrono::Local::now().format("%Y-%m-%d").to_string(),
            ..Default::default()
        };
    };
    let mut parsed: PersistedState = serde_json::from_slice(&bytes).unwrap_or_default();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if parsed.today_date_key != today {
        parsed.today_date_key = today;
        parsed.today_accumulated_seconds = 0;
    }
    parsed
}

pub fn save_persisted_state(app_data_dir: &Path, state: &PersistedState) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let path = app_data_dir.join("app_state.json");
    let json = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    write_private_file(&path, &json)
}

pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
    Ok(())
}

pub fn format_hms(total_seconds: u64) -> String {
    let h = total_seconds / 3600;
    let m = (total_seconds % 3600) / 60;
    let s = total_seconds % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

pub fn format_hm(total_seconds: u64) -> String {
    let h = total_seconds / 3600;
    let m = (total_seconds % 3600) / 60;
    format!("{:02}h {:02}m", h, m)
}

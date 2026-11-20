pub mod capture;
pub mod location;
pub mod lock;
pub mod network;
pub mod queue;
pub mod scheduler;
pub mod state;
pub mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, watch, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::capture::{capture_all_monitors_sync, CaptureOutcome};
use crate::location::{resolve_location, LocationPayload, LocationResolveOutcome};
use crate::network::{
    normalize_server_url, to_ws_url, ApiCallError, ApiClient, DesktopWsInbound,
    DesktopWsOutbound, HeartbeatBody,
};
use crate::queue::{EncryptedQueue, QueuedCapture, QueuedCaptureMeta};
use crate::scheduler::{MonotonicCaptureScheduler, HEARTBEAT_INTERVAL_SECONDS};
use crate::state::{
    load_or_create_device_id, load_persisted_state, ActiveSessionConflictInfo, BootstrapInfo,
    ForceStopBanner, LocationSource, LocationStatus, PermissionWarning, RuntimeState,
    TrackerSnapshot,
};
use crate::tray::TrayHandles;

#[derive(Debug, Clone, Serialize)]
pub struct UiErrorPayload {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub conflict: Option<ActiveSessionConflictInfo>,
}

impl From<ApiCallError> for UiErrorPayload {
    fn from(err: ApiCallError) -> Self {
        let conflict = if err.status == 409 && err.code == "ACTIVE_SESSION_CONFLICT" {
            err.details
                .as_ref()
                .and_then(|d| serde_json::from_value::<ActiveSessionConflictInfo>(d.clone()).ok())
        } else {
            None
        };
        Self {
            status: err.status,
            code: err.code,
            message: err.message,
            conflict,
        }
    }
}

impl From<String> for UiErrorPayload {
    fn from(message: String) -> Self {
        Self {
            status: 0,
            code: "CLIENT_ERROR".to_string(),
            message,
            conflict: None,
        }
    }
}

pub struct AppController {
    pub state: Mutex<RuntimeState>,
    pub api: ApiClient,
    pub queue: EncryptedQueue,
    pub tray: std::sync::Mutex<Option<TrayHandles>>,
    pub scheduler: Mutex<Option<MonotonicCaptureScheduler>>,
    pub ws_outbound_tx: Mutex<Option<mpsc::UnboundedSender<DesktopWsOutbound>>>,
    pub ws_epoch_tx: watch::Sender<u64>,
    pub last_heartbeat_at: Mutex<Option<Instant>>,
    pub heartbeat_lock: Arc<Mutex<()>>,
    pub flush_in_progress: AtomicBool,
    pub is_tracking_atomic: AtomicBool,
}

impl AppController {
    fn new(app_data_dir: PathBuf) -> Result<Arc<Self>, String> {
        let device_id = load_or_create_device_id(&app_data_dir);
        let persisted = load_persisted_state(&app_data_dir);
        let queue = EncryptedQueue::new(&app_data_dir)?;
        let queue_count = queue.count();
        let api = ApiClient::new()?;
        let runtime = RuntimeState::new(app_data_dir, device_id, persisted, queue_count);
        let (ws_epoch_tx, _) = watch::channel(0u64);

        Ok(Arc::new(Self {
            state: Mutex::new(runtime),
            api,
            queue,
            tray: std::sync::Mutex::new(None),
            scheduler: Mutex::new(None),
            ws_outbound_tx: Mutex::new(None),
            ws_epoch_tx,
            last_heartbeat_at: Mutex::new(None),
            heartbeat_lock: Arc::new(Mutex::new(())),
            flush_in_progress: AtomicBool::new(false),
            is_tracking_atomic: AtomicBool::new(false),
        }))
    }

    pub fn bump_ws_epoch(&self) {
        let next = self.ws_epoch_tx.borrow().wrapping_add(1);
        let _ = self.ws_epoch_tx.send(next);
    }
}

async fn emit_snapshot_and_sync_tray(app: &AppHandle<Wry>, controller: &AppController) -> TrackerSnapshot {
    let snapshot = {
        let mut guard = controller.state.lock().await;
        guard.offline_queue_count = controller.queue.count();
        controller
            .is_tracking_atomic
            .store(guard.is_tracking, Ordering::SeqCst);
        guard.snapshot()
    };

    let _ = app.emit("tracker-state", &snapshot);

    if let Ok(tray_guard) = controller.tray.lock() {
        if let Some(handles) = tray_guard.as_ref() {
            tray::sync_tray(handles, &snapshot);
        }
    }

    snapshot
}

async fn current_server_and_token(controller: &AppController) -> Option<(String, String)> {
    let guard = controller.state.lock().await;
    match (
        guard.persisted.server_url.clone(),
        guard.persisted.access_token.clone(),
    ) {
        (Some(url), Some(token)) if !url.is_empty() && !token.is_empty() => Some((url, token)),
        _ => None,
    }
}

async fn force_local_sign_out_with_banner(
    app: &AppHandle<Wry>,
    controller: &AppController,
    reason: &str,
    message: &str,
) {
    {
        let mut guard = controller.state.lock().await;
        let elapsed = guard.current_elapsed_seconds();
        if guard.is_tracking {
            guard.persisted.today_accumulated_seconds = guard
                .persisted
                .today_accumulated_seconds
                .saturating_add(elapsed);
        }
        guard.is_tracking = false;
        guard.session_id = None;
        guard.session_started_at = None;
        guard.session_started_instant = None;
        guard.session_base_seconds = 0;
        guard.ws_status = "disconnected".to_string();
        guard.screen_locked = false;
        guard.persisted.access_token = None;
        guard.persisted.refresh_token = None;
        guard.persisted.user = None;
        guard.force_stop = Some(ForceStopBanner {
            reason: reason.to_string(),
            message: message.to_string(),
            occurred_at_iso: chrono::Utc::now().to_rfc3339(),
        });
        guard.persist();
    }
    *controller.scheduler.lock().await = None;
    *controller.last_heartbeat_at.lock().await = None;
    *controller.ws_outbound_tx.lock().await = None;
    controller.bump_ws_epoch();

    let _ = app
        .notification()
        .builder()
        .title("SM Office Desk — Signed Out")
        .body(message)
        .show();
    tray::show_and_focus_main_window(app);
    let _ = emit_snapshot_and_sync_tray(app, controller).await;
}

async fn stop_local_session_with_banner(
    app: &AppHandle<Wry>,
    controller: &AppController,
    reason: &str,
    message: &str,
) {
    {
        let mut guard = controller.state.lock().await;
        let elapsed = guard.current_elapsed_seconds();
        if guard.is_tracking {
            guard.persisted.today_accumulated_seconds = guard
                .persisted
                .today_accumulated_seconds
                .saturating_add(elapsed);
        }
        guard.is_tracking = false;
        guard.session_id = None;
        guard.session_started_at = None;
        guard.session_started_instant = None;
        guard.session_base_seconds = 0;
        guard.screen_locked = false;
        guard.force_stop = Some(ForceStopBanner {
            reason: reason.to_string(),
            message: message.to_string(),
            occurred_at_iso: chrono::Utc::now().to_rfc3339(),
        });
        guard.persist();
    }
    *controller.scheduler.lock().await = None;
    *controller.last_heartbeat_at.lock().await = None;

    let _ = app
        .notification()
        .builder()
        .title("SM Office Desk — Timer Stopped")
        .body(message)
        .show();
    tray::show_and_focus_main_window(app);
    let _ = emit_snapshot_and_sync_tray(app, controller).await;
}

/// Attempts silent token refresh once when receiving HTTP 401.
async fn try_refresh_tokens(app: &AppHandle<Wry>, controller: &AppController) -> Result<String, ApiCallError> {
    let (server_url, refresh_token) = {
        let mut guard = controller.state.lock().await;
        if guard.refreshing_tokens {
            // Brief yield to avoid concurrent refresh storms.
            drop(guard);
            tokio::time::sleep(Duration::from_millis(250)).await;
            let guard2 = controller.state.lock().await;
            if let Some(tok) = guard2.persisted.access_token.clone() {
                return Ok(tok);
            }
            return Err(ApiCallError {
                status: 401,
                code: "UNAUTHORIZED".to_string(),
                message: "Session expired; please sign in again".to_string(),
                details: None,
                is_network: false,
            });
        }
        guard.refreshing_tokens = true;
        let url = guard.persisted.server_url.clone().unwrap_or_default();
        let rt = guard.persisted.refresh_token.clone().unwrap_or_default();
        (url, rt)
    };

    if server_url.is_empty() || refresh_token.is_empty() {
        controller.state.lock().await.refreshing_tokens = false;
        return Err(ApiCallError {
            status: 401,
            code: "UNAUTHORIZED".to_string(),
            message: "No refresh token available".to_string(),
            details: None,
            is_network: false,
        });
    }

    let res = controller.api.refresh(&server_url, &refresh_token).await;
    {
        let mut guard = controller.state.lock().await;
        guard.refreshing_tokens = false;
        if let Ok(ref tokens) = res {
            guard.persisted.access_token = Some(tokens.access_token.clone());
            guard.persisted.refresh_token = Some(tokens.refresh_token.clone());
            guard.persisted.user = Some(tokens.user.clone());
            guard.persist();
        }
    }

    match res {
        Ok(tokens) => Ok(tokens.access_token),
        Err(err) => {
            if err.status == 401 || err.status == 403 {
                let reason = if err.code == "ACCOUNT_DISABLED" {
                    "account_deactivated"
                } else {
                    "token_revoked"
                };
                force_local_sign_out_with_banner(
                    app,
                    controller,
                    reason,
                    "Your session expired or was revoked. Please sign in again.",
                )
                .await;
            }
            Err(err)
        }
    }
}

async fn handle_fatal_auth_if_applicable(
    app: &AppHandle<Wry>,
    controller: &AppController,
    err: &ApiCallError,
) {
    if err.status == 401 || (err.status == 403 && err.code == "ACCOUNT_DISABLED") {
        let reason = if err.code == "ACCOUNT_DISABLED" {
            "account_deactivated"
        } else {
            "token_revoked"
        };
        let msg = if reason == "account_deactivated" {
            "Your account was deactivated by an administrator."
        } else {
            "Your authentication token was revoked. Please sign in again."
        };
        force_local_sign_out_with_banner(app, controller, reason, msg).await;
    }
}

async fn run_authed_api<F, Fut, T>(
    app: &AppHandle<Wry>,
    controller: &AppController,
    call: F,
) -> Result<T, ApiCallError>
where
    F: Fn(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<T, ApiCallError>>,
{
    let Some((server_url, token)) = current_server_and_token(controller).await else {
        return Err(ApiCallError {
            status: 401,
            code: "UNAUTHORIZED".to_string(),
            message: "Not authenticated".to_string(),
            details: None,
            is_network: false,
        });
    };

    match call(server_url.clone(), token).await {
        Ok(val) => Ok(val),
        Err(err) if err.status == 401 => match try_refresh_tokens(app, controller).await {
            Ok(new_token) => match call(server_url, new_token).await {
                Ok(val) => Ok(val),
                Err(retry_err) => {
                    handle_fatal_auth_if_applicable(app, controller, &retry_err).await;
                    Err(retry_err)
                }
            },
            Err(refresh_err) => Err(refresh_err),
        },
        Err(err) => {
            if err.status == 403 && err.code == "ACCOUNT_DISABLED" {
                handle_fatal_auth_if_applicable(app, controller, &err).await;
            }
            Err(err)
        }
    }
}

async fn perform_capture_and_upload(
    app: &AppHandle<Wry>,
    controller: &Arc<AppController>,
    capture_type: &str,
    request_id: Option<String>,
) {
    let (session_id, is_tracking, monotonic_ms, app_data_dir) = {
        let guard = controller.state.lock().await;
        let ms = {
            let sched_guard = controller.scheduler.lock().await;
            sched_guard
                .as_ref()
                .map(|s| s.monotonic_elapsed_ms(Instant::now()))
                .unwrap_or_else(|| guard.current_elapsed_seconds() * 1000)
        };
        (
            guard.session_id.clone(),
            guard.is_tracking,
            ms,
            guard.app_data_dir.clone(),
        )
    };

    if !is_tracking || session_id.is_none() {
        if let Some(req_id) = request_id {
            send_ws_outbound(
                controller,
                DesktopWsOutbound::CaptureFailed {
                    request_id: req_id,
                    reason: "No active work session".to_string(),
                    error_code: Some("SESSION_NOT_ACTIVE".to_string()),
                },
            )
            .await;
        }
        return;
    }
    let session_id = session_id.unwrap();
    let _ = app_data_dir;

    let capture_res = tokio::task::spawn_blocking(capture_all_monitors_sync).await;
    let outcome = match capture_res {
        Ok(Ok(out)) => out,
        Ok(Err(err_msg)) => {
            if let Some(req_id) = request_id {
                send_ws_outbound(
                    controller,
                    DesktopWsOutbound::CaptureFailed {
                        request_id: req_id,
                        reason: err_msg,
                        error_code: Some("CAPTURE_ERROR".to_string()),
                    },
                )
                .await;
            }
            return;
        }
        Err(join_err) => {
            if let Some(req_id) = request_id {
                send_ws_outbound(
                    controller,
                    DesktopWsOutbound::CaptureFailed {
                        request_id: req_id,
                        reason: format!("Capture worker panicked: {join_err}"),
                        error_code: Some("CAPTURE_ERROR".to_string()),
                    },
                )
                .await;
            }
            return;
        }
    };

    let queued = match outcome {
        CaptureOutcome::PermissionDenied { os, detail } => {
            {
                let mut guard = controller.state.lock().await;
                if os == "macos" {
                    guard.permissions.macos_screen_recording_missing = true;
                } else if os == "linux" {
                    guard.permissions.wayland_portal_needed = true;
                }
                guard.permissions.message = Some(detail.clone());
            }
            let _ = emit_snapshot_and_sync_tray(app, controller).await;
            if let Some(req_id) = request_id {
                send_ws_outbound(
                    controller,
                    DesktopWsOutbound::CaptureFailed {
                        request_id: req_id,
                        reason: detail,
                        error_code: Some("PERMISSION_DENIED".to_string()),
                    },
                )
                .await;
            }
            return;
        }
        CaptureOutcome::ScreenLocked { monitor_count } => {
            {
                let mut guard = controller.state.lock().await;
                guard.screen_locked = true;
            }
            let _ = emit_snapshot_and_sync_tray(app, controller).await;
            QueuedCapture {
                meta: QueuedCaptureMeta {
                    session_id,
                    capture_type: capture_type.to_string(),
                    capture_status: "screen_locked".to_string(),
                    request_id: if capture_type == "on_demand" {
                        request_id.clone()
                    } else {
                        None
                    },
                    monitor_count,
                    width: 0,
                    height: 0,
                    captured_at_client_monotonic_ms: monotonic_ms,
                },
                webp_bytes: Vec::new(),
            }
        }
        CaptureOutcome::Captured(encoded) => {
            {
                let mut guard = controller.state.lock().await;
                guard.screen_locked = false;
                guard.permissions = PermissionWarning::default();
            }
            QueuedCapture {
                meta: QueuedCaptureMeta {
                    session_id,
                    capture_type: capture_type.to_string(),
                    capture_status: "ok".to_string(),
                    request_id: if capture_type == "on_demand" {
                        request_id.clone()
                    } else {
                        None
                    },
                    monitor_count: encoded.monitor_count,
                    width: encoded.width,
                    height: encoded.height,
                    captured_at_client_monotonic_ms: monotonic_ms,
                },
                webp_bytes: encoded.webp_bytes,
            }
        }
    };

    let capture_status_for_ack = queued.meta.capture_status.clone();
    let api = controller.api.clone();
    let queued_clone = queued.clone();

    let upload_res = run_authed_api(app, controller, |server_url, token| {
        let api = api.clone();
        let item = queued_clone.clone();
        async move { api.upload_screenshot(&server_url, &token, &item).await }
    })
    .await;

    match upload_res {
        Ok(screenshot_id) => {
            if let Some(req_id) = request_id {
                send_ws_outbound(
                    controller,
                    DesktopWsOutbound::CaptureAck {
                        request_id: req_id,
                        screenshot_id,
                        capture_status: capture_status_for_ack,
                    },
                )
                .await;
            }
            let _ = emit_snapshot_and_sync_tray(app, controller).await;
        }
        Err(err) => {
            // Queue AES-256-GCM encrypted payload on transient/network/server failure so capture is never lost.
            if err.is_network || err.status >= 500 || err.status == 429 || err.status == 401 {
                if let Err(q_err) = controller.queue.enqueue(&queued) {
                    controller.state.lock().await.last_error = Some(q_err);
                }
            } else {
                controller.state.lock().await.last_error = Some(err.message.clone());
            }

            if let Some(req_id) = request_id {
                send_ws_outbound(
                    controller,
                    DesktopWsOutbound::CaptureFailed {
                        request_id: req_id,
                        reason: err.message,
                        error_code: Some(err.code),
                    },
                )
                .await;
            }
            let _ = emit_snapshot_and_sync_tray(app, controller).await;
        }
    }
}

async fn flush_offline_queue(app: &AppHandle<Wry>, controller: &Arc<AppController>) {
    if controller
        .flush_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    let result = async {
        if current_server_and_token(controller).await.is_none() {
            return;
        }
        let Ok(pending) = controller.queue.list_pending() else {
            return;
        };
        for path in pending {
            let item = match controller.queue.read_item(&path) {
                Ok(it) => it,
                Err(_) => {
                    // Corrupt/unreadable encrypted entry cannot be recovered; remove so FIFO doesn't wedge.
                    let _ = controller.queue.remove_item(&path);
                    continue;
                }
            };

            let api = controller.api.clone();
            let item_clone = item.clone();
            let res = run_authed_api(app, controller, |server_url, token| {
                let api = api.clone();
                let payload = item_clone.clone();
                async move { api.upload_screenshot(&server_url, &token, &payload).await }
            })
            .await;

            match res {
                Ok(_screenshot_id) => {
                    // Wipe encrypted file immediately after HTTP 201 confirmation.
                    let _ = controller.queue.remove_item(&path);
                }
                Err(err) if !err.is_network && (err.status == 400 || err.status == 404 || err.status == 409) => {
                    // Permanent server rejection (e.g. duplicate or deleted session): drop so FIFO proceeds.
                    let _ = controller.queue.remove_item(&path);
                }
                Err(_) => {
                    // Network/5xx/rate-limit/auth: stop flushing and retry later in FIFO order.
                    break;
                }
            }
        }
    }
    .await;
    let _ = result;

    controller.flush_in_progress.store(false, Ordering::SeqCst);
    let _ = emit_snapshot_and_sync_tray(app, controller).await;
}

async fn resolve_effective_location(
    controller: &AppController,
) -> (LocationPayload, LocationStatus) {
    let (location_enabled, ip_fallback_opt_in, prev_loc) = {
        let guard = controller.state.lock().await;
        (
            guard.persisted.location_enabled,
            guard.persisted.ip_fallback_opt_in,
            guard.location.clone(),
        )
    };

    // Strict privacy invariant: when location_enabled == false, zero OS/network calls occur.
    if !location_enabled {
        let status = LocationStatus::default();
        return (LocationPayload::disabled(), status);
    }

    match resolve_location(location_enabled, ip_fallback_opt_in, controller.api.http()).await {
        LocationResolveOutcome::Disabled(payload) => (payload, LocationStatus::default()),
        LocationResolveOutcome::NeedsIpOptIn => {
            let status = LocationStatus {
                location_enabled: true,
                location_source: LocationSource::Disabled,
                latitude: None,
                longitude: None,
                accuracy_meters: None,
                os_permission_denied: true,
                ip_fallback_opt_in: false,
                prompt_ip_fallback: true,
            };
            (LocationPayload::disabled(), status)
        }
        LocationResolveOutcome::Resolved {
            payload,
            source_enum,
        } => {
            let status = LocationStatus {
                location_enabled: true,
                location_source: source_enum.clone(),
                latitude: payload.latitude,
                longitude: payload.longitude,
                accuracy_meters: payload.accuracy_meters,
                os_permission_denied: source_enum == LocationSource::IpApprox || prev_loc.os_permission_denied,
                ip_fallback_opt_in,
                prompt_ip_fallback: false,
            };
            (payload, status)
        }
    }
}

async fn perform_heartbeat(app: &AppHandle<Wry>, controller: &Arc<AppController>) {
    let _hb_guard = controller.heartbeat_lock.lock().await;
    perform_heartbeat_locked(app, controller).await;
}

async fn perform_heartbeat_locked(app: &AppHandle<Wry>, controller: &Arc<AppController>) {
    let (is_tracking, session_id, screen_locked) = {
        let guard = controller.state.lock().await;
        (guard.is_tracking, guard.session_id.clone(), guard.screen_locked)
    };
    if !is_tracking {
        return;
    }
    let Some(session_id) = session_id else {
        return;
    };

    let (loc_payload, loc_status) = resolve_effective_location(controller).await;
    {
        let mut guard = controller.state.lock().await;
        // Re-check persisted flag in case employee toggled OFF concurrently during location resolve.
        if !guard.persisted.location_enabled {
            guard.location = LocationStatus::default();
        } else {
            guard.location = loc_status;
        }
    }

    let final_loc_payload = {
        let guard = controller.state.lock().await;
        if !guard.persisted.location_enabled {
            LocationPayload::disabled()
        } else {
            loc_payload
        }
    };

    let body = HeartbeatBody::from_location(session_id, screen_locked, &final_loc_payload);
    let api = controller.api.clone();
    let res = run_authed_api(app, controller, |server_url, token| {
        let api = api.clone();
        let hb = body.clone();
        async move { api.heartbeat(&server_url, &token, &hb).await }
    })
    .await;

    *controller.last_heartbeat_at.lock().await = Some(Instant::now());

    match res {
        Ok(_hb_resp) => {
            controller.state.lock().await.last_error = None;
        }
        Err(err) => {
            if err.status == 404 || err.status == 409 {
                stop_local_session_with_banner(
                    app,
                    controller,
                    "admin_force_stop",
                    "Session is no longer active on the server and was stopped.",
                )
                .await;
                return;
            }
        }
    }

    let _ = emit_snapshot_and_sync_tray(app, controller).await;
}

async fn send_ws_outbound(controller: &AppController, msg: DesktopWsOutbound) {
    let tx = controller.ws_outbound_tx.lock().await.clone();
    if let Some(sender) = tx {
        let _ = sender.send(msg);
    }
}

async fn run_ws_worker(app: AppHandle<Wry>, controller: Arc<AppController>) {
    let mut epoch_rx = controller.ws_epoch_tx.subscribe();
    let mut backoff_secs: u64 = 1;

    loop {
        let (authenticated, server_url, access_token, device_id, device_os, device_arch, is_tracking) = {
            let guard = controller.state.lock().await;
            let auth = guard.persisted.access_token.is_some() && guard.persisted.user.is_some();
            (
                auth,
                guard.persisted.server_url.clone().unwrap_or_default(),
                guard.persisted.access_token.clone().unwrap_or_default(),
                guard.device_id.clone(),
                guard.device_os.clone(),
                guard.device_arch.clone(),
                guard.is_tracking,
            )
        };

        if !authenticated || server_url.is_empty() || access_token.is_empty() {
            {
                let mut guard = controller.state.lock().await;
                if guard.ws_status != "disconnected" {
                    guard.ws_status = "disconnected".to_string();
                }
            }
            let _ = emit_snapshot_and_sync_tray(&app, &controller).await;
            if epoch_rx.changed().await.is_err() {
                break;
            }
            backoff_secs = 1;
            continue;
        }

        let ws_url = match to_ws_url(&server_url) {
            Ok(u) => u,
            Err(_) => {
                if epoch_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }
        };

        {
            let mut guard = controller.state.lock().await;
            guard.ws_status = if backoff_secs > 1 {
                "reconnecting".to_string()
            } else {
                "connecting".to_string()
            };
        }
        let _ = emit_snapshot_and_sync_tray(&app, &controller).await;

        let connect_fut = connect_async(ws_url.as_str());
        let ws_result = tokio::select! {
            res = connect_fut => Some(res),
            changed = epoch_rx.changed() => {
                if changed.is_err() {
                    return;
                }
                backoff_secs = 1;
                None
            }
        };

        let Some(Ok((ws_stream, _))) = ws_result else {
            if ws_result.is_some() {
                {
                    let mut guard = controller.state.lock().await;
                    guard.ws_status = "reconnecting".to_string();
                }
                let _ = emit_snapshot_and_sync_tray(&app, &controller).await;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                    changed = epoch_rx.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        backoff_secs = 1;
                        continue;
                    }
                }
                backoff_secs = (backoff_secs * 2).min(30);
            }
            continue;
        };

        let (mut write, mut read) = ws_stream.split();
        let auth_msg = DesktopWsOutbound::Auth {
            token: access_token,
            client_type: "desktop",
            device_id,
            device_os,
            device_arch,
            app_version: crate::state::APP_VERSION.to_string(),
        };

        if let Ok(json_str) = serde_json::to_string(&auth_msg) {
            if write.send(Message::text(json_str)).await.is_err() {
                backoff_secs = (backoff_secs * 2).min(30);
                continue;
            }
        }

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<DesktopWsOutbound>();
        *controller.ws_outbound_tx.lock().await = Some(out_tx);

        let writer_handle = tokio::spawn(async move {
            let mut ping_interval = tokio::time::interval(Duration::from_secs(25));
            ping_interval.tick().await;
            loop {
                tokio::select! {
                    maybe_msg = out_rx.recv() => {
                        let Some(msg) = maybe_msg else {
                            break;
                        };
                        if let Ok(raw) = serde_json::to_string(&msg) {
                            if write.send(Message::text(raw)).await.is_err() {
                                break;
                            }
                        }
                    }
                    _ = ping_interval.tick() => {
                        let ping = DesktopWsOutbound::Ping {
                            ts: chrono::Utc::now().timestamp_millis(),
                        };
                        if let Ok(raw) = serde_json::to_string(&ping) {
                            if write.send(Message::text(raw)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });

        let mut conflict_idle_pause = false;

        loop {
            tokio::select! {
                changed = epoch_rx.changed() => {
                    if changed.is_err() {
                        writer_handle.abort();
                        return;
                    }
                    backoff_secs = 1;
                    break;
                }
                maybe_frame = read.next() => {
                    match maybe_frame {
                        Some(Ok(Message::Text(text))) => {
                            let raw: &str = text.as_ref();
                            match serde_json::from_str::<DesktopWsInbound>(raw) {
                                Ok(DesktopWsInbound::AuthOk { .. }) => {
                                    backoff_secs = 1;
                                    {
                                        let mut guard = controller.state.lock().await;
                                        guard.ws_status = "connected".to_string();
                                    }
                                    let _ = emit_snapshot_and_sync_tray(&app, &controller).await;

                                    let app_flush = app.clone();
                                    let ctrl_flush = controller.clone();
                                    tokio::spawn(async move {
                                        flush_offline_queue(&app_flush, &ctrl_flush).await;
                                    });
                                }
                                Ok(DesktopWsInbound::AuthError { code, message }) => {
                                    if code == "ACTIVE_SESSION_CONFLICT" && !is_tracking {
                                        conflict_idle_pause = true;
                                        {
                                            let mut guard = controller.state.lock().await;
                                            guard.ws_status = "disconnected".to_string();
                                        }
                                        let _ = emit_snapshot_and_sync_tray(&app, &controller).await;
                                        break;
                                    } else if code == "TOKEN_REVOKED" || code == "FORBIDDEN" {
                                        force_local_sign_out_with_banner(&app, &controller, "token_revoked", &message).await;
                                        break;
                                    } else if code == "UNAUTHORIZED" {
                                        let _ = try_refresh_tokens(&app, &controller).await;
                                        break;
                                    } else {
                                        controller.state.lock().await.last_error = Some(message);
                                        break;
                                    }
                                }
                                Ok(DesktopWsInbound::CaptureNow { request_id, .. }) => {
                                    let app_cap = app.clone();
                                    let ctrl_cap = controller.clone();
                                    tokio::spawn(async move {
                                        perform_capture_and_upload(&app_cap, &ctrl_cap, "on_demand", Some(request_id)).await;
                                    });
                                }
                                Ok(DesktopWsInbound::ForceStop { reason, message, .. }) => {
                                    if reason == "account_deactivated" || reason == "token_revoked" {
                                        force_local_sign_out_with_banner(&app, &controller, &reason, &message).await;
                                    } else {
                                        stop_local_session_with_banner(&app, &controller, &reason, &message).await;
                                    }
                                    break;
                                }
                                Ok(DesktopWsInbound::Pong { .. }) => {}
                                Err(_) => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        *controller.ws_outbound_tx.lock().await = None;
        writer_handle.abort();

        if conflict_idle_pause {
            // Another device owns the active session while this client is Idle; wait until state/start changes.
            if epoch_rx.changed().await.is_err() {
                break;
            }
            backoff_secs = 1;
            continue;
        }

        let still_auth = {
            let guard = controller.state.lock().await;
            guard.persisted.access_token.is_some() && guard.persisted.user.is_some()
        };
        if still_auth {
            {
                let mut guard = controller.state.lock().await;
                guard.ws_status = "reconnecting".to_string();
            }
            let _ = emit_snapshot_and_sync_tray(&app, &controller).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                changed = epoch_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    backoff_secs = 1;
                }
            }
            backoff_secs = (backoff_secs * 2).min(30);
        }
    }
}

async fn run_tracker_ticker(app: AppHandle<Wry>, controller: Arc<AppController>) {
    let mut tick_interval = tokio::time::interval(Duration::from_secs(1));
    let mut tick_count: u64 = 0;

    loop {
        tick_interval.tick().await;
        tick_count = tick_count.wrapping_add(1);

        let (is_tracking, authenticated, queue_count) = {
            let guard = controller.state.lock().await;
            (
                guard.is_tracking,
                guard.persisted.access_token.is_some() && guard.persisted.user.is_some(),
                controller.queue.count(),
            )
        };

        if is_tracking {
            // Check OS lock screen lightly every 10s so timer badge & tray stay accurate with low overhead.
            if tick_count % 10 == 0 {
                let locked_res = tokio::task::spawn_blocking(crate::lock::check_display_state).await;
                if let Ok(disp) = locked_res {
                    let mut guard = controller.state.lock().await;
                    match disp {
                        crate::lock::DisplayState::ScreenLocked => guard.screen_locked = true,
                        crate::lock::DisplayState::Unlocked => guard.screen_locked = false,
                        crate::lock::DisplayState::PermissionDenied { os, detail } => {
                            if os == "macos" {
                                guard.permissions.macos_screen_recording_missing = true;
                            } else if os == "linux" {
                                guard.permissions.wayland_portal_needed = true;
                            }
                            guard.permissions.message = Some(detail);
                        }
                    }
                }
            }

            // Monotonic random capture interval check (600..=1800s).
            let capture_due = {
                let mut sched_guard = controller.scheduler.lock().await;
                if let Some(sched) = sched_guard.as_mut() {
                    let now = Instant::now();
                    if sched.is_due(now) {
                        sched.schedule_next(now);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            };
            if capture_due {
                let app_cap = app.clone();
                let ctrl_cap = controller.clone();
                tokio::spawn(async move {
                    perform_capture_and_upload(&app_cap, &ctrl_cap, "random", None).await;
                });
            }

            // Monotonic 60s heartbeat + location consent check (never overlap in-flight heartbeats).
            if let Ok(hb_guard) = controller.heartbeat_lock.clone().try_lock_owned() {
                let hb_due = {
                    let last_guard = controller.last_heartbeat_at.lock().await;
                    match *last_guard {
                        None => true,
                        Some(prev) => prev.elapsed() >= Duration::from_secs(HEARTBEAT_INTERVAL_SECONDS),
                    }
                };
                if hb_due {
                    let app_hb = app.clone();
                    let ctrl_hb = controller.clone();
                    tokio::spawn(async move {
                        let _hb_guard = hb_guard;
                        perform_heartbeat_locked(&app_hb, &ctrl_hb).await;
                    });
                }
            }

            let _ = emit_snapshot_and_sync_tray(&app, &controller).await;
        }

        if authenticated && queue_count > 0 && tick_count % 15 == 0 {
            let app_q = app.clone();
            let ctrl_q = controller.clone();
            tokio::spawn(async move {
                flush_offline_queue(&app_q, &ctrl_q).await;
            });
        }
    }
}

async fn apply_start_session_success(
    app: &AppHandle<Wry>,
    controller: &Arc<AppController>,
    session: crate::state::WorkSessionDto,
) -> TrackerSnapshot {
    let base_secs = u64::try_from(session.duration_seconds.max(0)).unwrap_or(0);
    let app_data_dir = {
        let mut guard = controller.state.lock().await;
        guard.is_tracking = true;
        guard.session_id = Some(session.id);
        guard.session_started_at = Some(session.started_at);
        guard.session_started_instant = Some(Instant::now());
        guard.session_base_seconds = base_secs;
        guard.force_stop = None;
        guard.last_error = None;
        guard.app_data_dir.clone()
    };

    *controller.scheduler.lock().await = Some(MonotonicCaptureScheduler::start(Instant::now()));
    *controller.last_heartbeat_at.lock().await = Some(Instant::now());
    controller.bump_ws_epoch();

    // Probe OS capture permissions in background so banner guides macOS/Wayland users promptly.
    let app_perm = app.clone();
    let ctrl_perm = controller.clone();
    tokio::spawn(async move {
        let res = tokio::task::spawn_blocking(move || crate::lock::probe_screen_capture_permission(&app_data_dir)).await;
        if let Ok(Ok(false)) = res {
            let mut guard = ctrl_perm.state.lock().await;
            if cfg!(target_os = "macos") {
                guard.permissions.macos_screen_recording_missing = true;
                guard.permissions.message = Some(
                    "Screen Recording permission is required for mandatory screenshots.".to_string(),
                );
            } else if crate::lock::is_wayland_session() {
                guard.permissions.wayland_portal_needed = true;
                guard.permissions.message = Some(
                    "Wayland Screen Capture Setup required on this Linux desktop.".to_string(),
                );
            }
            drop(guard);
            let _ = emit_snapshot_and_sync_tray(&app_perm, &ctrl_perm).await;
        }
        perform_heartbeat(&app_perm, &ctrl_perm).await;
    });

    emit_snapshot_and_sync_tray(app, controller).await
}

async fn start_timer_internal(
    app: &AppHandle<Wry>,
    controller: &Arc<AppController>,
    override_existing: bool,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let (device_id, device_os, device_arch) = {
        let guard = controller.state.lock().await;
        (
            guard.device_id.clone(),
            guard.device_os.clone(),
            guard.device_arch.clone(),
        )
    };

    let api = controller.api.clone();
    let res = run_authed_api(app, controller, |server_url, token| {
        let api = api.clone();
        let did = device_id.clone();
        let dos = device_os.clone();
        let darch = device_arch.clone();
        async move {
            api.start_session(
                &server_url,
                &token,
                &did,
                &dos,
                &darch,
                crate::state::APP_VERSION,
                override_existing,
            )
            .await
        }
    })
    .await
    .map_err(UiErrorPayload::from)?;

    Ok(apply_start_session_success(app, controller, res.session).await)
}

async fn stop_timer_internal(
    app: &AppHandle<Wry>,
    controller: &Arc<AppController>,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let session_id = {
        let guard = controller.state.lock().await;
        guard.session_id.clone()
    };
    let Some(session_id) = session_id else {
        return Ok(emit_snapshot_and_sync_tray(app, controller).await);
    };

    let api = controller.api.clone();
    let stop_res = run_authed_api(app, controller, |server_url, token| {
        let api = api.clone();
        let sid = session_id.clone();
        async move {
            api.stop_session(&server_url, &token, &sid, "user_stop")
                .await
        }
    })
    .await;

    match stop_res {
        Ok(resp) => {
            let mut guard = controller.state.lock().await;
            let server_dur = u64::try_from(resp.session.duration_seconds.max(0)).unwrap_or(0);
            let local_dur = guard.current_elapsed_seconds();
            let final_dur = server_dur.max(local_dur);
            guard.persisted.today_accumulated_seconds = guard
                .persisted
                .today_accumulated_seconds
                .saturating_add(final_dur);
            guard.is_tracking = false;
            guard.session_id = None;
            guard.session_started_at = None;
            guard.session_started_instant = None;
            guard.session_base_seconds = 0;
            guard.screen_locked = false;
            guard.last_error = None;
            guard.persist();
        }
        Err(err) => {
            // If server says session was already stopped/not found (404/409), settle locally cleanly.
            if err.status == 404 || err.status == 409 {
                let mut guard = controller.state.lock().await;
                let elapsed = guard.current_elapsed_seconds();
                guard.persisted.today_accumulated_seconds = guard
                    .persisted
                    .today_accumulated_seconds
                    .saturating_add(elapsed);
                guard.is_tracking = false;
                guard.session_id = None;
                guard.session_started_at = None;
                guard.session_started_instant = None;
                guard.session_base_seconds = 0;
                guard.screen_locked = false;
                guard.persist();
            } else {
                return Err(UiErrorPayload::from(err));
            }
        }
    }

    *controller.scheduler.lock().await = None;
    *controller.last_heartbeat_at.lock().await = None;

    Ok(emit_snapshot_and_sync_tray(app, controller).await)
}

async fn set_location_consent_internal(
    app: &AppHandle<Wry>,
    controller: &Arc<AppController>,
    enabled: bool,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let was_tracking = {
        let mut guard = controller.state.lock().await;
        guard.persisted.location_enabled = enabled;
        if !enabled {
            guard.persisted.ip_fallback_opt_in = false;
            guard.location = LocationStatus::default();
        } else {
            guard.location.location_enabled = true;
            guard.location.prompt_ip_fallback = false;
        }
        guard.persist();
        guard.is_tracking
    };

    let snap = emit_snapshot_and_sync_tray(app, controller).await;

    if was_tracking {
        perform_heartbeat(app, controller).await;
        return Ok(emit_snapshot_and_sync_tray(app, controller).await);
    }

    if enabled {
        let (_, status) = resolve_effective_location(controller).await;
        {
            let mut guard = controller.state.lock().await;
            if guard.persisted.location_enabled {
                guard.location = status;
            }
        }
    }

    let _ = snap;
    Ok(emit_snapshot_and_sync_tray(app, controller).await)
}

#[tauri::command]
async fn get_bootstrap_info(
    controller: State<'_, Arc<AppController>>,
) -> Result<BootstrapInfo, UiErrorPayload> {
    let guard = controller.state.lock().await;
    Ok(guard.bootstrap_info())
}

#[tauri::command]
async fn get_tracker_snapshot(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    Ok(emit_snapshot_and_sync_tray(&app, controller.inner()).await)
}

#[tauri::command]
async fn restore_session(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let ctrl = controller.inner().clone();
    let has_tokens = current_server_and_token(&ctrl).await.is_some();
    if !has_tokens {
        return Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await);
    }

    let api = ctrl.api.clone();
    let me_res = run_authed_api(&app, &ctrl, |server_url, token| {
        let api = api.clone();
        async move { api.me(&server_url, &token).await }
    })
    .await;

    match me_res {
        Ok(me) => {
            if !me.user.role.eq_ignore_ascii_case("employee") {
                force_local_sign_out_with_banner(
                    &app,
                    &ctrl,
                    "role_rejected",
                    "Use the Admin Web Dashboard for admin accounts.",
                )
                .await;
                return Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await);
            }

            let our_device_id = {
                let mut guard = ctrl.state.lock().await;
                guard.persisted.user = Some(me.user);
                guard.persisted.company = Some(me.company);
                guard.persist();
                guard.device_id.clone()
            };

            if let Some(active) = me.active_session {
                if active.device_id == our_device_id {
                    return Ok(apply_start_session_success(&app, &ctrl, active).await);
                }
            }

            ctrl.bump_ws_epoch();
            Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await)
        }
        Err(err) if err.is_network => {
            // Preserve local tokens when offline so user can view cached profile & retry when online.
            Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await)
        }
        Err(_) => Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await),
    }
}

#[tauri::command]
async fn login(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
    server_url: String,
    email: String,
    password: String,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let normalized_url = normalize_server_url(&server_url).map_err(UiErrorPayload::from)?;
    let ctrl = controller.inner().clone();
    let (device_id, device_arch) = {
        let guard = ctrl.state.lock().await;
        (guard.device_id.clone(), guard.device_arch.clone())
    };

    let tokens = ctrl
        .api
        .login(&normalized_url, &email, &password, &device_id, &device_arch)
        .await
        .map_err(UiErrorPayload::from)?;

    if !tokens.user.role.eq_ignore_ascii_case("employee") {
        let _ = ctrl
            .api
            .logout(&normalized_url, &tokens.access_token, &device_id)
            .await;
        return Err(UiErrorPayload {
            status: 403,
            code: "FORBIDDEN".to_string(),
            message: "Use the Admin Web Dashboard for admin accounts.".to_string(),
            conflict: None,
        });
    }

    let me_res = ctrl.api.me(&normalized_url, &tokens.access_token).await;

    let matching_active_session = {
        let mut guard = ctrl.state.lock().await;
        guard.persisted.server_url = Some(normalized_url);
        guard.persisted.access_token = Some(tokens.access_token);
        guard.persisted.refresh_token = Some(tokens.refresh_token);
        guard.persisted.user = Some(tokens.user);
        guard.force_stop = None;
        guard.last_error = None;
        let active_match = match me_res {
            Ok(me) => {
                guard.persisted.company = Some(me.company);
                me.active_session.filter(|s| s.device_id == guard.device_id)
            }
            Err(_) => None,
        };
        guard.persist();
        active_match
    };

    if let Some(session) = matching_active_session {
        return Ok(apply_start_session_success(&app, &ctrl, session).await);
    }

    ctrl.bump_ws_epoch();
    Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await)
}

#[tauri::command]
async fn logout(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let ctrl = controller.inner().clone();
    let (is_tracking, server_url, access_token, device_id) = {
        let guard = ctrl.state.lock().await;
        (
            guard.is_tracking,
            guard.persisted.server_url.clone().unwrap_or_default(),
            guard.persisted.access_token.clone().unwrap_or_default(),
            guard.device_id.clone(),
        )
    };

    if is_tracking {
        return Err(UiErrorPayload {
            status: 409,
            code: "TRACKER_ACTIVE".to_string(),
            message: "Stop timer before signing out".to_string(),
            conflict: None,
        });
    }

    if !server_url.is_empty() && !access_token.is_empty() {
        let _ = ctrl.api.logout(&server_url, &access_token, &device_id).await;
    }

    {
        let mut guard = ctrl.state.lock().await;
        guard.persisted.access_token = None;
        guard.persisted.refresh_token = None;
        guard.persisted.user = None;
        guard.persisted.company = None;
        guard.ws_status = "disconnected".to_string();
        guard.force_stop = None;
        guard.last_error = None;
        guard.persist();
    }
    ctrl.bump_ws_epoch();

    Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await)
}

#[tauri::command]
async fn start_timer(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
    override_existing: bool,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    start_timer_internal(&app, controller.inner(), override_existing).await
}

#[tauri::command]
async fn stop_timer(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    stop_timer_internal(&app, controller.inner()).await
}

#[tauri::command]
async fn set_location_consent(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
    enabled: bool,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    set_location_consent_internal(&app, controller.inner(), enabled).await
}

#[tauri::command]
async fn set_ip_fallback_opt_in(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
    opt_in: bool,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let ctrl = controller.inner().clone();
    let is_tracking = {
        let mut guard = ctrl.state.lock().await;
        if opt_in {
            guard.persisted.location_enabled = true;
            guard.persisted.ip_fallback_opt_in = true;
            guard.location.location_enabled = true;
            guard.location.ip_fallback_opt_in = true;
            guard.location.prompt_ip_fallback = false;
        } else {
            guard.persisted.location_enabled = false;
            guard.persisted.ip_fallback_opt_in = false;
            guard.location = LocationStatus::default();
        }
        guard.persist();
        guard.is_tracking
    };

    if is_tracking {
        perform_heartbeat(&app, &ctrl).await;
    } else if opt_in {
        let (_, status) = resolve_effective_location(&ctrl).await;
        let mut guard = ctrl.state.lock().await;
        if guard.persisted.location_enabled {
            guard.location = status;
        }
    }

    Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await)
}

#[tauri::command]
async fn dismiss_force_stop(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    {
        let mut guard = controller.state.lock().await;
        guard.force_stop = None;
    }
    Ok(emit_snapshot_and_sync_tray(&app, controller.inner()).await)
}

#[tauri::command]
async fn open_os_permission_settings() -> Result<(), UiErrorPayload> {
    crate::lock::open_os_permission_settings().map_err(UiErrorPayload::from)
}

#[tauri::command]
async fn request_wayland_portal_access(
    app: AppHandle<Wry>,
    controller: State<'_, Arc<AppController>>,
) -> Result<TrackerSnapshot, UiErrorPayload> {
    let ctrl = controller.inner().clone();
    let app_data_dir = ctrl.state.lock().await.app_data_dir.clone();
    let res = tokio::task::spawn_blocking(move || crate::lock::probe_screen_capture_permission(&app_data_dir))
        .await
        .map_err(|e| UiErrorPayload::from(format!("Permission probe failed: {e}")))?
        .map_err(UiErrorPayload::from)?;

    {
        let mut guard = ctrl.state.lock().await;
        if res {
            guard.permissions.wayland_portal_needed = false;
            guard.permissions.macos_screen_recording_missing = false;
            guard.permissions.message = None;
            guard.persisted.wayland_portal_authorized = true;
            guard.persist();
        } else {
            guard.permissions.wayland_portal_needed = true;
            guard.permissions.message = Some(
                "Screen sharing prompt was cancelled or denied. Click Enable Screen Capture to try again."
                    .to_string(),
            );
        }
    }

    Ok(emit_snapshot_and_sync_tray(&app, &ctrl).await)
}

fn handle_tray_menu_action(app: &AppHandle<Wry>, action_id: &str) {
    let app_handle = app.clone();
    match action_id {
        tray::ID_OPEN => {
            tray::show_and_focus_main_window(&app_handle);
        }
        tray::ID_TOGGLE_TIMER => {
            tauri::async_runtime::spawn(async move {
                let Some(ctrl) = app_handle.try_state::<Arc<AppController>>() else {
                    return;
                };
                let ctrl = ctrl.inner().clone();
                let is_tracking = ctrl.state.lock().await.is_tracking;
                if is_tracking {
                    let _ = stop_timer_internal(&app_handle, &ctrl).await;
                } else if let Err(err) = start_timer_internal(&app_handle, &ctrl, false).await {
                    if err.code == "ACTIVE_SESSION_CONFLICT" {
                        let _ = app_handle.emit("session-conflict", &err);
                        tray::show_and_focus_main_window(&app_handle);
                    } else {
                        ctrl.state.lock().await.last_error = Some(err.message);
                        let _ = emit_snapshot_and_sync_tray(&app_handle, &ctrl).await;
                    }
                }
            });
        }
        tray::ID_TOGGLE_LOCATION => {
            tauri::async_runtime::spawn(async move {
                let Some(ctrl) = app_handle.try_state::<Arc<AppController>>() else {
                    return;
                };
                let ctrl = ctrl.inner().clone();
                let next_enabled = {
                    let guard = ctrl.state.lock().await;
                    !guard.persisted.location_enabled
                };
                let _ = set_location_consent_internal(&app_handle, &ctrl, next_enabled).await;
            });
        }
        tray::ID_QUIT => {
            let can_quit = app_handle
                .try_state::<Arc<AppController>>()
                .map(|c| !c.is_tracking_atomic.load(Ordering::SeqCst))
                .unwrap_or(true);
            if can_quit {
                app_handle.exit(0);
            }
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            let controller = AppController::new(app_data_dir)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

            match tray::create_tray(app.handle(), handle_tray_menu_action) {
                Ok(handles) => {
                    if let Ok(mut tray_guard) = controller.tray.lock() {
                        *tray_guard = Some(handles);
                    }
                }
                Err(err) => {
                    eprintln!(
                        "Warning: failed to initialize system tray (continuing without tray): {err}"
                    );
                }
            }

            app.manage(controller.clone());

            let initial_snap = tauri::async_runtime::block_on(emit_snapshot_and_sync_tray(
                app.handle(),
                &controller,
            ));
            let _ = initial_snap;

            let app_ws = app.handle().clone();
            let ctrl_ws = controller.clone();
            tauri::async_runtime::spawn(async move {
                run_ws_worker(app_ws, ctrl_ws).await;
            });

            let app_tick = app.handle().clone();
            let ctrl_tick = controller.clone();
            tauri::async_runtime::spawn(async move {
                run_tracker_ticker(app_tick, ctrl_tick).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app_handle = window.app_handle().clone();
                if let Some(ctrl) = app_handle.try_state::<Arc<AppController>>() {
                    if ctrl.is_tracking_atomic.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let has_tray = ctrl.tray.lock().map(|g| g.is_some()).unwrap_or(false);
                        if has_tray {
                            let _ = window.hide();
                        } else {
                            let _ = window.minimize();
                        }
                        let ctrl_clone = ctrl.inner().clone();
                        tauri::async_runtime::spawn(async move {
                            let should_notify = {
                                let mut guard = ctrl_clone.state.lock().await;
                                let first = !guard.tray_notice_sent;
                                if first {
                                    guard.tray_notice_sent = true;
                                }
                                first
                            };
                            if should_notify {
                                let body = if has_tray {
                                    "Timer is still running in the background. Right-click the tray icon to manage or stop."
                                } else {
                                    "Timer is still running in the background. Restore the minimized window from the taskbar or dock to manage or stop."
                                };
                                let _ = app_handle
                                    .notification()
                                    .builder()
                                    .title("SM Office Desk")
                                    .body(body)
                                    .show();
                            }
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_info,
            get_tracker_snapshot,
            restore_session,
            login,
            logout,
            start_timer,
            stop_timer,
            set_location_consent,
            set_ip_fallback_opt_in,
            dismiss_force_stop,
            open_os_permission_settings,
            request_wayland_portal_access,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SM Office Desk Tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if let Some(ctrl) = app_handle.try_state::<Arc<AppController>>() {
                if ctrl.is_tracking_atomic.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        }
    });
}

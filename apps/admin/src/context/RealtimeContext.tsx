import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CAPTURE_NOW_COOLDOWN_SECONDS,
  CAPTURE_NOW_TIMEOUT_SECONDS,
  type AdminWsOutbound,
  type QuotaSummary,
} from "@sm-office/shared";
import {
  adminApi,
  ApiClientError,
  clearStoredTokens,
  getStoredTokens,
  refreshAccessTokenSingleFlight,
} from "../lib/api";
import type { CaptureUiState, WsConnectionStatus } from "../types/api";
import { useAuth } from "./AuthContext";
import { useToast } from "./ToastContext";

type WsEventListener = (event: AdminWsOutbound) => void;
type RestPollListener = () => void;

interface RealtimeContextValue {
  wsStatus: WsConnectionStatus;
  lastUpdatedAt: number;
  quotas: QuotaSummary | null;
  setQuotas: (next: QuotaSummary) => void;
  refreshQuotas: () => Promise<void>;
  reconnect: () => void;
  subscribeWs: (listener: WsEventListener) => () => void;
  subscribeRestFallbackPoll: (listener: RestPollListener) => () => void;
  captureStates: Record<number, CaptureUiState>;
  triggerCaptureNow: (employeeId: number, employeeName?: string) => Promise<void>;
  clearCaptureAlert: (employeeId: number) => void;
  registerEmployeeNames: (entries: Array<{ id: number; name: string }>) => void;
}

const DEFAULT_CAPTURE_STATE: CaptureUiState = {
  phase: "idle",
  requestId: null,
  remainingSeconds: 0,
  cooldownKind: "captured",
  lastAlert: null,
};

function isJwtNearExpiry(token: string, thresholdMs: number = 15_000): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return true;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = window.atob(base64);
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== "number") return true;
    return payload.exp * 1000 <= Date.now() + thresholdMs;
  } catch {
    return true;
  }
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, logout } = useAuth();
  const { pushToast } = useToast();

  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>("reconnecting");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(() => Date.now());
  const [quotas, setQuotas] = useState<QuotaSummary | null>(null);
  const [captureStates, setCaptureStates] = useState<Record<number, CaptureUiState>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const unmountedRef = useRef<boolean>(false);

  const wsListenersRef = useRef<Set<WsEventListener>>(new Set());
  const pollListenersRef = useRef<Set<RestPollListener>>(new Set());
  const employeeNamesRef = useRef<Map<number, string>>(new Map());
  const handledRequestIdsRef = useRef<Set<string>>(new Set());

  const registerEmployeeNames = useCallback(
    (entries: Array<{ id: number; name: string }>) => {
      for (const entry of entries) {
        employeeNamesRef.current.set(entry.id, entry.name);
      }
    },
    []
  );

  const getEmployeeLabel = useCallback((employeeId: number): string => {
    return employeeNamesRef.current.get(employeeId) ?? `Employee #${employeeId}`;
  }, []);

  const refreshQuotas = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await adminApi.listEmployees({ role: "employee", status: "all" });
      setQuotas(res.quotas);
      registerEmployeeNames(res.users.map((u) => ({ id: u.id, name: u.name })));
    } catch {
      // Handled by apiFetch / individual pages
    }
  }, [isAuthenticated, registerEmployeeNames]);

  useEffect(() => {
    if (isAuthenticated) {
      void refreshQuotas();
    } else {
      setQuotas(null);
    }
  }, [isAuthenticated, refreshQuotas]);

  const markHandledRequest = useCallback((requestId: string) => {
    handledRequestIdsRef.current.add(requestId);
    if (handledRequestIdsRef.current.size > 200) {
      const first = handledRequestIdsRef.current.values().next().value;
      if (first) handledRequestIdsRef.current.delete(first);
    }
  }, []);

  const handleCaptureStatusEvent = useCallback(
    (payload: Extract<AdminWsOutbound, { type: "capture_status" }>["payload"]) => {
      const empId = payload.employee_id;
      const empName = getEmployeeLabel(empId);

      if (payload.status === "pending") {
        setCaptureStates((prev) => {
          const existing = prev[empId];
          if (existing?.phase === "pending" && existing.requestId === payload.request_id) {
            return prev;
          }
          return {
            ...prev,
            [empId]: {
              phase: "pending",
              requestId: payload.request_id,
              remainingSeconds: CAPTURE_NOW_TIMEOUT_SECONDS,
              cooldownKind: "captured",
              lastAlert: null,
            },
          };
        });
        return;
      }

      if (handledRequestIdsRef.current.has(payload.request_id)) {
        return;
      }
      markHandledRequest(payload.request_id);

      if (payload.status === "completed") {
        const isLocked = payload.capture_status === "screen_locked";
        setCaptureStates((prev) => ({
          ...prev,
          [empId]: {
            phase: "cooldown",
            requestId: null,
            remainingSeconds: CAPTURE_NOW_COOLDOWN_SECONDS,
            cooldownKind: isLocked ? "screen_locked" : "captured",
            lastAlert: null,
          },
        }));
        if (isLocked) {
          pushToast({
            variant: "warning",
            title: `${empName}'s screen is currently locked`,
            message: "Screen locked event logged.",
          });
        } else {
          pushToast({
            variant: "success",
            title: `Screenshot captured for ${empName}`,
          });
        }
        return;
      }

      if (payload.status === "timeout") {
        const reason =
          payload.reason ??
          `Device did not respond within ${CAPTURE_NOW_TIMEOUT_SECONDS}s (network lag or sleep).`;
        setCaptureStates((prev) => ({
          ...prev,
          [empId]: {
            phase: "idle",
            requestId: null,
            remainingSeconds: 0,
            cooldownKind: "captured",
            lastAlert: {
              type: "timeout",
              message: reason,
              at: Date.now(),
            },
          },
        }));
        pushToast({
          variant: "warning",
          title: `Capture timeout — ${empName}`,
          message: reason,
        });
        return;
      }

      if (payload.status === "failed") {
        const reason = payload.reason ?? "OS capture permission or device failure.";
        setCaptureStates((prev) => ({
          ...prev,
          [empId]: {
            phase: "idle",
            requestId: null,
            remainingSeconds: 0,
            cooldownKind: "captured",
            lastAlert: {
              type: "failed",
              message: reason,
              at: Date.now(),
            },
          },
        }));
        pushToast({
          variant: "error",
          title: `Capture failed — ${empName}`,
          message: reason,
        });
      }
    },
    [getEmployeeLabel, markHandledRequest, pushToast]
  );

  const handleScreenshotReadyEvent = useCallback(
    (payload: Extract<AdminWsOutbound, { type: "screenshot_ready" }>["payload"]) => {
      const shot = payload.screenshot;
      if (shot.capture_type !== "on_demand" || !shot.request_id) return;
      if (handledRequestIdsRef.current.has(shot.request_id)) return;

      const empId = shot.employee_id;
      const empName = getEmployeeLabel(empId);

      setCaptureStates((prev) => {
        const current = prev[empId];
        if (!current || current.phase !== "pending" || current.requestId !== shot.request_id) {
          return prev;
        }
        markHandledRequest(shot.request_id!);
        const isLocked = shot.capture_status === "screen_locked";
        if (isLocked) {
          pushToast({
            variant: "warning",
            title: `${empName}'s screen is currently locked`,
            message: "Screen locked event logged.",
          });
        } else {
          pushToast({
            variant: "success",
            title: `Screenshot captured for ${empName}`,
          });
        }
        return {
          ...prev,
          [empId]: {
            phase: "cooldown",
            requestId: null,
            remainingSeconds: CAPTURE_NOW_COOLDOWN_SECONDS,
            cooldownKind: isLocked ? "screen_locked" : "captured",
            lastAlert: null,
          },
        };
      });
    },
    [getEmployeeLabel, markHandledRequest, pushToast]
  );

  // 1-second tick for active pending/cooldown countdowns
  useEffect(() => {
    const hasActiveCountdowns = Object.values(captureStates).some(
      (s) => s.phase === "pending" || s.phase === "cooldown"
    );
    if (!hasActiveCountdowns) return;

    const timer = window.setInterval(() => {
      setCaptureStates((prev) => {
        let changed = false;
        const next: Record<number, CaptureUiState> = { ...prev };

        for (const [idStr, state] of Object.entries(prev)) {
          const empId = Number(idStr);
          if (state.phase === "cooldown") {
            changed = true;
            if (state.remainingSeconds <= 1) {
              next[empId] = {
                ...DEFAULT_CAPTURE_STATE,
                lastAlert: state.lastAlert,
              };
            } else {
              next[empId] = {
                ...state,
                remainingSeconds: state.remainingSeconds - 1,
              };
            }
          } else if (state.phase === "pending") {
            changed = true;
            if (state.remainingSeconds <= 1) {
              if (state.requestId) {
                markHandledRequest(state.requestId);
              }
              const msg = `Device did not respond within ${CAPTURE_NOW_TIMEOUT_SECONDS}s (network lag or sleep).`;
              next[empId] = {
                phase: "idle",
                requestId: null,
                remainingSeconds: 0,
                cooldownKind: "captured",
                lastAlert: {
                  type: "timeout",
                  message: msg,
                  at: Date.now(),
                },
              };
            } else {
              next[empId] = {
                ...state,
                remainingSeconds: state.remainingSeconds - 1,
              };
            }
          }
        }

        return changed ? next : prev;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [captureStates, markHandledRequest]);

  const clearTimersAndSocket = useCallback(() => {
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        wsRef.current.close(1000, "Admin client closing");
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
  }, []);

  const connectSocket = useCallback(async () => {
    if (unmountedRef.current || !isAuthenticated) return;
    clearTimersAndSocket();

    let tokens = getStoredTokens();
    if (!tokens) {
      setWsStatus("disconnected");
      return;
    }

    if (isJwtNearExpiry(tokens.access_token)) {
      const refreshed = await refreshAccessTokenSingleFlight();
      if (!refreshed) {
        setWsStatus("disconnected");
        return;
      }
      tokens = getStoredTokens();
      if (!tokens) {
        setWsStatus("disconnected");
        return;
      }
    }

    if (unmountedRef.current) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current || wsRef.current !== ws) return;
      const latestTokens = getStoredTokens();
      if (!latestTokens) {
        ws.close(1000);
        return;
      }
      ws.send(
        JSON.stringify({
          type: "auth",
          payload: {
            token: latestTokens.access_token,
            client_type: "admin_web",
          },
        })
      );
    };

    ws.onmessage = (ev) => {
      if (unmountedRef.current || wsRef.current !== ws) return;
      let parsed: AdminWsOutbound;
      try {
        parsed = JSON.parse(String(ev.data)) as AdminWsOutbound;
      } catch {
        return;
      }

      setLastUpdatedAt(Date.now());

      if (parsed.type === "auth_ok") {
        reconnectAttemptRef.current = 0;
        setWsStatus("connected");
        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current);
        }
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", payload: { ts: Date.now() } }));
          }
        }, 25_000);
      } else if (parsed.type === "auth_error") {
        if (parsed.payload.code === "TOKEN_REVOKED" || parsed.payload.code === "FORBIDDEN") {
          clearStoredTokens();
          void logout();
          return;
        }
        if (parsed.payload.code === "UNAUTHORIZED") {
          void refreshAccessTokenSingleFlight().then((nextTok) => {
            if (nextTok && !unmountedRef.current) {
              void connectSocket();
            }
          });
          return;
        }
      } else if (parsed.type === "capture_status") {
        handleCaptureStatusEvent(parsed.payload);
      } else if (parsed.type === "screenshot_ready") {
        handleScreenshotReadyEvent(parsed.payload);
      } else if (parsed.type === "employee_status" && !parsed.payload.is_online) {
        setCaptureStates((prev) => {
          const existing = prev[parsed.payload.employee_id];
          if (!existing || existing.phase === "idle") return prev;
          return {
            ...prev,
            [parsed.payload.employee_id]: {
              ...DEFAULT_CAPTURE_STATE,
              lastAlert: existing.lastAlert,
            },
          };
        });
      }

      for (const listener of wsListenersRef.current) {
        listener(parsed);
      }
    };

    ws.onerror = () => {
      // onclose handles reconnect scheduling
    };

    ws.onclose = () => {
      if (unmountedRef.current || wsRef.current !== ws) return;
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      wsRef.current = null;

      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current = attempt + 1;

      if (attempt >= 4) {
        setWsStatus("disconnected");
      } else {
        setWsStatus("reconnecting");
      }

      const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 4));
      reconnectTimerRef.current = window.setTimeout(() => {
        void connectSocket();
      }, delayMs);
    };
  }, [
    clearTimersAndSocket,
    handleCaptureStatusEvent,
    handleScreenshotReadyEvent,
    isAuthenticated,
    logout,
  ]);

  useEffect(() => {
    unmountedRef.current = false;
    if (isAuthenticated) {
      reconnectAttemptRef.current = 0;
      setWsStatus("reconnecting");
      void connectSocket();
    } else {
      clearTimersAndSocket();
      setWsStatus("disconnected");
      setCaptureStates({});
    }

    return () => {
      unmountedRef.current = true;
      clearTimersAndSocket();
    };
  }, [clearTimersAndSocket, connectSocket, isAuthenticated]);

  // 15-second REST fallback poll whenever WS is not connected
  useEffect(() => {
    if (!isAuthenticated || wsStatus === "connected") return;

    const timer = window.setInterval(() => {
      setLastUpdatedAt(Date.now());
      for (const poller of pollListenersRef.current) {
        poller();
      }
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, wsStatus]);

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    setWsStatus("reconnecting");
    void connectSocket();
  }, [connectSocket]);

  const subscribeWs = useCallback((listener: WsEventListener) => {
    wsListenersRef.current.add(listener);
    return () => {
      wsListenersRef.current.delete(listener);
    };
  }, []);

  const subscribeRestFallbackPoll = useCallback((listener: RestPollListener) => {
    pollListenersRef.current.add(listener);
    return () => {
      pollListenersRef.current.delete(listener);
    };
  }, []);

  const clearCaptureAlert = useCallback((employeeId: number) => {
    setCaptureStates((prev) => {
      const existing = prev[employeeId];
      if (!existing || !existing.lastAlert) return prev;
      return {
        ...prev,
        [employeeId]: { ...existing, lastAlert: null },
      };
    });
  }, []);

  const triggerCaptureNow = useCallback(
    async (employeeId: number, employeeName?: string) => {
      if (employeeName) {
        employeeNamesRef.current.set(employeeId, employeeName);
      }
      const label = employeeName ?? getEmployeeLabel(employeeId);

      setCaptureStates((prev) => ({
        ...prev,
        [employeeId]: {
          phase: "pending",
          requestId: null,
          remainingSeconds: CAPTURE_NOW_TIMEOUT_SECONDS,
          cooldownKind: "captured",
          lastAlert: null,
        },
      }));

      try {
        const res = await adminApi.captureNow(employeeId);
        setCaptureStates((prev) => {
          // If WS completed before HTTP response resolved, keep current state
          if (handledRequestIdsRef.current.has(res.request_id)) {
            return prev;
          }
          return {
            ...prev,
            [employeeId]: {
              phase: "pending",
              requestId: res.request_id,
              remainingSeconds: res.timeout_seconds,
              cooldownKind: "captured",
              lastAlert: null,
            },
          };
        });
      } catch (err) {
        if (err instanceof ApiClientError) {
          if (err.code === "CAPTURE_COOLDOWN") {
            const wait = err.retryAfterSeconds ?? CAPTURE_NOW_COOLDOWN_SECONDS;
            setCaptureStates((prev) => ({
              ...prev,
              [employeeId]: {
                phase: "cooldown",
                requestId: null,
                remainingSeconds: wait,
                cooldownKind: "captured",
                lastAlert: null,
              },
            }));
            pushToast({
              variant: "info",
              title: `Cooldown active for ${label}`,
              message: `Wait ${wait}s before requesting another capture.`,
            });
            return;
          }
          if (err.code === "CAPTURE_IN_PROGRESS") {
            pushToast({
              variant: "info",
              title: `Capture already pending for ${label}`,
            });
            return;
          }
          setCaptureStates((prev) => ({
            ...prev,
            [employeeId]: {
              ...DEFAULT_CAPTURE_STATE,
              lastAlert: {
                type: "failed",
                message: err.message,
                at: Date.now(),
              },
            },
          }));
          pushToast({
            variant: "warning",
            title: `Could not capture ${label}`,
            message: err.message,
          });
          return;
        }

        const msg = err instanceof Error ? err.message : "Failed to request screenshot";
        setCaptureStates((prev) => ({
          ...prev,
          [employeeId]: {
            ...DEFAULT_CAPTURE_STATE,
            lastAlert: {
              type: "failed",
              message: msg,
              at: Date.now(),
            },
          },
        }));
        pushToast({
          variant: "error",
          title: `Capture request failed`,
          message: msg,
        });
      }
    },
    [getEmployeeLabel, pushToast]
  );

  const value = useMemo<RealtimeContextValue>(
    () => ({
      wsStatus,
      lastUpdatedAt,
      quotas,
      setQuotas,
      refreshQuotas,
      reconnect,
      subscribeWs,
      subscribeRestFallbackPoll,
      captureStates,
      triggerCaptureNow,
      clearCaptureAlert,
      registerEmployeeNames,
    }),
    [
      wsStatus,
      lastUpdatedAt,
      quotas,
      refreshQuotas,
      reconnect,
      subscribeWs,
      subscribeRestFallbackPoll,
      captureStates,
      triggerCaptureNow,
      clearCaptureAlert,
      registerEmployeeNames,
    ]
  );

  return (
    <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error("useRealtime must be used within RealtimeProvider");
  }
  return ctx;
}

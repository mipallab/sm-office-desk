import { AlertOctagon, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LoginView } from "./components/LoginView";
import { TrackerView } from "./components/TrackerView";
import { formatLocalTime, normalizeUnknownError } from "./lib/format";
import { getDefaultBridge } from "./lib/tauriBridge";
import type {
  ActiveSessionConflictInfo,
  BootstrapInfo,
  DesktopBridge,
  TrackerSnapshot,
} from "./types";

export interface AppProps {
  bridge?: DesktopBridge;
}

export function App({ bridge: customBridge }: AppProps) {
  const bridgeRef = useRef<DesktopBridge>(customBridge ?? getDefaultBridge());
  const bridge = bridgeRef.current;

  const [bootstrap, setBootstrap] = useState<BootstrapInfo | null>(null);
  const [snapshot, setSnapshot] = useState<TrackerSnapshot | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ActiveSessionConflictInfo | null>(
    null
  );

  useEffect(() => {
    let mounted = true;
    let unlistenState: (() => void) | undefined;
    let unlistenConflict: (() => void) | undefined;

    const init = async () => {
      try {
        const [bootInfo, restored] = await Promise.all([
          bridge.getBootstrapInfo(),
          bridge.restoreSession(),
        ]);
        if (!mounted) return;
        setBootstrap(bootInfo);
        setSnapshot(restored);

        unlistenState = await bridge.onStateChange((next) => {
          if (mounted) {
            setSnapshot(next);
          }
        });
        unlistenConflict = await bridge.onSessionConflict((err) => {
          if (mounted && err.conflict) {
            setConflict(err.conflict);
          }
        });
      } catch (err) {
        if (mounted) {
          setActionError(normalizeUnknownError(err).message);
        }
      } finally {
        if (mounted) {
          setInitializing(false);
        }
      }
    };

    void init();
    return () => {
      mounted = false;
      unlistenState?.();
      unlistenConflict?.();
    };
  }, [bridge]);

  const handleLogin = async (
    serverUrl: string,
    email: string,
    password: string
  ) => {
    setActionError(null);
    const next = await bridge.login(serverUrl, email, password);
    setSnapshot(next);
  };

  const handleStartTimer = async (overrideExisting: boolean) => {
    setBusyAction("start");
    setActionError(null);
    try {
      const next = await bridge.startTimer(overrideExisting);
      setConflict(null);
      setSnapshot(next);
    } catch (err) {
      const uiErr = normalizeUnknownError(err);
      if (uiErr.code === "ACTIVE_SESSION_CONFLICT" && uiErr.conflict) {
        setConflict(uiErr.conflict);
      } else {
        setActionError(uiErr.message);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleStopTimer = async () => {
    setBusyAction("stop");
    setActionError(null);
    try {
      const next = await bridge.stopTimer();
      setSnapshot(next);
    } catch (err) {
      setActionError(normalizeUnknownError(err).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogout = async () => {
    setBusyAction("logout");
    setActionError(null);
    try {
      const next = await bridge.logout();
      setConflict(null);
      setSnapshot(next);
    } catch (err) {
      setActionError(normalizeUnknownError(err).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleLocation = async (enabled: boolean) => {
    setBusyAction("location");
    setActionError(null);
    try {
      const next = await bridge.setLocationConsent(enabled);
      setSnapshot(next);
    } catch (err) {
      setActionError(normalizeUnknownError(err).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSetIpFallback = async (optIn: boolean) => {
    setBusyAction("ip_fallback");
    setActionError(null);
    try {
      const next = await bridge.setIpFallbackOptIn(optIn);
      setSnapshot(next);
    } catch (err) {
      setActionError(normalizeUnknownError(err).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleDismissForceStop = async () => {
    try {
      const next = await bridge.dismissForceStop();
      setSnapshot(next);
    } catch (err) {
      setActionError(normalizeUnknownError(err).message);
    }
  };

  const handleOpenPermissionSettings = async () => {
    try {
      await bridge.openOsPermissionSettings();
    } catch (err) {
      setActionError(normalizeUnknownError(err).message);
    }
  };

  const handleRequestWaylandPortal = async () => {
    setBusyAction("wayland");
    try {
      const next = await bridge.requestWaylandPortalAccess();
      setSnapshot(next);
    } catch (err) {
      setActionError(normalizeUnknownError(err).message);
    } finally {
      setBusyAction(null);
    }
  };

  if (initializing || !bootstrap || !snapshot) {
    return (
      <main className="flex h-full w-full flex-col items-center justify-center gap-2 bg-slate-50 text-slate-600">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
        <p className="text-xs font-medium">Loading SM Office Desk...</p>
      </main>
    );
  }

  const forceStop = snapshot.force_stop;
  const isAccountDeactivated =
    forceStop?.reason === "account_deactivated" || !snapshot.authenticated;

  return (
    <main className="relative h-full w-full overflow-hidden bg-slate-50">
      {snapshot.authenticated && snapshot.user ? (
        <TrackerView
          bootstrap={bootstrap}
          snapshot={snapshot}
          busyAction={busyAction}
          actionError={actionError}
          conflict={conflict}
          onStartTimer={handleStartTimer}
          onStopTimer={handleStopTimer}
          onDismissConflict={() => setConflict(null)}
          onLogout={handleLogout}
          onToggleLocation={handleToggleLocation}
          onSetIpFallback={handleSetIpFallback}
          onOpenPermissionSettings={handleOpenPermissionSettings}
          onRequestWaylandPortal={handleRequestWaylandPortal}
        />
      ) : (
        <LoginView
          bootstrap={bootstrap}
          initialServerUrl={snapshot.server_url}
          onLogin={handleLogin}
        />
      )}

      {/* FORCE_STOP Blocking Modal (Account Deactivated / Token Revoked / Session Override) */}
      {forceStop ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-live="assertive"
          aria-labelledby="force-stop-title"
          aria-describedby="force-stop-desc"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4"
        >
          <div className="w-full max-w-[320px] rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="flex items-center gap-2 text-rose-700">
              <AlertOctagon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <h2 id="force-stop-title" className="text-sm font-bold text-slate-900">
                {forceStop.reason === "account_deactivated"
                  ? "Account Deactivated"
                  : forceStop.reason === "token_revoked"
                    ? "Session Expired"
                    : "Session Stopped"}
              </h2>
            </div>
            <p
              id="force-stop-desc"
              className="mt-2 text-xs leading-relaxed text-slate-600"
            >
              {forceStop.message} (
              {formatLocalTime(forceStop.occurred_at_iso)}).{" "}
              {forceStop.reason === "account_deactivated"
                ? "Your logged hours remain saved."
                : ""}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                autoFocus
                onClick={handleDismissForceStop}
                className="w-full rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                {isAccountDeactivated ? "Return to Sign In" : "Dismiss"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

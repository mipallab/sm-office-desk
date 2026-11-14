import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type {
  BootstrapInfo,
  DesktopBridge,
  TrackerSnapshot,
  UiErrorPayload,
} from "../src/types";

function makeBootstrap(overrides?: Partial<BootstrapInfo>): BootstrapInfo {
  return {
    app_version: "0.1.0",
    device_id: "12345678-1234-4000-8000-000000000001",
    short_device_id: "dev_123456",
    device_os: "linux",
    device_arch: "x86_64",
    default_server_url: "https://desk.company.com",
    saved_server_url: null,
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<TrackerSnapshot>): TrackerSnapshot {
  return {
    authenticated: true,
    user: {
      id: 2,
      name: "Nadia Rahman",
      email: "nadia@company.com",
      role: "employee",
      designation: "Senior Designer",
      salary_type: "monthly",
      base_salary: 55000,
      is_active: true,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    },
    company: {
      company_name: "SM Creative Studio",
      company_timezone: "Asia/Dhaka",
      currency_code: "BDT",
      retention_days: 90,
    },
    server_url: "https://desk.company.com",
    is_tracking: false,
    session_id: null,
    session_started_at: null,
    elapsed_seconds: 0,
    today_total_seconds: 3720,
    ws_status: "disconnected",
    offline_queue_count: 0,
    screen_locked: false,
    location: {
      location_enabled: false,
      location_source: "disabled",
      latitude: null,
      longitude: null,
      accuracy_meters: null,
      os_permission_denied: false,
      ip_fallback_opt_in: false,
      prompt_ip_fallback: false,
    },
    permissions: {
      macos_screen_recording_missing: false,
      wayland_portal_needed: false,
      message: null,
    },
    force_stop: null,
    last_error: null,
    ...overrides,
  };
}

function createMockBridge(
  initialSnapshot: TrackerSnapshot,
  initialBootstrap = makeBootstrap()
): {
  bridge: DesktopBridge;
  emitState: (snap: TrackerSnapshot) => void;
  setSnapshot: (snap: TrackerSnapshot) => void;
} {
  let current = initialSnapshot;
  let stateListeners: Array<(s: TrackerSnapshot) => void> = [];
  let conflictListeners: Array<(e: UiErrorPayload) => void> = [];

  const bridge: DesktopBridge = {
    getBootstrapInfo: vi.fn(async () => initialBootstrap),
    restoreSession: vi.fn(async () => current),
    getTrackerSnapshot: vi.fn(async () => current),
    login: vi.fn(async () => current),
    logout: vi.fn(async () => {
      current = makeSnapshot({ authenticated: false, user: null });
      return current;
    }),
    startTimer: vi.fn(async () => {
      current = {
        ...current,
        is_tracking: true,
        session_id: "sess-1",
        elapsed_seconds: 12,
        ws_status: "connected",
      };
      return current;
    }),
    stopTimer: vi.fn(async () => {
      current = {
        ...current,
        is_tracking: false,
        session_id: null,
        elapsed_seconds: 0,
        today_total_seconds: current.today_total_seconds + 12,
      };
      return current;
    }),
    setLocationConsent: vi.fn(async (enabled: boolean) => {
      current = {
        ...current,
        location: {
          ...current.location,
          location_enabled: enabled,
          location_source: enabled && current.is_tracking ? "os_native" : "disabled",
          accuracy_meters: enabled && current.is_tracking ? 15 : null,
          prompt_ip_fallback: false,
        },
      };
      return current;
    }),
    setIpFallbackOptIn: vi.fn(async (optIn: boolean) => {
      current = {
        ...current,
        location: {
          ...current.location,
          location_enabled: optIn,
          ip_fallback_opt_in: optIn,
          prompt_ip_fallback: false,
          location_source: optIn ? "ip_approx" : "disabled",
          accuracy_meters: optIn ? 5000 : null,
        },
      };
      return current;
    }),
    dismissForceStop: vi.fn(async () => {
      current = { ...current, force_stop: null };
      return current;
    }),
    openOsPermissionSettings: vi.fn(async () => {}),
    requestWaylandPortalAccess: vi.fn(async () => current),
    onStateChange: vi.fn(async (cb) => {
      stateListeners.push(cb);
      return () => {
        stateListeners = stateListeners.filter((fn) => fn !== cb);
      };
    }),
    onSessionConflict: vi.fn(async (cb) => {
      conflictListeners.push(cb);
      return () => {
        conflictListeners = conflictListeners.filter((fn) => fn !== cb);
      };
    }),
  };

  return {
    bridge,
    setSnapshot(snap) {
      current = snap;
    },
    emitState(snap) {
      current = snap;
      for (const cb of stateListeners) cb(snap);
    },
  };
}

describe("SM Office Desk Desktop UI", () => {
  it("renders login view, collapses preconfigured Server URL, and enforces admin role guard", async () => {
    const user = userEvent.setup();
    const { bridge } = createMockBridge(
      makeSnapshot({ authenticated: false, user: null }),
      makeBootstrap({ default_server_url: "https://desk.company.com" })
    );

    vi.mocked(bridge.login).mockRejectedValueOnce({
      status: 403,
      code: "FORBIDDEN",
      message: "Employee role required",
      conflict: null,
    } satisfies UiErrorPayload);

    render(<App bridge={bridge} />);

    expect(await screen.findByText("Employee Work Tracker")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("https://desk.company.com")).not.toBeInTheDocument();
    expect(screen.getByText(/v0\.1\.0 · linux-x86_64 · Device: dev_123456/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Work Email/i), "admin@company.com");
    await user.type(screen.getByLabelText("Password"), "secret1234");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(bridge.login).toHaveBeenCalledWith(
      "https://desk.company.com",
      "admin@company.com",
      "secret1234"
    );
    expect(
      await screen.findByText("Admin accounts manage the team on the Web Dashboard.")
    ).toBeInTheDocument();
  });

  it("auto-expands Server URL on missing URL validation and shows deactivated message on 403 ACCOUNT_DISABLED", async () => {
    const user = userEvent.setup();
    const { bridge } = createMockBridge(
      makeSnapshot({ authenticated: false, user: null, server_url: "" }),
      makeBootstrap({ default_server_url: null, saved_server_url: null })
    );

    render(<App bridge={bridge} />);

    const serverInput = await screen.findByPlaceholderText("https://desk.company.com");
    expect(serverInput).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Work Email/i), "nadia@company.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.clear(serverInput);
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Server URL is required/i);

    vi.mocked(bridge.login).mockRejectedValueOnce({
      status: 403,
      code: "ACCOUNT_DISABLED",
      message: "Disabled",
      conflict: null,
    } satisfies UiErrorPayload);

    await user.type(serverInput, "desk.company.com/");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(bridge.login).toHaveBeenCalledWith(
      "https://desk.company.com",
      "nadia@company.com",
      "password123"
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account deactivated by admin. Contact your manager."
    );
  });

  it("locks mandatory screenshot auditing with zero pause/disable/blur/delete controls and disables Sign Out while active", async () => {
    const user = userEvent.setup();
    const { bridge } = createMockBridge(makeSnapshot({ is_tracking: false }));

    render(<App bridge={bridge} />);

    expect(await screen.findByText("Screenshot Auditing Ready")).toBeInTheDocument();
    expect(screen.getByText("Today's Total: 01h 02m")).toBeInTheDocument();

    // Only one switch exists in the entire app: Share Live Location (zero screenshot switches/buttons).
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(1);
    expect(switches[0]).toHaveAccessibleName("Share Live Location");

    const forbiddenControls = [
      /pause screenshot/i,
      /disable screenshot/i,
      /delay screenshot/i,
      /blur screenshot/i,
      /preview screenshot/i,
      /delete screenshot/i,
    ];
    for (const pattern of forbiddenControls) {
      expect(screen.queryByRole("button", { name: pattern })).not.toBeInTheDocument();
      expect(screen.queryByRole("switch", { name: pattern })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: pattern })).not.toBeInTheDocument();
    }

    const signOutIdle = screen.getByRole("button", { name: /Sign out/i });
    expect(signOutIdle).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Start Timer/i }));

    expect(await screen.findByText("Screenshot Auditing Active")).toBeInTheDocument();
    expect(screen.getByText(/Closing window minimizes to tray\./i)).toBeInTheDocument();

    const signOutActive = screen.getByRole("button", {
      name: /Stop timer before signing out/i,
    });
    expect(signOutActive).toBeDisabled();
    expect(signOutActive).toHaveAttribute("aria-disabled", "true");
    expect(signOutActive).toHaveAttribute("title", "Stop timer before signing out");

    // Still strictly 1 switch (location) and zero screenshot controls when active.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("enforces strict explicit location consent copy, OS denied IP opt-in prompt, and immediate OFF toggle sync", async () => {
    const user = userEvent.setup();
    const { bridge, emitState } = createMockBridge(makeSnapshot({ is_tracking: false }));

    render(<App bridge={bridge} />);

    expect(
      await screen.findByText(
        "Disabled — Zero GPS coordinates or IP location data are collected."
      )
    ).toBeInTheDocument();

    // Toggle ON while stopped
    const locSwitch = screen.getByRole("switch", { name: "Share Live Location" });
    expect(locSwitch).toHaveAttribute("aria-checked", "false");
    await user.click(locSwitch);

    expect(bridge.setLocationConsent).toHaveBeenCalledWith(true);
    expect(
      await screen.findByText(
        "Enabled — Coordinates are transmitted only after you click Start Timer."
      )
    ).toBeInTheDocument();

    // Active + OS precise
    act(() => {
      emitState(
        makeSnapshot({
          is_tracking: true,
          ws_status: "connected",
          location: {
            location_enabled: true,
            location_source: "os_native",
            latitude: 23.81,
            longitude: 90.41,
            accuracy_meters: 15,
            os_permission_denied: false,
            ip_fallback_opt_in: false,
            prompt_ip_fallback: false,
          },
        })
      );
    });
    expect(
      await screen.findByText("Sharing active · Source: OS Precise (±15m)")
    ).toBeInTheDocument();

    // OS denied -> explicit prompt
    act(() => {
      emitState(
        makeSnapshot({
          is_tracking: true,
          ws_status: "connected",
          location: {
            location_enabled: true,
            location_source: "disabled",
            latitude: null,
            longitude: null,
            accuracy_meters: null,
            os_permission_denied: true,
            ip_fallback_opt_in: false,
            prompt_ip_fallback: true,
          },
        })
      );
    });
    expect(await screen.findByText("Location permission needed")).toBeInTheDocument();
    expect(
      screen.getByText(/OS location denied\. Allow access in OS Privacy Settings/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enable IP Approx" }));
    expect(bridge.setIpFallbackOptIn).toHaveBeenCalledWith(true);
    expect(
      await screen.findByText("Sharing active · Source: IP Approx (±5km)")
    ).toBeInTheDocument();

    // Flipping switch OFF while tracking calls setLocationConsent(false) and restores zero-collection copy
    await user.click(screen.getByRole("switch", { name: "Share Live Location" }));
    await waitFor(() => {
      expect(bridge.setLocationConsent).toHaveBeenCalledWith(false);
    });
    expect(
      await screen.findByText(
        "Disabled — Zero GPS coordinates or IP location data are collected."
      )
    ).toBeInTheDocument();
  });

  it("handles 409 ACTIVE_SESSION_CONFLICT override modal and FORCE_STOP blocking alert", async () => {
    const user = userEvent.setup();
    const { bridge, emitState } = createMockBridge(makeSnapshot({ is_tracking: false }));

    vi.mocked(bridge.startTimer).mockRejectedValueOnce({
      status: 409,
      code: "ACTIVE_SESSION_CONFLICT",
      message: "Employee already has an active session on another device",
      conflict: {
        active_session_id: "sess-old",
        active_device_id: "abcdef1234567890",
        active_device_os: "windows",
        started_at: "2026-11-14T08:00:00Z",
      },
    } satisfies UiErrorPayload);

    render(<App bridge={bridge} />);

    await user.click(await screen.findByRole("button", { name: /Start Timer/i }));
    expect(
      await screen.findByText("Active Session on Another Device")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Override & Start Here/i }));
    expect(bridge.startTimer).toHaveBeenLastCalledWith(true);
    expect(await screen.findByText("Tracking Active")).toBeInTheDocument();

    // FORCE_STOP account deactivated blocks screen and returns to sign in on click
    act(() => {
      emitState(
        makeSnapshot({
          authenticated: false,
          user: null,
          is_tracking: false,
          force_stop: {
            reason: "account_deactivated",
            message: "Your account was deactivated by an administrator.",
            occurred_at_iso: "2026-11-14T14:35:00Z",
          },
        })
      );
    });

    const modal = await screen.findByRole("alertdialog");
    expect(modal).toHaveTextContent("Account Deactivated");
    await user.click(screen.getByRole("button", { name: "Return to Sign In" }));
    expect(bridge.dismissForceStop).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Sign In" })).toBeInTheDocument();
  });
});

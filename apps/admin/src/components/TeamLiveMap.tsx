import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { Crosshair, Globe, MapPinOff, Navigation } from "lucide-react";
import {
  formatAccuracyDistance,
  getInitials,
  safeFormatTimezoneParts,
} from "../lib/format";
import type { LiveEmployeeLocation } from "../types/api";

interface TeamLiveMapProps {
  locations: LiveEmployeeLocation[];
  companyTimezone: string;
  focusRequest: { employeeId: number; nonce: number } | null;
  onFocusCard: (employeeId: number) => void;
  onTriggerCapture: (employeeId: number, employeeName: string) => void;
}

const DEFAULT_CENTER: [number, number] = [23.8103, 90.4125];
const DEFAULT_ZOOM = 11;

function createPinIcon(loc: LiveEmployeeLocation): L.DivIcon {
  const initials = getInitials(loc.employee_name);
  const ringColor = loc.source === "os_native" ? "#0F766E" : "#0369A1";
  const bgSoft = loc.source === "os_native" ? "#F0FDFA" : "#F0F9FF";

  const wrapper = document.createElement("div");
  wrapper.style.position = "relative";
  wrapper.style.width = "34px";
  wrapper.style.height = "34px";
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "center";
  wrapper.style.justifyContent = "center";
  wrapper.style.borderRadius = "9999px";
  wrapper.style.backgroundColor = bgSoft;
  wrapper.style.border = `3px solid ${ringColor}`;
  wrapper.style.color = ringColor;
  wrapper.style.fontWeight = "700";
  wrapper.style.fontSize = "11px";
  wrapper.style.boxShadow = "0 2px 8px rgba(15, 23, 42, 0.22)";
  wrapper.textContent = initials;

  const dot = document.createElement("span");
  dot.style.position = "absolute";
  dot.style.top = "-2px";
  dot.style.right = "-2px";
  dot.style.width = "10px";
  dot.style.height = "10px";
  dot.style.borderRadius = "9999px";
  dot.style.backgroundColor = "#10B981";
  dot.style.border = "2px solid #FFFFFF";
  wrapper.appendChild(dot);

  return L.divIcon({
    html: wrapper,
    className: "sm-map-pin-wrapper",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

function createPopupElement(
  loc: LiveEmployeeLocation,
  companyTimezone: string,
  onFocusCard: (id: number) => void,
  onTriggerCapture: (id: number, name: string) => void
): HTMLElement {
  const root = document.createElement("div");
  root.className = "min-w-[210px] space-y-2 text-slate-900";

  const header = document.createElement("div");
  const nameEl = document.createElement("p");
  nameEl.className = "text-sm font-semibold text-slate-900 m-0";
  nameEl.textContent = loc.employee_name;
  header.appendChild(nameEl);

  const badgeEl = document.createElement("p");
  badgeEl.className = "mt-0.5 text-xs font-medium text-slate-600 m-0";
  const sourceText = loc.source === "os_native" ? "OS Precise" : "IP Approx";
  badgeEl.textContent = `${sourceText} (${formatAccuracyDistance(loc.accuracy_meters)})`;
  header.appendChild(badgeEl);

  if (loc.recorded_at) {
    const timeEl = document.createElement("p");
    timeEl.className = "mt-0.5 font-mono text-[11px] text-slate-500 m-0 tabular-nums";
    const parts = safeFormatTimezoneParts(loc.recorded_at, companyTimezone);
    timeEl.textContent = `Updated: ${parts.timeString} ${companyTimezone}`;
    header.appendChild(timeEl);
  }
  root.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "flex items-center gap-1.5 pt-1";

  const focusBtn = document.createElement("button");
  focusBtn.type = "button";
  focusBtn.className =
    "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50";
  focusBtn.textContent = "Focus Card";
  focusBtn.addEventListener("click", (e) => {
    e.preventDefault();
    onFocusCard(loc.employee_id);
  });

  const capBtn = document.createElement("button");
  capBtn.type = "button";
  capBtn.className =
    "rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700";
  capBtn.textContent = "Take Screenshot Now";
  capBtn.addEventListener("click", (e) => {
    e.preventDefault();
    onTriggerCapture(loc.employee_id, loc.employee_name);
  });

  actions.appendChild(focusBtn);
  actions.appendChild(capBtn);
  root.appendChild(actions);

  return root;
}

export function TeamLiveMap({
  locations,
  companyTimezone,
  focusRequest,
  onFocusCard,
  onTriggerCapture,
}: TeamLiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<number, L.Marker>>(new Map());
  const circlesRef = useRef<Map<number, L.Circle>>(new Map());
  const hasAutoFittedRef = useRef<boolean>(false);

  const onFocusCardRef = useRef(onFocusCard);
  const onTriggerCaptureRef = useRef(onTriggerCapture);
  onFocusCardRef.current = onFocusCard;
  onTriggerCaptureRef.current = onTriggerCapture;

  const activeSharing = useMemo(
    () =>
      locations.filter(
        (loc) =>
          loc.is_online &&
          loc.sharing_enabled &&
          loc.latitude !== null &&
          loc.longitude !== null
      ),
    [locations]
  );

  const onlineDisabled = useMemo(
    () => locations.filter((loc) => loc.is_online && !loc.sharing_enabled),
    [locations]
  );

  const osNativeCount = useMemo(
    () => activeSharing.filter((l) => l.source === "os_native").length,
    [activeSharing]
  );
  const ipApproxCount = useMemo(
    () => activeSharing.filter((l) => l.source === "ip_approx").length,
    [activeSharing]
  );

  // Initialize Leaflet map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;

    return () => {
      markersRef.current.clear();
      circlesRef.current.clear();
      map.remove();
      mapRef.current = null;
      hasAutoFittedRef.current = false;
    };
  }, []);

  const fitAllMarkers = (animate: boolean = true) => {
    const map = mapRef.current;
    if (!map) return;
    if (activeSharing.length === 0) {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate });
      return;
    }

    if (activeSharing.length === 1 && activeSharing[0]) {
      const only = activeSharing[0];
      const zoom = only.source === "os_native" ? 15 : 12;
      map.setView([only.latitude!, only.longitude!], zoom, { animate });
      return;
    }

    // Fit strictly over marker centers so large IP accuracy circles do not distort map zoom
    const bounds = L.latLngBounds(
      activeSharing.map((loc) => [loc.latitude!, loc.longitude!] as [number, number])
    );
    map.fitBounds(bounds, {
      padding: [48, 48],
      maxZoom: 15,
      animate,
    });
  };

  // Sync markers and accuracy circles
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const activeIds = new Set(activeSharing.map((l) => l.employee_id));

    for (const [empId, marker] of markersRef.current.entries()) {
      if (!activeIds.has(empId)) {
        marker.remove();
        markersRef.current.delete(empId);
      }
    }
    for (const [empId, circle] of circlesRef.current.entries()) {
      if (!activeIds.has(empId)) {
        circle.remove();
        circlesRef.current.delete(empId);
      }
    }

    for (const loc of activeSharing) {
      const latLng: [number, number] = [loc.latitude!, loc.longitude!];
      const radius = Math.max(10, loc.accuracy_meters ?? (loc.source === "os_native" ? 25 : 5000));
      const circleStyle: L.CircleMarkerOptions =
        loc.source === "os_native"
          ? {
              color: "#0D9488",
              fillColor: "#0D9488",
              weight: 2,
              fillOpacity: 0.14,
            }
          : {
              color: "#0284C7",
              fillColor: "#0284C7",
              dashArray: "6 4",
              weight: 2,
              fillOpacity: 0.08,
            };

      const existingCircle = circlesRef.current.get(loc.employee_id);
      if (existingCircle) {
        existingCircle.setLatLng(latLng);
        existingCircle.setRadius(radius);
        existingCircle.setStyle(circleStyle);
      } else {
        const circle = L.circle(latLng, { ...circleStyle, radius }).addTo(map);
        circlesRef.current.set(loc.employee_id, circle);
      }

      const popupEl = createPopupElement(
        loc,
        companyTimezone,
        (id) => onFocusCardRef.current(id),
        (id, name) => onTriggerCaptureRef.current(id, name)
      );

      const existingMarker = markersRef.current.get(loc.employee_id);
      if (existingMarker) {
        existingMarker.setLatLng(latLng);
        existingMarker.setIcon(createPinIcon(loc));
        const popup = existingMarker.getPopup();
        if (popup) {
          popup.setContent(popupEl);
        } else {
          existingMarker.bindPopup(popupEl);
        }
      } else {
        const marker = L.marker(latLng, { icon: createPinIcon(loc) })
          .addTo(map)
          .bindPopup(popupEl);
        markersRef.current.set(loc.employee_id, marker);
      }
    }

    if (!hasAutoFittedRef.current && activeSharing.length > 0) {
      hasAutoFittedRef.current = true;
      fitAllMarkers(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSharing, companyTimezone]);

  // Focus specific employee pin when requested from card pill
  useEffect(() => {
    if (!focusRequest) return;
    const map = mapRef.current;
    const target = activeSharing.find((l) => l.employee_id === focusRequest.employeeId);
    const marker = markersRef.current.get(focusRequest.employeeId);
    if (!map || !target || !marker) return;

    const targetZoom = target.source === "os_native" ? 15 : 12;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    if (prefersReducedMotion) {
      map.setView([target.latitude!, target.longitude!], targetZoom, { animate: false });
    } else {
      map.flyTo([target.latitude!, target.longitude!], targetZoom, { duration: 0.5 });
    }
    marker.openPopup();
  }, [focusRequest, activeSharing]);

  return (
    <section
      aria-label="Live team location map"
      className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-[15px] font-semibold text-slate-900">
            Live Team Map
          </h2>
          <p className="text-xs text-slate-500">
            OpenStreetMap · Consented employees only
          </p>
        </div>

        <button
          type="button"
          onClick={() => fitAllMarkers(true)}
          disabled={activeSharing.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
        >
          <Crosshair className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          Fit All Active
        </button>
      </div>

      {/* Map Canvas */}
      <div className="relative h-[420px] w-full bg-slate-100 xl:h-[480px]">
        <div ref={containerRef} className="h-full w-full" />
        {activeSharing.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-4 bottom-4 z-[400] flex justify-center">
            <div className="rounded-xl border border-slate-200 bg-white/95 px-3.5 py-2 text-xs font-medium text-slate-700 shadow-md backdrop-blur">
              No active employees are currently sharing live coordinates.
            </div>
          </div>
        ) : null}
      </div>

      {/* Location Privacy Summary */}
      <div className="space-y-3 border-t border-slate-200 bg-slate-50/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Location Privacy Summary
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2 py-0.5 font-medium text-teal-800">
              <Navigation className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
              {osNativeCount} OS Precise
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 font-medium text-sky-800">
              <Globe className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
              {ipApproxCount} IP Approx
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex items-start gap-2">
            <MapPinOff
              className="mt-0.5 h-4 w-4 shrink-0 text-slate-500"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 text-xs">
              <p className="font-semibold text-slate-800">
                Location Disabled by Employee ({onlineDisabled.length})
              </p>
              {onlineDisabled.length > 0 ? (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {onlineDisabled.map((emp) => (
                    <li key={emp.employee_id}>
                      <button
                        type="button"
                        onClick={() => onFocusCard(emp.employee_id)}
                        className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                      >
                        {emp.employee_name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-0.5 text-slate-500">
                  No active tracking employees have location disabled right now.
                </p>
              )}
              <p className="mt-1.5 text-[11px] text-slate-500">
                Zero coordinates or server-side IP geolocation fallback are collected when disabled.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

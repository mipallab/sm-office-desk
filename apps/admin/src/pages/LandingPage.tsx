import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  KeyRound,
  Laptop,
  MapPin,
  Monitor,
  PlayCircle,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";

const RELEASE_TAG = "desktop-v0.1.3";
const RELEASE_VERSION = "0.1.3";
const RELEASE_BASE_URL = `https://github.com/mipallab/sm-office-desk/releases/download/${RELEASE_TAG}`;
const RELEASE_PAGE_URL = `https://github.com/mipallab/sm-office-desk/releases/tag/${RELEASE_TAG}`;

const DOWNLOADS = {
  windowsSetupX64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_windows_x64-setup.exe`,
  windowsPortableX64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_windows_x64-portable.exe`,
  windowsMsiX64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_windows_x64.msi`,
  windowsSetupArm64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_windows_arm64-setup.exe`,
  linuxDebX64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_linux_amd64.deb`,
  linuxRpmX64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_linux_x86_64.rpm`,
  linuxAppImageX64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_linux_amd64.AppImage`,
  linuxDebArm64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_linux_arm64.deb`,
  linuxRpmArm64: `${RELEASE_BASE_URL}/SM-Office-Desk_${RELEASE_VERSION}_linux_aarch64.rpm`,
  checksums: `${RELEASE_BASE_URL}/SHA256SUMS.txt`,
};

type DetectedOS = "windows" | "linux" | "other";

function detectClientOS(): DetectedOS {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  return "other";
}

export function LandingPage() {
  const { isAuthenticated } = useAuth();
  const [detectedOS] = useState<DetectedOS>(() => detectClientOS());
  const [copiedUrl, setCopiedUrl] = useState(false);

  const serverUrl =
    typeof window !== "undefined" && window.location.origin
      ? window.location.origin
      : "https://sm-office-desk.onrender.com";

  useEffect(() => {
    if (!copiedUrl) return;
    const timer = window.setTimeout(() => setCopiedUrl(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copiedUrl]);

  const handleCopyServerUrl = async () => {
    try {
      await navigator.clipboard.writeText(serverUrl);
      setCopiedUrl(true);
    } catch {
      // Fallback for non-clipboard environments
      const input = document.createElement("input");
      input.value = serverUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopiedUrl(true);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Navigation */}
      <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
              <ShieldCheck className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div>
              <span className="block text-base font-bold tracking-tight text-slate-900">
                SM Office Desk
              </span>
              <span className="block text-[11px] font-medium text-slate-500">
                Employee Work &amp; Activity Tracker
              </span>
            </div>
          </Link>

          <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex">
            <a
              href="#downloads"
              className="transition-colors hover:text-indigo-600"
            >
              Download App
            </a>
            <a
              href="#setup"
              className="transition-colors hover:text-indigo-600"
            >
              Setup Guide
            </a>
            <a
              href="#features"
              className="transition-colors hover:text-indigo-600"
            >
              Features
            </a>
          </nav>

          <div className="flex items-center gap-2.5">
            <a
              href="#downloads"
              className="hidden items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 sm:inline-flex"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Desktop App
            </a>
            <Link
              to={isAuthenticated ? "/monitor" : "/login"}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 sm:text-sm"
            >
              <span>{isAuthenticated ? "Open Admin Dashboard" : "Admin Console Login"}</span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-slate-200 bg-gradient-to-b from-white via-indigo-50/40 to-slate-50 py-14 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              <Laptop className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Desktop Tracker v{RELEASE_VERSION} — Windows &amp; Linux (64-bit)
            </span>

            <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
              Download SM Office Desk{" "}
              <span className="text-indigo-600">Employee Tracker</span>
            </h1>

            <p className="mt-4 text-base leading-relaxed text-slate-600 sm:text-lg">
              Lightweight desktop application for team attendance, active work timer,
              automated screenshot verification, and seamless payroll reporting.
              Download for your computer below and connect in seconds.
            </p>

            {/* Primary OS-Aware Download Buttons */}
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              {detectedOS === "linux" ? (
                <>
                  <a
                    href={DOWNLOADS.linuxDebX64}
                    className="inline-flex w-full items-center justify-center gap-2.5 rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 sm:w-auto"
                  >
                    <Terminal className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden="true" />
                    Download for Linux (.deb)
                  </a>
                  <a
                    href={DOWNLOADS.windowsSetupX64}
                    className="inline-flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-semibold text-slate-800 shadow-xs transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 sm:w-auto"
                  >
                    <Monitor className="h-4.5 w-4.5 text-indigo-600" strokeWidth={1.75} aria-hidden="true" />
                    Download for Windows (.exe)
                  </a>
                </>
              ) : (
                <>
                  <a
                    href={DOWNLOADS.windowsSetupX64}
                    className="inline-flex w-full items-center justify-center gap-2.5 rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 sm:w-auto"
                  >
                    <Monitor className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden="true" />
                    Download for Windows (.exe)
                  </a>
                  <a
                    href="#downloads"
                    className="inline-flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-semibold text-slate-800 shadow-xs transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 sm:w-auto"
                  >
                    <Terminal className="h-4.5 w-4.5 text-emerald-600" strokeWidth={1.75} aria-hidden="true" />
                    Download for Linux (.deb / .rpm)
                  </a>
                </>
              )}
            </div>

            <p className="mt-3 text-xs text-slate-500">
              Free for all registered organization employees &bull; No local Administrator password required on Windows
            </p>

            {/* Server URL Copy Widget */}
            <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <Server className="h-3.5 w-3.5 text-indigo-600" strokeWidth={1.75} aria-hidden="true" />
                  Server Connection URL (Paste into Desktop App)
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                  Live
                </span>
              </div>
              <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs font-medium text-slate-800 sm:text-sm">
                  {serverUrl}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyServerUrl()}
                  className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                    copiedUrl
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-900 text-white hover:bg-slate-800"
                  }`}
                >
                  {copiedUrl ? (
                    <>
                      <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Copy Server URL
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Download Cards Section */}
      <section id="downloads" className="py-14 sm:py-18">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Choose Your Operating System
            </h2>
            <p className="mt-2 text-sm text-slate-600 sm:text-base">
              Direct installers for Windows and Linux workstations. Select the package that matches your device.
            </p>
          </div>

          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            {/* Windows Card */}
            <div
              className={`flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-xs sm:p-8 ${
                detectedOS === "windows"
                  ? "border-indigo-300 ring-2 ring-indigo-600/10"
                  : "border-slate-200"
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                      <Monitor className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">
                        Windows 10 &amp; 11 (64-bit)
                      </h3>
                      <p className="text-xs font-medium text-slate-500">
                        x64 &amp; ARM64 &bull; Version {RELEASE_VERSION}
                      </p>
                    </div>
                  </div>
                  {detectedOS === "windows" ? (
                    <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
                      Your OS
                    </span>
                  ) : null}
                </div>

                <p className="mt-4 text-sm leading-relaxed text-slate-600">
                  Recommended: Use the standard <strong>.exe Setup Installer</strong>. It installs cleanly for the current user without requiring administrator privileges.
                </p>

                <div className="mt-6">
                  <a
                    href={DOWNLOADS.windowsSetupX64}
                    className="flex w-full items-center justify-between rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
                  >
                    <span className="flex items-center gap-2">
                      <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                      Download Windows Installer (.exe)
                    </span>
                    <span className="rounded-md bg-indigo-500/70 px-2 py-0.5 text-xs font-medium tabular-nums">
                      4.5 MB
                    </span>
                  </a>
                </div>

                <div className="mt-5 space-y-2.5 border-t border-slate-100 pt-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Alternative Windows Downloads
                  </p>
                  <a
                    href={DOWNLOADS.windowsPortableX64}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-indigo-200 hover:bg-indigo-50/50 hover:text-indigo-700"
                  >
                    <span>Portable Standalone (.exe — No Install)</span>
                    <span className="text-xs text-slate-500 tabular-nums">18.0 MB</span>
                  </a>
                  <a
                    href={DOWNLOADS.windowsMsiX64}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-indigo-200 hover:bg-indigo-50/50 hover:text-indigo-700"
                  >
                    <span>Enterprise MSI Installer (.msi)</span>
                    <span className="text-xs text-slate-500 tabular-nums">6.6 MB</span>
                  </a>
                  <a
                    href={DOWNLOADS.windowsSetupArm64}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-indigo-200 hover:bg-indigo-50/50 hover:text-indigo-700"
                  >
                    <span>Windows 11 ARM64 Setup (.exe)</span>
                    <span className="text-xs text-slate-500 tabular-nums">4.0 MB</span>
                  </a>
                </div>
              </div>
            </div>

            {/* Linux Card */}
            <div
              className={`flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-xs sm:p-8 ${
                detectedOS === "linux"
                  ? "border-emerald-300 ring-2 ring-emerald-600/10"
                  : "border-slate-200"
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                      <Terminal className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">
                        Linux Desktop (64-bit)
                      </h3>
                      <p className="text-xs font-medium text-slate-500">
                        Ubuntu, Debian, Fedora, RHEL &bull; Version {RELEASE_VERSION}
                      </p>
                    </div>
                  </div>
                  {detectedOS === "linux" ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                      Your OS
                    </span>
                  ) : null}
                </div>

                <p className="mt-4 text-sm leading-relaxed text-slate-600">
                  Choose <strong>.deb</strong> for Ubuntu/Debian, <strong>.rpm</strong> for Fedora/RedHat, or <strong>.AppImage</strong> to run on any Linux distribution.
                </p>

                <div className="mt-6">
                  <a
                    href={DOWNLOADS.linuxDebX64}
                    className="flex w-full items-center justify-between rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                  >
                    <span className="flex items-center gap-2">
                      <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                      Download Ubuntu / Debian (.deb)
                    </span>
                    <span className="rounded-md bg-emerald-500/70 px-2 py-0.5 text-xs font-medium tabular-nums">
                      9.5 MB
                    </span>
                  </a>
                </div>

                <div className="mt-5 space-y-2.5 border-t border-slate-100 pt-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Other Linux Distributions
                  </p>
                  <a
                    href={DOWNLOADS.linuxRpmX64}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-emerald-200 hover:bg-emerald-50/50 hover:text-emerald-800"
                  >
                    <span>Fedora / RedHat / CentOS (.rpm)</span>
                    <span className="text-xs text-slate-500 tabular-nums">9.5 MB</span>
                  </a>
                  <a
                    href={DOWNLOADS.linuxAppImageX64}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-emerald-200 hover:bg-emerald-50/50 hover:text-emerald-800"
                  >
                    <span>Universal Linux (.AppImage)</span>
                    <span className="text-xs text-slate-500 tabular-nums">83.9 MB</span>
                  </a>
                  <div className="grid grid-cols-2 gap-2">
                    <a
                      href={DOWNLOADS.linuxDebArm64}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:border-emerald-200 hover:bg-emerald-50/50 hover:text-emerald-800"
                    >
                      <span>ARM64 (.deb)</span>
                      <span className="text-[11px] text-slate-500 tabular-nums">9.6 MB</span>
                    </a>
                    <a
                      href={DOWNLOADS.linuxRpmArm64}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:border-emerald-200 hover:bg-emerald-50/50 hover:text-emerald-800"
                    >
                      <span>ARM64 (.rpm)</span>
                      <span className="text-[11px] text-slate-500 tabular-nums">9.6 MB</span>
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* All Release Assets & Checksums Banner */}
          <div className="mt-6 flex flex-col items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5 text-xs text-slate-600 sm:flex-row">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" strokeWidth={1.75} aria-hidden="true" />
              <span>
                All installers are verified with SHA-256 checksums on GitHub Releases (Tag:{" "}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-800">
                  {RELEASE_TAG}
                </code>
                ).
              </span>
            </div>
            <div className="flex items-center gap-4 font-semibold">
              <a
                href={DOWNLOADS.checksums}
                target="_blank"
                rel="noreferrer"
                className="text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-indigo-600"
              >
                SHA256SUMS.txt
              </a>
              <a
                href={RELEASE_PAGE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700"
              >
                View All Releases
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* 3-Step Setup Guide */}
      <section id="setup" className="border-y border-slate-200 bg-white py-14 sm:py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              How Employees Get Started in 3 Steps
            </h2>
            <p className="mt-2 text-sm text-slate-600 sm:text-base">
              Quick onboarding guide after downloading the desktop tracker.
            </p>
          </div>

          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
                1
              </div>
              <h3 className="mt-4 flex items-center gap-2 text-base font-bold text-slate-900">
                <Download className="h-4 w-4 text-indigo-600" strokeWidth={1.75} aria-hidden="true" />
                Download &amp; Install
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Download the Windows <code className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-xs">.exe</code> or Linux <code className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-xs">.deb/.rpm</code> installer above and run it on your work computer.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
                2
              </div>
              <h3 className="mt-4 flex items-center gap-2 text-base font-bold text-slate-900">
                <Server className="h-4 w-4 text-indigo-600" strokeWidth={1.75} aria-hidden="true" />
                Enter Server URL
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Open <strong>SM Office Desk</strong> and paste the organization server URL:{" "}
                <code className="break-all rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                  {serverUrl}
                </code>
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
                3
              </div>
              <h3 className="mt-4 flex items-center gap-2 text-base font-bold text-slate-900">
                <PlayCircle className="h-4 w-4 text-indigo-600" strokeWidth={1.75} aria-hidden="true" />
                Sign In &amp; Start Work
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Log in using the employee email and password given by your Admin, then click <strong>Start Work</strong> to begin tracking your session.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Key Features */}
      <section id="features" className="py-14 sm:py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Built for Transparent Team Operations
            </h2>
            <p className="mt-2 text-sm text-slate-600 sm:text-base">
              Everything needed to manage remote and in-office teams efficiently.
            </p>
          </div>

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <Clock className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-sm font-bold text-slate-900">
                Real-Time Work Timer
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                Accurate session clock-in, heartbeat syncing, and automatic stale-session protection.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                <Camera className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-sm font-bold text-slate-900">
                Screenshot Verification
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                Compressed multi-monitor captures only while active, with automatic screen-lock privacy detection.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                <MapPin className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-sm font-bold text-slate-900">
                Consented Live Location
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                Strictly opt-in employee location toggle only during active work shifts.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                <FileSpreadsheet className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-sm font-bold text-slate-900">
                Automated Payroll Reports
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                Hourly and monthly salary calculations with CSV export and printable attendance summaries.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-xs text-slate-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-indigo-600" strokeWidth={1.75} aria-hidden="true" />
            <span className="font-semibold text-slate-800">SM Office Desk</span>
            <span>&bull; Desktop Client v{RELEASE_VERSION}</span>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <Link
              to="/login"
              className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-indigo-600"
            >
              <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Admin Console
            </Link>
            <a
              href={RELEASE_PAGE_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-slate-700 hover:text-indigo-600"
            >
              GitHub Releases
            </a>
            <a
              href="/api/health"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-slate-700 hover:text-indigo-600"
            >
              System Status
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

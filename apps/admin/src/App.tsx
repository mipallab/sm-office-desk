import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ToastContainer } from "./components/Toast";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { RealtimeProvider } from "./context/RealtimeContext";
import { ToastProvider } from "./context/ToastContext";
import { EmployeesPage } from "./pages/EmployeesPage";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { MonitorPage } from "./pages/MonitorPage";
import { SalaryPage } from "./pages/SalaryPage";
import { ScreenshotsPage } from "./pages/ScreenshotsPage";
import { SettingsPage } from "./pages/SettingsPage";

function ProtectedAdminArea() {
  const { isAuthenticated, isBooting } = useAuth();

  if (isBooting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 shadow-xs">
          Verifying admin session...
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <RealtimeProvider>
      <AppShell />
    </RealtimeProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <ToastContainer />
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/download" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedAdminArea />}>
              <Route path="/monitor" element={<MonitorPage />} />
              <Route path="/screenshots" element={<ScreenshotsPage />} />
              <Route path="/employees" element={<EmployeesPage />} />
              <Route path="/salary" element={<SalaryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
export default App;

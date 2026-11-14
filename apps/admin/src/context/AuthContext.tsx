import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { MeResponse, PublicUser } from "@sm-office/shared";
import {
  adminApi,
  clearStoredTokens,
  getStoredTokens,
  setStoredTokens,
  subscribeAuthRevoked,
} from "../lib/api";

export type CompanyInfo = MeResponse["company"];

interface AuthContextValue {
  user: PublicUser | null;
  company: CompanyInfo | null;
  isBooting: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  updateCompany: (next: Partial<CompanyInfo>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [isBooting, setIsBooting] = useState<boolean>(true);

  const clearSessionState = useCallback(() => {
    clearStoredTokens();
    setUser(null);
    setCompany(null);
  }, []);

  const loadMe = useCallback(async () => {
    const tokens = getStoredTokens();
    if (!tokens) {
      setUser(null);
      setCompany(null);
      return;
    }

    try {
      const me = await adminApi.me();
      if (me.user.role !== "admin" || !me.user.is_active) {
        clearSessionState();
        return;
      }
      setUser(me.user);
      setCompany(me.company);
    } catch {
      clearSessionState();
    }
  }, [clearSessionState]);

  useEffect(() => {
    let active = true;
    (async () => {
      await loadMe();
      if (active) {
        setIsBooting(false);
      }
    })();

    const unsubscribe = subscribeAuthRevoked(() => {
      setUser(null);
      setCompany(null);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [loadMe]);

  const login = useCallback(async (email: string, password: string) => {
    const tokens = await adminApi.login(email, password);
    if (tokens.user.role !== "admin" || !tokens.user.is_active) {
      clearStoredTokens();
      throw new Error("Admin access required");
    }
    setStoredTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
    const me = await adminApi.me();
    setUser(me.user);
    setCompany(me.company);
  }, []);

  const logout = useCallback(async () => {
    try {
      if (getStoredTokens()) {
        await adminApi.logout();
      }
    } catch {
      // Ignore network/401 errors while logging out
    } finally {
      clearSessionState();
    }
  }, [clearSessionState]);

  const refreshMe = useCallback(async () => {
    await loadMe();
  }, [loadMe]);

  const updateCompany = useCallback((next: Partial<CompanyInfo>) => {
    setCompany((prev) => (prev ? { ...prev, ...next } : null));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      company,
      isBooting,
      isAuthenticated: Boolean(user && user.role === "admin" && user.is_active),
      login,
      logout,
      refreshMe,
      updateCompany,
    }),
    [user, company, isBooting, login, logout, refreshMe, updateCompany]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

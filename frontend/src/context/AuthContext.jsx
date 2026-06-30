import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  fetchSession,
  loginSession,
  logoutSession,
  fetchWorkTypeAccess,
  grantWorkTypeAccess as apiGrantWorkTypeAccess,
  revokeWorkTypeAccess as apiRevokeWorkTypeAccess,
} from "../data/backendApi";

// ---------------------------------------------------------------------------
// Mocked Google auth.
//
// Later this becomes real Google OAuth: the popup below is replaced by
// Google's identity script, and `login()` will exchange the Google ID token
// with the Go backend for a session instead of picking from MOCK_ACCOUNTS.
// The shape of `user` (id, name, email, avatarUrl, role) is kept identical
// so nothing downstream needs to change.
//
// Everything about WHO is logged in and WHAT they have access to lives on
// the backend (in-memory Store in main.go) now — the browser only ever
// holds the opaque `sessionId` returned by POST /api/session/login, in
// localStorage, purely so a page refresh can ask the backend "who is this"
// again via GET /api/session?sessionId=... . No user object, no
// workTypeAccess map, and no project list are ever written to localStorage;
// they're fetched fresh from the backend on every load, so a second
// browser/private window always reflects the same server-side truth.
//
// Work-type access: every account has a `defaultWorkTypes` array (the
// project(s) they start with). Admins can grant ADDITIONAL work types to any
// user for any project — e.g. a normally Extraction-only worker can be
// granted Cooking access too, and from then on sees + can claim blocks from
// both projects, each with its own independent 8h/day cap. Grants are stored
// server-side as { workType: [emails...] } so this generalizes to any number
// of projects, not just "Extraction".
// ---------------------------------------------------------------------------

const SESSION_STORAGE_KEY = "sessionId";

export const WORK_TYPES = [];

export const MOCK_ACCOUNTS = [
  {
    id: "demo-user-1",
    name: "Amina Njeri",
    email: "amina.njeri@gmail.com",
    avatarUrl: "https://i.pravatar.cc/100?img=47",
    role: "user",
    defaultWorkTypes: [],
  },
  {
    id: "demo-user-2",
    name: "Kipkoech Otieno",
    email: "kipkoech.otieno@gmail.com",
    avatarUrl: "https://i.pravatar.cc/100?img=12",
    role: "user",
    defaultWorkTypes: [],
  },
  {
    id: "demo-user-3",
    name: "Wanjiku Muiruri",
    email: "wanjiku.muiruri@gmail.com",
    avatarUrl: "https://i.pravatar.cc/100?img=32",
    role: "user",
    defaultWorkTypes: [],
  },
  {
    id: "demo-user-4",
    name: "Mwangi Kamau",
    email: "mwangi.kamau@gmail.com",
    avatarUrl: "https://i.pravatar.cc/100?img=56",
    role: "user",
    defaultWorkTypes: [],
  },
  {
    id: "demo-user-5",
    name: "Nadia Akinyi",
    email: "nadia.akinyi@gmail.com",
    avatarUrl: "https://i.pravatar.cc/100?img=15",
    role: "user",
    defaultWorkTypes: [],
  },
  {
    id: "demo-user-6",
    name: "Daniel Mutua",
    email: "daniel.mutua@gmail.com",
    avatarUrl: "https://i.pravatar.cc/100?img=24",
    role: "user",
    defaultWorkTypes: [],
  },
  {
    id: "admin-1",
    name: "Foreman (Admin)",
    email: "foreman@worksite.com",
    avatarUrl: "https://i.pravatar.cc/100?img=68",
    role: "admin",
  },
  {
    id: "admin-2",
    name: "Kevin Ndirangu (Admin)",
    email: "kevin.ndirangu@labelyourdata.com",
    role: "admin",
  },
];

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authLoading, setAuthLoading] = useState(true); // restoring session on first load
  // { [workType]: string[] of normalized emails granted EXTRA access to that workType }
  // Always fetched fresh from the backend — never cached in localStorage.
  const [workTypeAccess, setWorkTypeAccess] = useState({});
  // Admin-created custom project names fetched from backend
  const [customWorkTypes, setCustomWorkTypes] = useState(() => []);

  const sessionIdRef = useRef(null);

  // Pull workTypeAccess from the backend. Exposed so callers (grant/revoke,
  // or a manual refresh) can re-sync without a full page reload.
  const refreshWorkTypeAccess = useCallback(async () => {
    try {
      const access = await fetchWorkTypeAccess();
      setWorkTypeAccess(access || {});
      return access || {};
    } catch (err) {
      console.error("Failed to fetch workTypeAccess from backend", err);
      return {};
    }
  }, []);

  // On first mount: if a sessionId is stored, ask the backend who that is.
  // This is the ONLY thing read from localStorage — a bare opaque token,
  // not user data. If the backend doesn't recognise it (e.g. server
  // restarted), we just fall back to the login page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const storedSessionId = (() => {
        try {
          return localStorage.getItem(SESSION_STORAGE_KEY);
        } catch {
          return null;
        }
      })();

      await refreshWorkTypeAccess();

      if (storedSessionId) {
        try {
          const res = await fetchSession(storedSessionId);
          if (!cancelled && res?.user) {
            sessionIdRef.current = storedSessionId;
            setUser(res.user);
          } else if (!cancelled) {
            try {
              localStorage.removeItem(SESSION_STORAGE_KEY);
            } catch (err) {
              console.error("Failed to clear stale sessionId", err);
            }
          }
        } catch (err) {
          console.error("Failed to restore session from backend", err);
        }
      }
      if (!cancelled) setAuthLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkTypeAccess]);

  // Fetch projects from backend when user logs in
  useEffect(() => {
    if (!user?.id) {
      setCustomWorkTypes([]);
      return;
    }
    let cancelled = false;
    const doFetch = async () => {
      try {
        const res = await fetch(`http://localhost:8080/api/projects?adminId=${user.id}`);
        if (res.ok) {
          const projects = await res.json();
          if (!cancelled) setCustomWorkTypes(projects || []);
        }
      } catch (err) {
        console.error("Failed to fetch projects from backend", err);
      }
    };
    doFetch();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  /** Grant a user (by email) access to an additional work type/project. Backend is the source of truth. */
  const grantWorkTypeAccess = useCallback(async (email, workType) => {
    const trimmedWorkType = typeof workType === "string" ? workType.trim() : "";
    if (!email || !trimmedWorkType) return;
    try {
      const next = await apiGrantWorkTypeAccess(email, trimmedWorkType);
      setWorkTypeAccess(next || {});
    } catch (err) {
      console.error("Failed to grant work type access", err);
    }
  }, []);

  /** Revoke a previously granted (extra) work type from a user. Backend is the source of truth. */
  const revokeWorkTypeAccess = useCallback(async (email, workType) => {
    const trimmedWorkType = typeof workType === "string" ? workType.trim() : "";
    try {
      const next = await apiRevokeWorkTypeAccess(email, trimmedWorkType);
      setWorkTypeAccess(next || {});
    } catch (err) {
      console.error("Failed to revoke work type access", err);
    }
  }, []);

  /** Add custom work type for current admin - sends to backend */
  const addCustomWorkType = useCallback((name) => {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName || !user?.id) {
      console.warn("Cannot add project: name or user.id missing", { name, userId: user?.id });
      return;
    }
    fetch("http://localhost:8080/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminId: user.id, name: trimmedName })
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(projects => {
        setCustomWorkTypes(projects || []);
      })
      .catch(err => {
        console.error("Failed to add project:", err);
      });
  }, [user?.id]);

  const removeCustomWorkType = useCallback((name) => {
    setCustomWorkTypes((prev) => prev.filter((n) => n !== name));
  }, []);

  const clearCustomWorkTypes = useCallback(() => setCustomWorkTypes([]), []);

  const login = useCallback(
    async (accountId) => {
      setIsAuthenticating(true);
      const account = MOCK_ACCOUNTS.find((a) => a.id === accountId);
      if (!account) {
        setIsAuthenticating(false);
        return null;
      }
      try {
        // Backend resolves grantedWorkTypes (defaultWorkTypes + any grants)
        // and hands back a sessionId — the session itself lives server-side.
        const res = await loginSession({
          id: account.id,
          name: account.name,
          email: account.email,
          avatarUrl: account.avatarUrl,
          role: account.role,
          defaultWorkTypes: Array.isArray(account.defaultWorkTypes) ? account.defaultWorkTypes : [],
        });
        sessionIdRef.current = res.sessionId;
        try {
          localStorage.setItem(SESSION_STORAGE_KEY, res.sessionId);
        } catch (err) {
          console.error("Failed to persist sessionId", err);
        }
        setUser(res.user);
        setIsAuthenticating(false);
        return res.user;
      } catch (err) {
        console.error("Login failed — backend unreachable", err);
        setIsAuthenticating(false);
        return null;
      }
    },
    []
  );

  const logout = useCallback(() => {
    const sessionId = sessionIdRef.current;
    setUser(null);
    sessionIdRef.current = null;
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (err) {
      console.error("Failed to remove sessionId", err);
    }
    if (sessionId) {
      logoutSession(sessionId).catch((err) => console.error("Failed to notify backend of logout", err));
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticating,
      authLoading,
      login,
      logout,
      workTypeAccess,
      grantWorkTypeAccess,
      revokeWorkTypeAccess,
      customWorkTypes,
      addCustomWorkType,
      removeCustomWorkType,
      clearCustomWorkTypes,
    }),
    [user, isAuthenticating, authLoading, login, logout, workTypeAccess, grantWorkTypeAccess, revokeWorkTypeAccess, customWorkTypes, addCustomWorkType, removeCustomWorkType, clearCustomWorkTypes]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
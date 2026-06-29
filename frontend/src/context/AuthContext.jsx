import { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react";

// ---------------------------------------------------------------------------
// Mocked Google auth.
//
// Later this becomes real Google OAuth: the popup below is replaced by
// Google's identity script, and `login()` will exchange the Google ID token
// with the Go backend for a session instead of picking from MOCK_ACCOUNTS.
// The shape of `user` (id, name, email, avatarUrl, role) is kept identical
// so nothing downstream needs to change.
//
// Work-type access: every account has a `defaultWorkTypes` array (the
// project(s) they start with). Admins can grant ADDITIONAL work types to any
// user for any project — e.g. a normally Extraction-only worker can be
// granted Cooking access too, and from then on sees + can claim blocks from
// both projects, each with its own independent 8h/day cap. Grants are stored
// as { workType: [emails...] } so this generalizes to any number of projects,
// not just "Extraction".
// ---------------------------------------------------------------------------

function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

/**
 * Collapse keys that differ only by case (e.g. "hubdoc" and "Hubdoc") into a
 * single key, merging their email lists. Whichever casing is encountered
 * first (object key order) is kept as canonical. This exists to clean up
 * data that was written before project names were made case-insensitive —
 * new writes shouldn't produce duplicates in the first place, but this keeps
 * already-stored data (e.g. in a person's browser localStorage) consistent
 * too, without requiring them to manually clear it.
 */
function mergeCaseInsensitiveKeys(workTypeAccess) {
  const canonicalKeyByLowerCase = new Map();
  const merged = {};
  Object.entries(workTypeAccess).forEach(([workType, emails]) => {
    const lowerKey = workType.toLowerCase();
    const canonicalKey = canonicalKeyByLowerCase.get(lowerKey) ?? workType;
    canonicalKeyByLowerCase.set(lowerKey, canonicalKey);
    const existing = merged[canonicalKey] ?? [];
    merged[canonicalKey] = Array.from(new Set([...existing, ...emails]));
  });
  return merged;
}


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
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem("loggedInUser");
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  // { [workType]: string[] of normalized emails granted EXTRA access to that workType }
  // Persisted to localStorage so projects and access grants survive logout/login.
  const [workTypeAccess, setWorkTypeAccess] = useState(() => {
    try {
      const stored = localStorage.getItem("workTypeAccess");
      return stored ? mergeCaseInsensitiveKeys(JSON.parse(stored)) : {};
    } catch {
      return {};
    }
  });
  // Admin-created custom project names fetched from backend
  const [customWorkTypes, setCustomWorkTypes] = useState(() => []);

  const resolveGrantedWorkTypes = useCallback(
    (email, defaultWorkTypes = []) => {
      const normalizedEmail = email ? normalizeEmail(email) : null;
      const granted = new Set(Array.isArray(defaultWorkTypes) ? defaultWorkTypes : []);
      if (normalizedEmail) {
        Object.entries(workTypeAccess).forEach(([workType, emails]) => {
          if (emails.includes(normalizedEmail)) granted.add(workType);
        });
      }
      return Array.from(granted);
    },
    [workTypeAccess]
  );

  useEffect(() => {
    if (!user?.email) return;
    setUser((current) => {
      if (!current) return current;
      const nextGranted = resolveGrantedWorkTypes(current.email, current.defaultWorkTypes);
      const sameLength = nextGranted.length === current.grantedWorkTypes?.length;
      const sameSet = sameLength && nextGranted.every((wt) => current.grantedWorkTypes.includes(wt));
      if (sameSet) return current;
      return { ...current, grantedWorkTypes: nextGranted };
    });
  }, [resolveGrantedWorkTypes, user?.email]);

  // Persist workTypeAccess to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem("workTypeAccess", JSON.stringify(workTypeAccess));
    } catch (e) {
      console.error("Failed to persist workTypeAccess to localStorage", e);
    }
  }, [workTypeAccess]);

  // Function to fetch projects from backend
  const fetchProjectsFromBackend = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await fetch(`http://localhost:8080/api/projects?adminId=${user.id}`);
      if (res.ok) {
        const projects = await res.json();
        setCustomWorkTypes(projects || []);
        return projects || [];
      }
    } catch (err) {
      console.error("Failed to fetch projects from backend", err);
    }
    return [];
  }, [user?.id]);

  // Fetch projects from backend when user logs in
  useEffect(() => {
    if (!user?.id) {
      setCustomWorkTypes([]);
      return;
    }
    const doFetch = async () => {
      try {
        const res = await fetch(`http://localhost:8080/api/projects?adminId=${user.id}`);
        if (res.ok) {
          const projects = await res.json();
          console.log("Fetched projects for admin:", user.id, projects);
          setCustomWorkTypes(projects || []);
        }
      } catch (err) {
        console.error("Failed to fetch projects from backend", err);
      }
    };
    doFetch();
  }, [user?.id]);

  /** Grant a user (by email) access to an additional work type/project. */
  const grantWorkTypeAccess = useCallback((email, workType) => {
    const normalizedEmail = normalizeEmail(email);
    const trimmedWorkType = typeof workType === "string" ? workType.trim() : "";
    if (!normalizedEmail || !trimmedWorkType) return;
    setWorkTypeAccess((current) => {
      // If a key already exists that only differs by case (e.g. "hubdoc" vs
      // "Hubdoc"), reuse that key instead of creating a second, duplicate
      // entry — project names are case-insensitive everywhere else now, so
      // grants should be too.
      const existingKey =
        Object.keys(current).find((key) => key.toLowerCase() === trimmedWorkType.toLowerCase()) ?? trimmedWorkType;
      const existing = current[existingKey] ?? [];
      if (existing.includes(normalizedEmail)) return current;
      return { ...current, [existingKey]: [...existing, normalizedEmail] };
    });
  }, []);

  /** Revoke a previously granted (extra) work type from a user. */
  const revokeWorkTypeAccess = useCallback((email, workType) => {
    const normalizedEmail = normalizeEmail(email);
    const trimmedWorkType = typeof workType === "string" ? workType.trim() : "";
    setWorkTypeAccess((current) => {
      const existingKey = Object.keys(current).find((key) => key.toLowerCase() === trimmedWorkType.toLowerCase());
      if (!existingKey) return current;
      const existing = current[existingKey] ?? [];
      if (!existing.includes(normalizedEmail)) return current;
      return { ...current, [existingKey]: existing.filter((entry) => entry !== normalizedEmail) };
    });
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
        console.log("Project added, backend returned:", projects);
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
    (accountId) => {
      setIsAuthenticating(true);
      return new Promise((resolve) => {
        setTimeout(() => {
          const account = MOCK_ACCOUNTS.find((a) => a.id === accountId);
          const resolvedAccount = account
            ? {
                ...account,
                defaultWorkTypes: Array.isArray(account.defaultWorkTypes) ? account.defaultWorkTypes : [],
                grantedWorkTypes: resolveGrantedWorkTypes(account.email, account.defaultWorkTypes ?? []),
              }
            : null;
          setUser(resolvedAccount);
          try {
            if (resolvedAccount) {
              localStorage.setItem("loggedInUser", JSON.stringify(resolvedAccount));
            }
          } catch (err) {
            console.error("Failed to persist logged-in user", err);
          }
          setIsAuthenticating(false);
          resolve(resolvedAccount);
        }, 350);
      });
    },
    [resolveGrantedWorkTypes]
  );

  const logout = useCallback(() => {
    setUser(null);
    try {
      localStorage.removeItem("loggedInUser");
    } catch (err) {
      console.error("Failed to remove logged-in user", err);
    }
  }, []);

  const value = useMemo(
    () => ({
      user: user
        ? { ...user, grantedWorkTypes: resolveGrantedWorkTypes(user.email, user.defaultWorkTypes ?? []) }
        : null,
      isAuthenticating,
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
    [user, isAuthenticating, login, logout, resolveGrantedWorkTypes, workTypeAccess, grantWorkTypeAccess, revokeWorkTypeAccess, customWorkTypes, addCustomWorkType, removeCustomWorkType, clearCustomWorkTypes]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
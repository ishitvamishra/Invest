import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { account } from "../lib/appwrite.js";
import { ID } from "appwrite";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Check for an existing session on mount
  useEffect(() => {
    account.get()
      .then((user) => setCurrentUser(user))
      .catch(() => setCurrentUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    // Clear any stale session first to avoid "session already active" errors
    try { await account.deleteSession("current"); } catch (_) { /* no active session */ }
    await account.createEmailPasswordSession(email, password);
    const user = await account.get();
    setCurrentUser(user);
    return user;
  }, []);

  const signup = useCallback(async (email, password, name) => {
    // Clear any stale session first to avoid "session already active" errors
    try { await account.deleteSession("current"); } catch (_) { /* no active session */ }
    await account.create(ID.unique(), email, password, name);
    // Auto-login after signup
    await account.createEmailPasswordSession(email, password);
    const user = await account.get();
    setCurrentUser(user);
    return user;
  }, []);

  const logout = useCallback(async () => {
    await account.deleteSession("current");
    setCurrentUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Access the auth context from any component.
 * @returns {{ currentUser: object|null, loading: boolean, login: Function, signup: Function, logout: Function }}
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

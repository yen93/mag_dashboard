import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { login as apiLogin, setToken, getToken } from '../api.js';

const AuthContext = createContext(null);

function decodeUser(token) {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null; // expired
    return { id: payload.sub, email: payload.email, name: payload.name, role: payload.role };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => decodeUser(getToken()));

  const signIn = useCallback(async (email, password) => {
    const { token, user: u } = await apiLogin(email, password);
    setToken(token);
    setUser(u);
    return u;
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, signIn, signOut }), [user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

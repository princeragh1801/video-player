import { createContext, useContext, useEffect, useState } from 'react';
import { api, onAuthChange, refreshSession, setSession } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still restoring session

  useEffect(() => {
    const off = onAuthChange(setUser);
    refreshSession().then((s) => !s && setUser(null));
    return off;
  }, []);

  const value = {
    user,
    login: async (email, password) => setSession(await api('/api/auth/login', { method: 'POST', body: { email, password } })),
    register: async (name, email, password) =>
      setSession(await api('/api/auth/register', { method: 'POST', body: { name, email, password } })),
    logout: async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null);
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

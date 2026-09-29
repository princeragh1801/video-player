// API client. The access token lives only in memory (never localStorage); the refresh token is an
// httpOnly cookie the JS can't read. On a 401 we refresh once and retry.
const BASE = import.meta.env.VITE_API_URL ?? '';

let accessToken = null;
let refreshing = null;
const listeners = new Set();

export const onAuthChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

export function setSession(session) {
  accessToken = session?.accessToken ?? null;
  listeners.forEach((fn) => fn(session?.user ?? null));
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

export function refreshSession() {
  refreshing ??= fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) {
        setSession(null);
        return null;
      }
      const session = await r.json();
      setSession(session);
      return session;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api(path, { method = 'GET', body, token, retry = true } = {}) {
  const headers = {};
  const auth = token ?? accessToken;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retry && !token && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) return api(path, { method, body, retry: false });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const apiUrl = (path) => `${BASE}${path}`;

// Stable per-browser id used to count concurrent devices. Not a security boundary.
export function deviceId() {
  try {
    let id = localStorage.getItem('deviceId');
    if (!id) localStorage.setItem('deviceId', (id = crypto.randomUUID()));
    return id;
  } catch {
    return (deviceId.fallback ??= crypto.randomUUID());
  }
}

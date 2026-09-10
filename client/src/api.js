// Thin API client. Reads the JWT from localStorage and attaches it as a Bearer
// token. On a 401 it throws an AuthError so callers can redirect to login.

const TOKEN_KEY = 'mag_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — token stays in memory via context only */
  }
}

export class AuthError extends Error {}

async function request(pathname, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    throw new AuthError('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function login(email, password) {
  return request('/api/login', { method: 'POST', body: { email, password }, auth: false });
}

export function fetchMetrics(area, range) {
  return request(`/api/metrics/${area}?range=${encodeURIComponent(range)}`);
}

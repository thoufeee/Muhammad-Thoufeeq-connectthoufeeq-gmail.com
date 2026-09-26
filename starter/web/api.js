// Tiny fetch wrapper. The access token lives in React state and is passed in — never in
// localStorage/sessionStorage (D13). The refresh token is an httpOnly cookie the browser
// sends to /v1/auth/* by itself; JavaScript never sees it.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code ?? null;
    this.reason = body?.error?.reason ?? null;
  }
}

export async function http(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

// Swap the refresh cookie for a fresh access token (optionally for a specific org).
export const refreshSession = (orgId) => http('POST', '/auth/refresh', { body: orgId ? { orgId } : {} });
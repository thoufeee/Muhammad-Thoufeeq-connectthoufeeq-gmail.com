// Small helpers shared by the route files. No permission logic lives here.

import { badRequest } from '../http.js';

// Strict integer query param: rejects "abc", "1.5", out-of-range. Boundaries are defined
// (400), never silently clamped.
export function intParam(query, name, { min, max, fallback }) {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) throw badRequest(`${name} must be an integer`, 'invalid_param');
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`, 'invalid_param');
  return n;
}

export function requireName(value, field = 'name', max = 80) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`, 'invalid_field');
  const v = value.trim();
  if (v.length > max) throw badRequest(`${field} is too long (max ${max})`, 'invalid_field');
  return v;
}

export function normalizeEmail(value) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('email is required', 'invalid_field');
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw badRequest('email is not valid', 'invalid_field');
  }
  return email;
}

export function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const isUniqueViolation = (err) =>
  err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
export const isFkViolation = (err) => err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
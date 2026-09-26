// Auth: login, refresh (rotating opaque cookie), switching org, who-am-I, logout.
//
// The access token carries identity only (sub, org, role, pv). Permissions are resolved
// on every request. One org per token; switching orgs mints a new token (D18).

import {
  hashPassword, verifyPassword, issueAccessToken,
  newRefreshToken, hashRefreshToken, REFRESH_TTL_SECONDS,
} from '../auth.js';
import { send, badRequest, unauthenticated, forbidden, notFound } from '../http.js';
import { newId, nowIso } from '../db.js';
import { resolve } from '../permissions.js';
import { readCookie } from './util.js';

const COOKIE = 'rt';
// Compared against when the email is unknown, so a missing account costs the same time as
// a wrong password and the response can't be used to discover which emails exist.
const DUMMY_HASH = hashPassword('not-a-real-password');

export function activeOrgs(db, userId) {
  return db.prepare(
    `SELECT o.id, o.name, o.theme, m.role
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
      ORDER BY m.joined_at IS NULL, m.joined_at, m.created_at`
  ).all(userId);
}

// Build the login/refresh/switch response for one org. orgId omitted -> the user's first org.
export function sessionPayload(db, secret, userId, orgId) {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
  const orgs = activeOrgs(db, userId);
  if (!user || orgs.length === 0) throw forbidden('no active organization', 'no_active_membership');
  const org = orgId ? orgs.find((o) => o.id === orgId) : orgs[0];
  if (!org) throw notFound();

  const m = db.prepare('SELECT role, perm_version FROM memberships WHERE org_id = ? AND user_id = ?').get(org.id, userId);
  const token = issueAccessToken({ userId, orgId: org.id, role: m.role, permVersion: m.perm_version }, secret);
  return { token, orgId: org.id, role: m.role, org, orgs, user };
}

function setRefreshCookie(res, raw) {
  res.setHeader('set-cookie',
    `${COOKIE}=${raw}; HttpOnly; SameSite=Strict; Secure; Path=/v1/auth; Max-Age=${REFRESH_TTL_SECONDS}`);
}
function clearRefreshCookie(res) {
  res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Secure; Path=/v1/auth; Max-Age=0`);
}

function issueRefresh(db, userId, familyId = newId('fam')) {
  const raw = newRefreshToken();
  db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(newId('rt'), userId, hashRefreshToken(raw), familyId,
        new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString());
  return raw;
}

export function registerAuthRoutes(router, { db, secret }) {
  router.post('/v1/auth/login', async (ctx, _p, res) => {
    const { email, password, orgId } = ctx.body;
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      throw badRequest('email and password are required', 'missing_fields');
    }
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email.trim().toLowerCase());
    const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthenticated('invalid email or password');

    const payload = sessionPayload(db, secret, user.id, orgId);
    setRefreshCookie(res, issueRefresh(db, user.id));
    send(res, 200, payload);
  });

  // Rotating refresh. Presenting an already-rotated token is treated as theft: the whole
  // family is revoked, so both the thief and the victim have to log in again.
  router.post('/v1/auth/refresh', async (ctx, _p, res) => {
    const raw = readCookie(ctx.req, COOKIE);
    if (!raw) throw unauthenticated('missing refresh token');

    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hashRefreshToken(raw));
    if (!row) throw unauthenticated('invalid refresh token');

    const rotated = db.transaction(() => {
      const claimed = db.prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?'
      ).run(nowIso(), row.id, nowIso()).changes;
      if (claimed === 0) {
        if (row.revoked_at || row.expires_at > nowIso()) {
          // already used (or used concurrently): replay -> kill the family
          db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
            .run(nowIso(), row.family_id);
        }
        return null;
      }
      return issueRefresh(db, row.user_id, row.family_id);
    })();

    if (!rotated) {
      clearRefreshCookie(res);
      throw unauthenticated('refresh token is no longer valid');
    }
    const payload = sessionPayload(db, secret, row.user_id, ctx.body?.orgId);
    setRefreshCookie(res, rotated);
    send(res, 200, payload);
  });

  // Switch org: a new token scoped to the other org. Not a filter over one dataset.
  router.post('/v1/auth/token', async (ctx, _p, res) => {
    const { orgId } = ctx.body;
    if (typeof orgId !== 'string' || !orgId) throw badRequest('orgId is required', 'missing_fields');
    send(res, 200, sessionPayload(db, secret, ctx.userId, orgId));
  });

  router.get('/v1/auth/me', async (ctx, _p, res) => {
    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(ctx.userId);
    const orgs = activeOrgs(db, ctx.userId);
    const org = orgs.find((o) => o.id === ctx.orgId);
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId });
    send(res, 200, { user, orgId: ctx.orgId, role: ctx.role, org, orgs, permissions });
  });

  router.post('/v1/auth/logout', async (ctx, _p, res) => {
    const raw = readCookie(ctx.req, COOKIE);
    if (raw) {
      const row = db.prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?').get(hashRefreshToken(raw));
      if (row) db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(nowIso(), row.family_id);
    }
    clearRefreshCookie(res);
    send(res, 204);
  });
}
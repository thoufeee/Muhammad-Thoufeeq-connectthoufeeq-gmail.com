// Shared domain rules: role ranks, last-owner protection, ending sessions.
//
// The rules more than one route needs live here, so "what ends a session" and "who may
// modify whom" each have exactly one implementation.
//
// `roles.rank` is MODIFICATION AUTHORITY ONLY (D8). Nothing in this file answers a
// permission question — that is permissions.js's job.

import { badRequest, forbidden, lastOwner } from './http.js';
import { nowIso } from './db.js';

const OWNER = 'owner'; // the one role the last-owner rule is about

// { roleKey: rank } read from the roles table (the personalised role is in there too).
export function roleRanks(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, rank FROM roles').all()) out[r.key] = r.rank;
  return out;
}

export function assertRoleExists(db, role) {
  if (typeof role !== 'string' || !db.prepare('SELECT 1 FROM roles WHERE key = ?').get(role)) {
    throw badRequest(`unknown role: ${role}`, 'unknown_role');
  }
}

// May a caller with callerRole modify (role change, suspend, remove) a member with targetRole?
// Strictly lower rank only — except owners may modify other owners, otherwise an org with
// two owners could never demote one of them.
export function assertCanModify(db, callerRole, targetRole) {
  if (callerRole === OWNER) return;
  const ranks = roleRanks(db);
  if (!(ranks[callerRole] > ranks[targetRole])) {
    throw forbidden('you may only modify members of a lower role', 'rank');
  }
}

// May a caller with callerRole confer newRole (invite or role change)?
// Owners may confer anything, including owner. Everyone else only strictly lower roles.
export function assertCanAssign(db, callerRole, newRole) {
  if (callerRole === OWNER) return;
  const ranks = roleRanks(db);
  if (!(ranks[callerRole] > ranks[newRole])) {
    throw forbidden(`you may not assign the ${newRole} role`, 'rank');
  }
}

// Would removing/demoting/suspending userId leave the org with no active owner?
export function assertNotLastOwner(db, orgId, userId) {
  const target = db.prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  if (!target || target.role !== OWNER || target.status !== 'active') return;
  const others = db.prepare(
    `SELECT count(*) AS n FROM memberships
      WHERE org_id = ? AND role = ? AND status = 'active' AND user_id != ?`
  ).get(orgId, OWNER, userId).n;
  if (others === 0) throw lastOwner();
}

// The ONE place sessions are ended. Pass any combination of orgId / userId / deviceId.
// Returns the number of sessions ended.
export function endActiveSessions(db, { orgId, userId, deviceId, reason, exceptSessionId }) {
  const where = ["state IN ('connecting','active')"];
  const args = [];
  if (orgId) { where.push('org_id = ?'); args.push(orgId); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (deviceId) { where.push('device_id = ?'); args.push(deviceId); }
  if (exceptSessionId) { where.push('id != ?'); args.push(exceptSessionId); }
  return db.prepare(
    `UPDATE sessions SET state = 'ended', end_reason = ?, ended_at = ? WHERE ${where.join(' AND ')}`
  ).run(reason, nowIso(), ...args).changes;
}

// Sessions past their TTL are ended lazily, before anything reads or starts sessions,
// so an expired session can neither be reported as active nor block the device index.
export function expireSessions(db) {
  const now = nowIso();
  db.prepare(
    `UPDATE sessions SET state = 'ended', end_reason = 'session_expired', ended_at = ?
      WHERE state IN ('connecting','active') AND expires_at <= ?`
  ).run(now, now);
}

// The authority a session starts with. Sessions are grandfathered: this snapshot, not the
// live permission set, is what the session runs on for its whole life (PERMISSIONS.md §7).
export function snapshotAuthority(db, { userId, orgId, deviceId }) {
  const role = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId)?.role ?? null;
  const now = nowIso();
  const grantIds = db.prepare(
    `SELECT id FROM grants
      WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL
        AND (device_id IS NULL OR device_id = ?)
        AND (starts_at IS NULL OR starts_at <= ?)
        AND (expires_at IS NULL OR expires_at > ?)`
  ).pluck().all(orgId, userId, deviceId, now, now);
  return { role, grantIds, snapshotAt: now };
}

// started_at + org.max_session_minutes
export function sessionExpiry(db, orgId) {
  const minutes = db.prepare('SELECT max_session_minutes FROM organizations WHERE id = ?').get(orgId)?.max_session_minutes ?? 60;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
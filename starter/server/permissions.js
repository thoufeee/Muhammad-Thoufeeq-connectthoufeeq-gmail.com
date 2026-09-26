// The permission resolution engine. THE ONLY PLACE allow-vs-deny is decided.
//
// If you ever find yourself writing `if (role === 'admin')` outside this file — and
// especially under web/ — that is the bug this module exists to prevent. The console
// renders what this returns; it must never re-derive it.
//
// Everything is read from the database (permissions, role_permissions, memberships,
// grants, grant_permissions). Nothing from the documented matrix is hardcoded, so the
// personalised role and permission in the DB resolve exactly like the documented ones.

import { forbidden, badRequest } from './http.js';

export const MODE_PERMISSION = { view: 'device:view', control: 'device:control', terminal: 'device:terminal' };

// ---------------------------------------------------------------------------
// Resolution. One path: loadInputs() reads the DB once, evaluate() decides.
// ---------------------------------------------------------------------------

// Everything a decision needs, read from the database.
function loadInputs(db, userId, orgId, now) {
  const nowIso = now.toISOString();

  const catalogue = db.prepare('SELECT key, resource FROM permissions ORDER BY key').all();

  const membership = db.prepare(
    `SELECT m.role, m.status, m.perm_version
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.org_id = ? AND o.deleted_at IS NULL`
  ).get(userId, orgId);

  if (!membership || membership.status !== 'active') {
    return { catalogue, membership, baseline: new Set(), grants: [] };
  }

  const baseline = new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role = ?').pluck().all(membership.role)
  );

  // Only grants that are live right now: not revoked, inside the half-open window
  // starts_at <= now < expires_at, and not pointing at a deleted device.
  const grants = db.prepare(
    `SELECT g.id, g.effect, g.device_id, gp.permission
       FROM grants g
       JOIN grant_permissions gp ON gp.grant_id = g.id
       LEFT JOIN devices d ON d.id = g.device_id
      WHERE g.user_id = ? AND g.org_id = ?
        AND g.revoked_at IS NULL
        AND (g.starts_at  IS NULL OR g.starts_at  <= ?)
        AND (g.expires_at IS NULL OR g.expires_at >  ?)
        AND (g.device_id IS NULL OR d.deleted_at IS NULL)`
  ).all(userId, orgId, nowIso, nowIso);

  return { catalogue, membership, baseline, grants };
}

// Does a grant's pattern ('*', 'device:*', 'device:control') cover this permission?
// Uses the resource column, so 'user:*' covers 'user:role:update' correctly.
function matches(pattern, perm) {
  if (pattern === '*' || pattern === perm.key) return true;
  return pattern.endsWith(':*') && pattern.slice(0, -2) === perm.resource;
}

// Does this grant take part in a question at this scope?
//   { deviceId }          exact check for one device
//   { mode: 'union' }     org-level: "can I do this anywhere?" (nav, page gating)
//   { mode: 'everywhere' } "do I hold this on every device?" (no-laundering)
function applies(grant, scope) {
  if (grant.device_id === null) return true; // org-wide grants apply at every scope
  if (scope.deviceId) return grant.device_id === scope.deviceId;
  if (scope.mode === 'union') return grant.effect === 'allow';
  return grant.effect === 'deny'; // 'everywhere'
}

function deniedOnDevice(grants, perm, deviceId) {
  return grants.some(
    (g) => g.effect === 'deny' && g.device_id === deviceId && matches(g.permission, perm)
  );
}

function allDenied(catalogue, reason) {
  const out = {};
  for (const perm of catalogue) out[perm.key] = { effect: 'deny', source: null, reason };
  return out;
}

function evaluate(inputs, scope) {
  const { catalogue, membership, baseline, grants } = inputs;

  if (!membership || membership.status === 'removed' || membership.status === 'invited') {
    return allDenied(catalogue, 'not_a_member');
  }
  if (membership.status === 'suspended') return allDenied(catalogue, 'suspended');

  const out = {};
  for (const perm of catalogue) {
    const hits = grants.filter((g) => matches(g.permission, perm) && applies(g, scope));

    // 1. An explicit deny always wins, whatever the scope (D1).
    const deny = hits.find((g) => g.effect === 'deny');
    if (deny) {
      out[perm.key] = { effect: 'deny', source: `grant:${deny.id}`, reason: 'explicit_deny' };
      continue;
    }

    // 2. The role baseline.
    if (baseline.has(perm.key)) {
      out[perm.key] = { effect: 'allow', source: `role:${membership.role}`, reason: 'role' };
      continue;
    }

    // 3. An allow grant. At org level, a device-scoped allow only counts if that
    //    same device doesn't also deny it.
    const allow = hits.find(
      (g) =>
        g.effect === 'allow' &&
        !(scope.mode === 'union' && g.device_id && deniedOnDevice(grants, perm, g.device_id))
    );
    if (allow) {
      out[perm.key] = { effect: 'allow', source: `grant:${allow.id}`, reason: 'grant' };
      continue;
    }

    // 4. Nobody granted it (D4).
    out[perm.key] = { effect: 'deny', source: null, reason: 'implicit' };
  }
  return out;
}

function roleOf(inputs) {
  const m = inputs.membership;
  if (!m || m.status === 'removed' || m.status === 'invited') return null;
  return m.role;
}

// Resolve one user's permission set in one org. deviceId === null means the org-level
// view; a deviceId means the exact per-device check.
export function resolve(db, { userId, orgId, deviceId = null, now = new Date() }) {
  const inputs = loadInputs(db, userId, orgId, now);
  const scope = deviceId ? { deviceId } : { mode: 'union' };
  return { role: roleOf(inputs), permissions: evaluate(inputs, scope) };
}

// Batched form for list endpoints: reads the DB once, evaluates every device in memory,
// so a device list costs the same number of queries whether it has 3 rows or 300.
export function resolveDevices(db, { userId, orgId, deviceIds, now = new Date() }) {
  const inputs = loadInputs(db, userId, orgId, now);
  const byDevice = {};
  for (const id of deviceIds) byDevice[id] = evaluate(inputs, { deviceId: id });
  return { role: roleOf(inputs), byDevice };
}

// For the no-laundering check: "do I hold this on every device, not just somewhere?"
export function resolveEverywhere(db, { userId, orgId, now = new Date() }) {
  const inputs = loadInputs(db, userId, orgId, now);
  return { role: roleOf(inputs), permissions: evaluate(inputs, { mode: 'everywhere' }) };
}

export function can(db, ctx, permission, deviceId = null) {
  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  return permissions[permission]?.effect === 'allow';
}

// ---------------------------------------------------------------------------
// Refusals. Each throws a 403 that carries the machine-readable reason, so the
// API response (and the console) can say WHY, not just "forbidden".
// ---------------------------------------------------------------------------

// Throws 403 carrying the reason code, so a refusal is debuggable.
export function assertCan(db, ctx, permission, deviceId = null) {
  const p = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId }).permissions[permission];
  if (p?.effect === 'allow') return;
  const reason =
    p?.reason === 'explicit_deny' || p?.reason === 'suspended' ? p.reason : 'missing_permission';
  throw forbidden(`missing ${permission}`, reason);
}

// No privilege laundering (D9): you may only grant authority you hold at that scope.
//   device-scoped grant -> you must hold every covered permission on THAT device
//   org-wide grant      -> you must hold it everywhere: role or org-wide allow, and
//                          no deny on any device (a device-scoped allow somewhere is not enough)
export function assertMayGrant(db, ctx, patterns, deviceId = null) {
  const catalogue = db.prepare('SELECT key, resource FROM permissions').all();
  const held = deviceId
    ? resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId }).permissions
    : resolveEverywhere(db, { userId: ctx.userId, orgId: ctx.orgId }).permissions;

  for (const pattern of patterns) {
    for (const perm of catalogue) {
      if (!matches(pattern, perm)) continue;
      if (held[perm.key]?.effect !== 'allow') {
        throw forbidden(`you cannot grant ${perm.key}: you do not hold it at that scope`, 'scope_mismatch');
      }
    }
  }
}

// The compound check: session:start AND the permission for the requested mode, and a
// refusal must distinguish WHICH of the two was missing.
//   session:start missing          -> 'missing_permission'        (can't open sessions at all)
//   mode permission missing here   -> 'missing_device_permission' (not on this device)
export function assertCanStartSession(db, ctx, mode, deviceId) {
  const modePermission = MODE_PERMISSION[mode];
  if (!modePermission) throw badRequest(`unknown session mode: ${mode}`);

  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });

  if (permissions['session:start']?.reason === 'suspended') {
    throw forbidden('membership is suspended', 'suspended');
  }
  if (permissions['session:start']?.effect !== 'allow') {
    throw forbidden('missing session:start', 'missing_permission');
  }
  if (permissions[modePermission]?.effect !== 'allow') {
    throw forbidden(`missing ${modePermission} on this device`, 'missing_device_permission');
  }
}
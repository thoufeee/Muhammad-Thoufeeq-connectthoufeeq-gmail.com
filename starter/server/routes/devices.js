// Devices (with the caller's resolved permissions on every row) and grants.
//
// device:list gates the list endpoint; device:view decides whether each row is included.
// A device the caller can't view is absent from the list and a 404 on its own URL.

import { HttpError, send, badRequest, notFound, forbidden, normalizeTs } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { resolve, resolveDevices, assertCan, assertMayGrant } from '../permissions.js';
import { endActiveSessions } from '../lifecycle.js';
import { audit } from '../audit.js';
import { requireName, isFkViolation } from './util.js';

const KINDS = ['macos', 'windows', 'linux', 'android', 'ios'];

function liveDevice(db, orgId, deviceId) {
  return db.prepare(
    'SELECT id, org_id, name, kind, online, created_at FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).get(deviceId, orgId);
}

// A device the caller may see, with its permissions; otherwise 404 (invisible, not forbidden).
function visibleDevice(db, ctx, deviceId) {
  const d = liveDevice(db, ctx.orgId, deviceId);
  if (!d) throw notFound();
  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  if (permissions['device:view']?.effect !== 'allow') throw notFound();
  return { ...shape(d), permissions };
}

const shape = (d) => ({ id: d.id, name: d.name, kind: d.kind, online: !!d.online, created_at: d.created_at });

export function registerDeviceRoutes(router, { db }, guard) {
  // --- devices --------------------------------------------------------------
  router.get('/v1/orgs/:org/devices', guard('device.list', async (ctx, p, res) => {
    assertCan(db, ctx, 'device:list');
    const rows = db.prepare(
      'SELECT id, org_id, name, kind, online, created_at FROM devices WHERE org_id = ? AND deleted_at IS NULL ORDER BY name'
    ).all(p.org);
    // One batched resolution for every row (same query count for 3 devices or 300).
    const { byDevice } = resolveDevices(db, { userId: ctx.userId, orgId: p.org, deviceIds: rows.map((r) => r.id) });
    const devices = rows
      .filter((r) => byDevice[r.id]['device:view']?.effect === 'allow')
      .map((r) => ({ ...shape(r), permissions: byDevice[r.id] }));
    send(res, 200, { devices });
  }));

  router.post('/v1/orgs/:org/devices', guard('device.create', async (ctx, p, res) => {
    assertCan(db, ctx, 'device:provision');
    const name = requireName(ctx.body.name);
    const kind = ctx.body.kind ?? 'linux';
    if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`, 'invalid_field');
    const id = newId('dev');
    db.transaction(() => {
      db.prepare('INSERT INTO devices (id, org_id, name, kind, online) VALUES (?, ?, ?, ?, 0)').run(id, p.org, name, kind);
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'device.create', targetType: 'device', targetId: id, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 201, visibleDeviceOrBare(db, ctx, id));
  }));

  router.get('/v1/orgs/:org/devices/:deviceId', guard('device.read', async (ctx, p, res) => {
    send(res, 200, visibleDevice(db, ctx, p.deviceId));
  }));

  router.patch('/v1/orgs/:org/devices/:deviceId', guard('device.update', async (ctx, p, res) => {
    visibleDevice(db, ctx, p.deviceId);
    assertCan(db, ctx, 'device:update', p.deviceId);
    const name = requireName(ctx.body.name);
    db.transaction(() => {
      db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, p.deviceId);
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'device.update', targetType: 'device', targetId: p.deviceId, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, visibleDevice(db, ctx, p.deviceId));
  }));

  // Decommission: soft delete, and live sessions on it end.
  router.delete('/v1/orgs/:org/devices/:deviceId', guard('device.delete', async (ctx, p, res) => {
    visibleDevice(db, ctx, p.deviceId);
    assertCan(db, ctx, 'device:provision', p.deviceId);
    db.transaction(() => {
      db.prepare('UPDATE devices SET deleted_at = ? WHERE id = ?').run(nowIso(), p.deviceId);
      endActiveSessions(db, { deviceId: p.deviceId, reason: 'device_transferred' });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'device.delete', targetType: 'device', targetId: p.deviceId, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, { id: p.deviceId, deleted: true });
  }));

  // Transfer to another org. Needs device:provision in BOTH orgs. The token only addresses
  // the source org, so the target check is an explicit, separate resolution for that org.
  router.post('/v1/orgs/:org/devices/:deviceId/transfer', guard('device.transfer', async (ctx, p, res) => {
    visibleDevice(db, ctx, p.deviceId);
    assertCan(db, ctx, 'device:provision', p.deviceId);
    const toOrgId = ctx.body.toOrgId;
    if (typeof toOrgId !== 'string' || !toOrgId) throw badRequest('toOrgId is required', 'invalid_field');
    if (toOrgId === p.org) throw badRequest('device is already in that org', 'invalid_field');
    const target = resolve(db, { userId: ctx.userId, orgId: toOrgId });
    if (target.role === null) throw notFound(); // not a member there: the org is invisible
    if (target.permissions['device:provision']?.effect !== 'allow') {
      throw forbidden('missing device:provision in the target org', 'missing_permission');
    }

    db.transaction(() => {
      endActiveSessions(db, { deviceId: p.deviceId, reason: 'device_transferred' });
      // Grants naming this device belong to the old org; they must not follow it.
      const affected = db.prepare(
        'SELECT DISTINCT user_id FROM grants WHERE device_id = ? AND revoked_at IS NULL'
      ).pluck().all(p.deviceId);
      db.prepare('UPDATE grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(nowIso(), p.deviceId);
      for (const userId of affected) bumpPermVersion(db, { orgId: p.org, userId });
      db.prepare('UPDATE devices SET org_id = ? WHERE id = ?').run(toOrgId, p.deviceId);
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'device.transfer_out', targetType: 'device', targetId: p.deviceId, result: 'allow', reasonCode: toOrgId, requestId: ctx.requestId });
      audit(db, { orgId: toOrgId, actorId: ctx.userId, action: 'device.transfer_in', targetType: 'device', targetId: p.deviceId, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, { id: p.deviceId, orgId: toOrgId });
  }));

  // --- grants ----------------------------------------------------------------
  router.get('/v1/orgs/:org/grants', guard('grant.list', async (ctx, p, res) => {
    assertCan(db, ctx, 'user:read');
    const userId = ctx.query.get('userId');
    const rows = db.prepare(
      `SELECT g.id, g.user_id, u.name AS user_name, g.device_id, d.name AS device_name, g.effect,
              g.starts_at, g.expires_at, g.created_by, g.created_at
         FROM grants g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN devices d ON d.id = g.device_id
        WHERE g.org_id = ? AND g.revoked_at IS NULL ${userId ? 'AND g.user_id = ?' : ''}
        ORDER BY g.created_at, g.id`
    ).all(...(userId ? [p.org, userId] : [p.org]));
    const perms = db.prepare('SELECT grant_id, permission FROM grant_permissions WHERE grant_id IN (SELECT id FROM grants WHERE org_id = ? AND revoked_at IS NULL)').all(p.org);
    const byGrant = {};
    for (const r of perms) (byGrant[r.grant_id] ??= []).push(r.permission);
    const now = nowIso();
    const grants = rows.map((g) => ({
      ...g,
      permissions: byGrant[g.id] ?? [],
      active: (!g.starts_at || g.starts_at <= now) && (!g.expires_at || g.expires_at > now),
    }));
    send(res, 200, { grants });
  }));

  router.post('/v1/orgs/:org/grants', guard('grant.create', async (ctx, p, res) => {
    assertCan(db, ctx, 'grant:create');
    const { userId, effect } = ctx.body;
    const deviceId = ctx.body.deviceId || null;
    const permissions = ctx.body.permissions;

    // Shape first: 400s.
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some((x) => typeof x !== 'string')) {
      throw badRequest('permissions must be a non-empty list of permission strings', 'invalid_field');
    }
    if (effect !== 'allow' && effect !== 'deny') throw badRequest("effect must be 'allow' or 'deny'", 'invalid_field');
    const known = new Set(db.prepare('SELECT pattern FROM permission_patterns').pluck().all());
    const unknown = permissions.filter((x) => !known.has(x));
    if (unknown.length) throw badRequest(`unknown permission: ${unknown.join(', ')}`, 'unknown_permission');
    const startsAt = normalizeTs(ctx.body.startsAt, 'startsAt');
    const expiresAt = normalizeTs(ctx.body.expiresAt, 'expiresAt');
    if (startsAt && expiresAt && expiresAt <= startsAt) throw badRequest('expiresAt must be after startsAt', 'invalid_window');

    // Visibility: 404s. Cross-org devices and non-members are invisible, not forbidden.
    if (deviceId && !liveDevice(db, p.org, deviceId)) throw notFound();
    const member = db.prepare("SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'").get(p.org, userId);
    if (typeof userId !== 'string' || !member) throw notFound();

    // Already expired (half-open: expires_at == now is expired).
    if (expiresAt && expiresAt <= nowIso()) {
      throw new HttpError(400, 'GRANT_EXPIRED', 'grant would already be expired', 'expired_grant');
    }

    // Authority: 403s.
    if (userId === ctx.userId) throw forbidden('you cannot grant to yourself', 'self_grant');
    assertMayGrant(db, ctx, permissions, deviceId);

    const id = newId('grt');
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO grants (id, org_id, user_id, device_id, effect, starts_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, p.org, userId, deviceId, effect, startsAt, expiresAt, ctx.userId);
        const ins = db.prepare('INSERT OR IGNORE INTO grant_permissions (grant_id, permission) VALUES (?, ?)');
        for (const perm of permissions) ins.run(id, perm); // the FK is the final word on unknown strings
        bumpPermVersion(db, { orgId: p.org, userId });
        audit(db, { orgId: p.org, actorId: ctx.userId, action: 'grant.create', targetType: 'grant', targetId: id, result: 'allow', reasonCode: `${effect}:${permissions.join(',')}`, requestId: ctx.requestId });
      })();
    } catch (err) {
      if (isFkViolation(err)) throw badRequest('unknown permission', 'unknown_permission');
      throw err;
    }
    send(res, 201, { id, userId, deviceId, effect, permissions: [...new Set(permissions)], startsAt, expiresAt });
  }));

  // Revoke. Already revoked (or not in this org) = invisible = 404. Live sessions that used
  // this grant keep running (grandfathered); the next session is blocked.
  router.delete('/v1/orgs/:org/grants/:grantId', guard('grant.revoke', async (ctx, p, res) => {
    const g = db.prepare('SELECT id, user_id FROM grants WHERE id = ? AND org_id = ? AND revoked_at IS NULL').get(p.grantId, p.org);
    if (!g) throw notFound();
    assertCan(db, ctx, 'grant:revoke');
    db.transaction(() => {
      db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(nowIso(), g.id);
      bumpPermVersion(db, { orgId: p.org, userId: g.user_id });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'grant.revoke', targetType: 'grant', targetId: g.id, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, { id: g.id, revoked: true });
  }));
}

function visibleDeviceOrBare(db, ctx, id) {
  try { return visibleDevice(db, ctx, id); } catch { return { id }; }
}
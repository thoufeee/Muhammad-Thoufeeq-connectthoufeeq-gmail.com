// Sessions: records, not screen sharing. Start is the compound check (session:start AND the
// mode permission on that device). control/terminal are exclusive per device, view is not —
// enforced by the partial unique index, not by check-then-insert.
//
// Sessions are grandfathered: authorized_by snapshots the authority at start, and permission
// changes never end a session in flight. Every session has an expires_at (org TTL).

import { send, badRequest, notFound, forbidden, deviceBusy } from '../http.js';
import { newId, nowIso } from '../db.js';
import { can, assertCanStartSession, MODE_PERMISSION } from '../permissions.js';
import { expireSessions, snapshotAuthority, sessionExpiry } from '../lifecycle.js';
import { audit } from '../audit.js';
import { isUniqueViolation } from './util.js';

const COLS = `s.id, s.org_id, s.user_id, u.name AS user_name, s.device_id, d.name AS device_name,
              s.mode, s.state, s.end_reason, s.started_at, s.expires_at, s.ended_at`;

function sessionById(db, id) {
  return db.prepare(
    `SELECT ${COLS} FROM sessions s JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id WHERE s.id = ?`
  ).get(id);
}

export function registerSessionRoutes(router, { db }, guard) {
  router.get('/v1/orgs/:org/sessions', guard('session.list', async (ctx, p, res) => {
    expireSessions(db);
    // With session:view you see the org's sessions; without it, only your own.
    const all = can(db, ctx, 'session:view');
    const state = ctx.query.get('state');
    if (state && !['connecting', 'active', 'ended'].includes(state)) throw badRequest('invalid state filter', 'invalid_param');
    const where = ['s.org_id = ?'];
    const args = [p.org];
    if (!all) { where.push('s.user_id = ?'); args.push(ctx.userId); }
    if (state) { where.push('s.state = ?'); args.push(state); }
    const sessions = db.prepare(
      `SELECT ${COLS} FROM sessions s JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id
        WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC LIMIT 500`
    ).all(...args);
    send(res, 200, { sessions });
  }));

  router.post('/v1/orgs/:org/sessions', guard('session.start', async (ctx, p, res) => {
    const { deviceId, mode } = ctx.body;
    if (!MODE_PERMISSION[mode]) throw badRequest("mode must be 'view', 'control' or 'terminal'", 'invalid_field');
    if (typeof deviceId !== 'string') throw badRequest('deviceId is required', 'invalid_field');
    const device = db.prepare('SELECT id FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(deviceId, p.org);
    if (!device) throw notFound();

    assertCanStartSession(db, ctx, mode, deviceId); // 403 missing_permission | missing_device_permission
    expireSessions(db); // an expired holder must not block the index

    const id = newId('ses');
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO sessions (id, org_id, user_id, device_id, mode, state, authorized_by, started_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        ).run(id, p.org, ctx.userId, deviceId, mode,
              JSON.stringify(snapshotAuthority(db, { userId: ctx.userId, orgId: p.org, deviceId })),
              nowIso(), sessionExpiry(db, p.org));
        audit(db, { orgId: p.org, actorId: ctx.userId, action: 'session.start', targetType: 'session', targetId: id, result: 'allow', reasonCode: `${mode}:${deviceId}`, requestId: ctx.requestId });
      })();
    } catch (err) {
      if (isUniqueViolation(err)) {
        const holder = db.prepare(
          "SELECT id FROM sessions WHERE device_id = ? AND state = 'active' AND mode IN ('control','terminal')"
        ).get(deviceId);
        throw Object.assign(deviceBusy(`device already has an exclusive session${holder ? ` (${holder.id})` : ''}`),
          { reason: holder ? `held_by:${holder.id}` : 'device_busy' });
      }
      throw err;
    }
    send(res, 201, sessionById(db, id));
  }));

  // Readable by the participant, or with session:view. Otherwise (and cross-org) 404.
  router.get('/v1/sessions/:id', guard('session.read', async (ctx, p, res) => {
    expireSessions(db);
    const s = sessionById(db, p.id);
    if (!s || s.org_id !== ctx.orgId) throw notFound();
    if (s.user_id !== ctx.userId && !can(db, ctx, 'session:view')) throw notFound();
    send(res, 200, s);
  }));

  // End: your own session, or anyone's with session:terminate.
  router.delete('/v1/sessions/:id', guard('session.end', async (ctx, p, res) => {
    const s = sessionById(db, p.id);
    if (!s || s.org_id !== ctx.orgId) throw notFound();
    const own = s.user_id === ctx.userId;
    if (!own) {
      if (!can(db, ctx, 'session:view') && !can(db, ctx, 'session:terminate')) throw notFound();
      if (!can(db, ctx, 'session:terminate')) throw forbidden('missing session:terminate', 'missing_permission');
    }
    if (s.state === 'ended') { send(res, 200, s); return; }
    db.transaction(() => {
      db.prepare(`UPDATE sessions SET state = 'ended', end_reason = ?, ended_at = ? WHERE id = ? AND state != 'ended'`)
        .run(own ? 'user_stopped' : 'admin_terminated', nowIso(), s.id);
      audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: own ? 'session.stop' : 'session.terminate', targetType: 'session', targetId: s.id, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, sessionById(db, s.id));
  }));
}
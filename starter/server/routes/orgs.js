// Orgs, members, effective permissions, audit log, and read-only reference data.

import { send, notFound, forbidden, selfRoleChange } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { resolve, assertCan } from '../permissions.js';
import {
  assertRoleExists, assertCanModify, assertCanAssign, assertNotLastOwner, endActiveSessions,
} from '../lifecycle.js';
import { audit } from '../audit.js';
import { intParam, requireName } from './util.js';

const THEMES = ['cobalt', 'amber', 'emerald', 'rose', 'violet', 'teal', 'slate'];

function memberRow(db, orgId, userId) {
  return db.prepare(
    `SELECT u.id AS user_id, u.name, u.email, m.role, m.status, m.joined_at, m.perm_version
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.user_id = ?`
  ).get(orgId, userId);
}

// A member that is still part of the org (active or suspended). Removed = invisible = 404.
function visibleMember(db, orgId, userId) {
  const m = memberRow(db, orgId, userId);
  if (!m || (m.status !== 'active' && m.status !== 'suspended')) throw notFound();
  return m;
}

export function registerOrgRoutes(router, { db }, guard) {
  // --- orgs -----------------------------------------------------------------
  router.post('/v1/orgs', guard('org.create', async (ctx, _p, res) => {
    const name = requireName(ctx.body.name);
    const used = new Set(db.prepare(
      `SELECT o.theme FROM memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = ? AND o.deleted_at IS NULL`
    ).pluck().all(ctx.userId));
    const theme = THEMES.find((t) => !used.has(t)) ?? THEMES[used.size % THEMES.length];
    const id = newId('org');

    db.transaction(() => {
      db.prepare('INSERT INTO organizations (id, name, theme) VALUES (?, ?, ?)').run(id, name, theme);
      db.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)`
      ).run(newId('mem'), id, ctx.userId, nowIso());
      audit(db, { orgId: id, actorId: ctx.userId, action: 'org.create', targetType: 'org', targetId: id, result: 'allow', requestId: ctx.requestId });
    })();

    send(res, 201, { id, name, theme, role: 'owner' });
  }));

  router.get('/v1/orgs/:org', guard('org.read', async (ctx, p, res) => {
    const org = db.prepare('SELECT id, name, theme, max_session_minutes FROM organizations WHERE id = ? AND deleted_at IS NULL').get(p.org);
    if (!org) throw notFound();
    send(res, 200, org);
  }));

  router.patch('/v1/orgs/:org', guard('org.update', async (ctx, p, res) => {
    assertCan(db, ctx, 'org:update');
    const name = requireName(ctx.body.name);
    db.transaction(() => {
      db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, p.org);
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'org.update', targetType: 'org', targetId: p.org, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, db.prepare('SELECT id, name, theme, max_session_minutes FROM organizations WHERE id = ?').get(p.org));
  }));

  // Soft delete. Every live session in the org ends: an org that no longer exists can't
  // keep remote control of anything.
  router.delete('/v1/orgs/:org', guard('org.delete', async (ctx, p, res) => {
    assertCan(db, ctx, 'org:delete');
    db.transaction(() => {
      db.prepare('UPDATE organizations SET deleted_at = ? WHERE id = ?').run(nowIso(), p.org);
      endActiveSessions(db, { orgId: p.org, reason: 'admin_terminated' });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'org.delete', targetType: 'org', targetId: p.org, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, { id: p.org, deleted: true });
  }));

  // --- reference data (read-only, needed by the console's forms) --------------
  router.get('/v1/orgs/:org/permissions', guard('permissions.read', async (_ctx, _p, res) => {
    send(res, 200, {
      permissions: db.prepare('SELECT key, resource, action, description FROM permissions ORDER BY key').all(),
      patterns: db.prepare('SELECT pattern FROM permission_patterns ORDER BY pattern').pluck().all(),
    });
  }));

  router.get('/v1/orgs/:org/roles', guard('roles.read', async (_ctx, _p, res) => {
    send(res, 200, { roles: db.prepare('SELECT key, rank, label FROM roles ORDER BY rank DESC').all() });
  }));

  // --- members --------------------------------------------------------------
  router.get('/v1/orgs/:org/members', guard('member.list', async (ctx, p, res) => {
    assertCan(db, ctx, 'user:read');
    const members = db.prepare(
      `SELECT u.id AS user_id, u.name, u.email, m.role, m.status, m.joined_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND m.status IN ('active','suspended')
        ORDER BY u.name`
    ).all(p.org);
    send(res, 200, { members });
  }));

  // Leave. Registered before /:userId so "me" is not read as a user id.
  router.delete('/v1/orgs/:org/members/me', guard('member.leave', async (ctx, p, res) => {
    assertNotLastOwner(db, p.org, ctx.userId);
    removeMember(db, ctx, p.org, ctx.userId, 'member.leave');
    send(res, 200, { userId: ctx.userId, status: 'removed' });
  }));

  router.patch('/v1/orgs/:org/members/:userId', guard('member.role_update', async (ctx, p, res) => {
    const target = visibleMember(db, p.org, p.userId);
    if (p.userId === ctx.userId) throw selfRoleChange();
    assertCan(db, ctx, 'user:role:update');
    const role = ctx.body.role;
    assertRoleExists(db, role);
    assertCanModify(db, ctx.role, target.role);
    assertCanAssign(db, ctx.role, role);
    if (target.role === 'owner' && role !== 'owner') assertNotLastOwner(db, p.org, p.userId);

    db.transaction(() => {
      db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').run(role, p.org, p.userId);
      bumpPermVersion(db, { orgId: p.org, userId: p.userId });
      // Deliberately NOT ending sessions: a role change is a permission tweak, and live
      // sessions are grandfathered (they carry their own snapshot and TTL).
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'member.role_update', targetType: 'user', targetId: p.userId, result: 'allow', reasonCode: `${target.role}->${role}`, requestId: ctx.requestId });
    })();
    send(res, 200, memberRow(db, p.org, p.userId));
  }));

  // Suspend: reversible. Sessions end (a tenancy event, not a permission tweak).
  router.post('/v1/orgs/:org/members/:userId/suspend', guard('member.suspend', async (ctx, p, res) => {
    const target = visibleMember(db, p.org, p.userId);
    assertCan(db, ctx, 'user:remove');
    if (p.userId === ctx.userId) throw selfModify();
    assertCanModify(db, ctx.role, target.role);
    assertNotLastOwner(db, p.org, p.userId);

    db.transaction(() => {
      db.prepare("UPDATE memberships SET status = 'suspended' WHERE org_id = ? AND user_id = ?").run(p.org, p.userId);
      bumpPermVersion(db, { orgId: p.org, userId: p.userId });
      endActiveSessions(db, { orgId: p.org, userId: p.userId, reason: 'user_suspended' });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'member.suspend', targetType: 'user', targetId: p.userId, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, memberRow(db, p.org, p.userId));
  }));

  // Reinstate.
  router.delete('/v1/orgs/:org/members/:userId/suspend', guard('member.reinstate', async (ctx, p, res) => {
    const target = visibleMember(db, p.org, p.userId);
    assertCan(db, ctx, 'user:remove');
    assertCanModify(db, ctx.role, target.role);

    db.transaction(() => {
      db.prepare("UPDATE memberships SET status = 'active' WHERE org_id = ? AND user_id = ?").run(p.org, p.userId);
      bumpPermVersion(db, { orgId: p.org, userId: p.userId });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'member.reinstate', targetType: 'user', targetId: p.userId, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, memberRow(db, p.org, p.userId));
  }));

  // Remove: the membership, never the user (D15).
  router.delete('/v1/orgs/:org/members/:userId', guard('member.remove', async (ctx, p, res) => {
    const target = visibleMember(db, p.org, p.userId);
    assertCan(db, ctx, 'user:remove');
    if (p.userId === ctx.userId) throw selfModify();
    assertCanModify(db, ctx.role, target.role);
    assertNotLastOwner(db, p.org, p.userId);
    removeMember(db, ctx, p.org, p.userId, 'member.remove');
    send(res, 200, { userId: p.userId, status: 'removed' });
  }));

  // --- effective permissions ----------------------------------------------
  // Readable for yourself, or with user:read. Different org in the path = different answer,
  // because the token (and so the org) is different.
  router.get('/v1/orgs/:org/users/:userId/effective', guard('effective.read', async (ctx, p, res) => {
    if (p.userId !== ctx.userId) {
      visibleMember(db, p.org, p.userId);
      assertCan(db, ctx, 'user:read');
    }
    const deviceId = ctx.query.get('deviceId');
    if (deviceId && !db.prepare('SELECT 1 FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(deviceId, p.org)) {
      throw notFound();
    }
    send(res, 200, resolve(db, { userId: p.userId, orgId: p.org, deviceId: deviceId || null }));
  }));

  // --- audit log ----------------------------------------------------------------
  router.get('/v1/orgs/:org/audit', guard('audit.read', async (ctx, p, res) => {
    assertCan(db, ctx, 'audit:read');
    const limit = intParam(ctx.query, 'limit', { min: 1, max: 500, fallback: 50 });
    const offset = intParam(ctx.query, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    const events = db.prepare(
      `SELECT a.id, a.actor_id, u.name AS actor_name, a.action, a.target_type, a.target_id,
              a.result, a.reason_code, a.request_id, a.at
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.org_id = ?
        ORDER BY a.at DESC, a.id DESC
        LIMIT ? OFFSET ?`
    ).all(p.org, limit, offset);
    send(res, 200, { events, limit, offset });
  }));
}

// Suspending or removing yourself goes through "leave", which carries the last-owner check.
const selfModify = () => forbidden('use leave to remove yourself', 'self_modification');

function removeMember(db, ctx, orgId, userId, action) {
  db.transaction(() => {
    db.prepare("UPDATE memberships SET status = 'removed' WHERE org_id = ? AND user_id = ?").run(orgId, userId);
    bumpPermVersion(db, { orgId, userId });
    endActiveSessions(db, { orgId, userId, reason: 'membership_removed' });
    // Their grants in this org stop applying (resolution needs an active membership); we
    // also revoke them so a later rehire starts clean instead of inheriting old grants.
    db.prepare('UPDATE grants SET revoked_at = ? WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL').run(nowIso(), orgId, userId);
    audit(db, { orgId, actorId: ctx.userId, action, targetType: 'user', targetId: userId, result: 'allow', requestId: ctx.requestId });
  })();
}
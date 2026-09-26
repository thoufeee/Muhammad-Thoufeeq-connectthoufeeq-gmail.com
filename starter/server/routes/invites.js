// Invites: the only way to add a person (D14). Hashed at rest, returned once, single-use,
// 7-day expiry. The public peek shows just enough to render "you've been invited".

import { hashPassword, newInviteToken, hashInviteToken } from '../auth.js';
import { send, badRequest, notFound, conflict, gone } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { assertCan } from '../permissions.js';
import { assertRoleExists, assertCanAssign } from '../lifecycle.js';
import { audit } from '../audit.js';
import { normalizeEmail, requireName, isUniqueViolation } from './util.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

function inviteState(inv) {
  if (inv.accepted_at) return 'accepted';
  if (inv.revoked_at) return 'revoked';
  if (inv.expires_at <= nowIso()) return 'expired';
  return 'pending';
}

// Look up by raw token. Unknown -> 404; expired/revoked -> 410; accepted -> 409.
function liveInvite(db, rawToken) {
  const inv = db.prepare(
    `SELECT i.*, o.name AS org_name FROM invites i JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = ? AND o.deleted_at IS NULL`
  ).get(hashInviteToken(String(rawToken)));
  if (!inv) throw notFound();
  const state = inviteState(inv);
  if (state === 'accepted') throw conflict('this invite has already been used');
  if (state !== 'pending') throw gone();
  return inv;
}

export function registerInviteRoutes(router, { db }, guard) {
  router.post('/v1/orgs/:org/invites', guard('invite.create', async (ctx, p, res) => {
    assertCan(db, ctx, 'user:invite');
    const email = normalizeEmail(ctx.body.email);
    const role = ctx.body.role;
    assertRoleExists(db, role);
    assertCanAssign(db, ctx.role, role);

    const member = db.prepare(
      `SELECT m.status FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?`
    ).get(p.org, email);
    if (member && (member.status === 'active' || member.status === 'suspended')) {
      throw conflict('that person is already a member');
    }

    // An expired-but-never-accepted invite still occupies the partial unique index, so
    // retire it first; the index then decides any real race between two live invites.
    db.prepare(
      `UPDATE invites SET revoked_at = ? WHERE org_id = ? AND email = ? AND accepted_at IS NULL
         AND revoked_at IS NULL AND expires_at <= ?`
    ).run(nowIso(), p.org, email, nowIso());

    const raw = newInviteToken();
    const id = newId('inv');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, p.org, email, role, hashInviteToken(raw), ctx.userId, expiresAt);
        audit(db, { orgId: p.org, actorId: ctx.userId, action: 'invite.create', targetType: 'invite', targetId: id, result: 'allow', requestId: ctx.requestId });
      })();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('there is already a live invite for that email');
      throw err;
    }
    // The raw token is returned exactly once and never stored or logged.
    send(res, 201, { id, email, role, expiresAt, inviteToken: raw });
  }));

  router.get('/v1/orgs/:org/invites', guard('invite.list', async (ctx, p, res) => {
    assertCan(db, ctx, 'user:invite');
    const invites = db.prepare(
      `SELECT id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at
         FROM invites WHERE org_id = ? ORDER BY created_at DESC`
    ).all(p.org).map((i) => ({ ...i, state: inviteState(i) }));
    send(res, 200, { invites });
  }));

  router.delete('/v1/orgs/:org/invites/:id', guard('invite.revoke', async (ctx, p, res) => {
    assertCan(db, ctx, 'user:invite');
    const changed = db.transaction(() => {
      const n = db.prepare(
        'UPDATE invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL'
      ).run(nowIso(), p.id, p.org).changes;
      if (n) audit(db, { orgId: p.org, actorId: ctx.userId, action: 'invite.revoke', targetType: 'invite', targetId: p.id, result: 'allow', requestId: ctx.requestId });
      return n;
    })();
    if (!changed) throw notFound();
    send(res, 200, { id: p.id, state: 'revoked' });
  }));

  // Public. Only what the invitee needs to see; no org id, no members, no devices.
  router.get('/v1/invites/:token', async (_ctx, p, res) => {
    const inv = liveInvite(db, p.token);
    send(res, 200, { orgName: inv.org_name, role: inv.role, email: inv.email, expiresAt: inv.expires_at });
  });

  // Public. One transaction: claim the invite, upsert the user, activate the membership.
  // Accepting does not start a session and does not log the person in.
  router.post('/v1/invites/:token/accept', async (ctx, p, res) => {
    const inv = liveInvite(db, p.token);

    const result = db.transaction(() => {
      // Single-use: only one concurrent accept can flip accepted_at.
      const claimed = db.prepare(
        `UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
      ).run(nowIso(), inv.id, nowIso()).changes;
      if (!claimed) throw conflict('this invite has already been used');

      let user = db.prepare('SELECT id FROM users WHERE email = ?').get(inv.email);
      if (!user) {
        // A new person must choose a name and password.
        const name = requireName(ctx.body.name);
        if (typeof ctx.body.password !== 'string' || ctx.body.password.length < 8) {
          throw badRequest('password must be at least 8 characters', 'weak_password');
        }
        user = { id: newId('usr') };
        db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
          .run(user.id, inv.email, name, hashPassword(ctx.body.password));
      }
      // An existing platform user is attached, never duplicated, and keeps their password.

      const existing = db.prepare('SELECT id FROM memberships WHERE org_id = ? AND user_id = ?').get(inv.org_id, user.id);
      if (existing) {
        // rehire after removal: same row, fresh role, version bumped so old tokens die
        db.prepare(`UPDATE memberships SET role = ?, status = 'active', invited_by = ?, joined_at = ? WHERE id = ?`)
          .run(inv.role, inv.invited_by, nowIso(), existing.id);
        bumpPermVersion(db, { orgId: inv.org_id, userId: user.id });
      } else {
        db.prepare(
          `INSERT INTO memberships (id, org_id, user_id, role, status, invited_by, joined_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`
        ).run(newId('mem'), inv.org_id, user.id, inv.role, inv.invited_by, nowIso());
      }
      db.prepare('UPDATE invites SET accepted_by = ? WHERE id = ?').run(user.id, inv.id);
      audit(db, { orgId: inv.org_id, actorId: user.id, action: 'invite.accept', targetType: 'invite', targetId: inv.id, result: 'allow' });
      return { userId: user.id, role: inv.role, orgName: inv.org_name, email: inv.email };
    })();

    send(res, 200, result);
  });
}
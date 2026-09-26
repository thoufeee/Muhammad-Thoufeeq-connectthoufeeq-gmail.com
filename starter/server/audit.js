// Append-only audit writes.
//
// audit_events has BEFORE UPDATE / BEFORE DELETE triggers, so this module only ever INSERTs.
//   - successful changes: the route writes ONE row, inside the same transaction as the change
//   - denied attempts:    auditDenials() writes ONE row when a handler refuses with a 403
// Reads are not audited; a list of who looked at what is not what this log is for.

import { newId, nowIso } from './db.js';
import { HttpError } from './http.js';

export function audit(db, { orgId, actorId, action, targetType, targetId, result, reasonCode, requestId }) {
  db.prepare(
    `INSERT INTO audit_events (id, org_id, actor_id, action, target_type, target_id, result, reason_code, request_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('aud'), orgId, actorId ?? null, action, targetType ?? null, targetId ?? null,
        result, reasonCode ?? null, requestId ?? null, nowIso());
}

// Run fn(); if it refuses with a permission error, record the denial before rethrowing.
export async function auditDenials(db, ctx, meta, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && ctx.orgId) {
      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        action: meta.action,
        targetType: meta.targetType,
        targetId: meta.targetId,
        result: 'deny',
        reasonCode: err.reason ?? err.code,
        requestId: ctx.requestId,
      });
    }
    throw err;
  }
}
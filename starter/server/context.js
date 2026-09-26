// Per-request context: turn a bearer token into an authenticated caller.
//
// Order matters, and each step answers a different question:
//   1. is there a genuine token?                  -> 401 UNAUTHENTICATED
//   2. does the path name the token's org?        -> 404 NOT_FOUND (invisible, never 403)
//   3. is the caller still a member of that org?  -> 401 (removed / never a member)
//   4. is the membership suspended?               -> 403 FORBIDDEN, reason 'suspended'
//   5. is the token fresh (pv === perm_version)?  -> 401 TOKEN_STALE
//
// The token's `org` claim is the ONLY org this caller can address. Routes put the org in
// the path as `:org`; if it differs from the claim we stop here with a 404, before any
// query touches the other org. That is the structural isolation guarantee (D18).

import { verifyAccessToken, assertFresh } from './auth.js';
import { unauthenticated, notFound, forbidden } from './http.js';

export function authenticate(db, secret) {
  const findMembership = db.prepare(
    `SELECT m.id, m.org_id, m.user_id, m.role, m.status, m.perm_version
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.org_id = ? AND o.deleted_at IS NULL`
  );

  return function buildContext(req, params = {}) {
    // 1. A bearer token, verified (signature, alg, exp, iss, aud, jti).
    const header = req.headers?.authorization ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw unauthenticated('missing bearer token');
    const claims = verifyAccessToken(match[1], secret);

    // 2. Structural isolation: a path naming another org is invisible.
    if (params.org !== undefined && params.org !== claims.org) throw notFound();

    // 3. Membership must exist and not be removed/invited.
    const membership = findMembership.get(claims.sub, claims.org);
    if (!membership || membership.status === 'removed' || membership.status === 'invited') {
      throw unauthenticated('not a member of this org');
    }

    // 4. Suspended: the token still verifies, but the caller may do nothing.
    //    Checked BEFORE freshness: suspension bumps perm_version, so otherwise an old
    //    token would only ever say TOKEN_STALE and never explain the suspension.
    if (membership.status === 'suspended') throw forbidden('membership is suspended', 'suspended');

    // 5. Freshness: a role or grant change takes effect on the very next request.
    assertFresh(claims, membership);

    return { userId: claims.sub, orgId: claims.org, role: membership.role, membership, claims };
  };
}
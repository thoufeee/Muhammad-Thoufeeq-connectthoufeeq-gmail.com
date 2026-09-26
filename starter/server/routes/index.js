// Route registration. The router is first-match-wins, so specific paths are registered
// before parameterised ones ('/members/me' before '/members/:userId').
//
// Every authenticated route is wrapped in guard(action, handler): if the handler refuses
// with a 403, exactly one 'deny' audit row is written (audit.js auditDenials). Successful
// changes write their own 'allow' row inside the same transaction as the change.

import { auditDenials } from '../audit.js';
import { registerAuthRoutes } from './auth.js';
import { registerOrgRoutes } from './orgs.js';
import { registerInviteRoutes } from './invites.js';
import { registerDeviceRoutes } from './devices.js';
import { registerSessionRoutes } from './sessions.js';

export function registerRoutes(router, deps) {
  const { db } = deps;
  const guard = (action, handler) => (ctx, params, res) =>
    auditDenials(db, ctx, { action }, () => handler(ctx, params, res));

  registerAuthRoutes(router, deps);
  registerOrgRoutes(router, deps, guard);
  registerInviteRoutes(router, deps, guard);
  registerDeviceRoutes(router, deps, guard);
  registerSessionRoutes(router, deps, guard);
}
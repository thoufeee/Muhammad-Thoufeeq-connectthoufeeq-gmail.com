# BUILD-LOG

Append to this as you go. Commit it with the code it describes — the timestamps are part of the
evidence, and a log that arrives in one commit at the end reads as what it is.

Five lines is a real entry. Short and dated is better than long and reconstructed.

The categories we look for are listed in `DISCOVERY-BRIEF.md`. The example below shows the
*shape* of a good entry; it is a recreation of something already printed in `README.md`, so it
gives nothing away.

---

## Phase 0 — orientation

### 2026-09-26 · setup

* Created folder hackathon-task and forked rhinostream/Hackathons into it as
  Muhammad-Thoufeeq-connectthoufeeq-gmail.com

* Ran `npm install` in the repo root  error ENOENT, no package.json.
  I expected the app to be at the root, but it is inside starter/

* The root README.md is written for organisers. It says q1-starter/ is the reference solution
  and evaluate/, tools/, DISCOVERY-RUBRIC.md are organiser files. I decided not to touch them
  and to work only in starter/

* Moved into starter/ and ran npm install, npm run db:reset, npm run dev.
  App starts on http://localhost:8080. Login does not work yet because
  verifyAccessToken in server/auth.js is a stub

* Copied the BUILD-LOG.md and DECISIONS.md templates from starter/ to the repo root.


### 2026-09-26 · first test run – path bug on Windows

* Ran `npm test` → Playwright webServer crashed: ENOENT on
  `C:\C:\Users\...\Ta%CC%80i%20li%C3%AA%CC%A3u\...\db\schema.sql`.
* Expected failures from my missing code, not a crash loading the schema.
* Cause: scripts/load-db.js builds paths with `new URL(p, import.meta.url).pathname`.
  On Windows that keeps URL encoding ("Tài liệu" → %CC%80...) and a leading "/C:/",
  which resolves to "C:\C:\".
* Fix: `fileURLToPath(new URL(p, import.meta.url))` from node:url.


### 2026-09-26 · db:reset on Windows + baseline

* `npm run db:reset` → "'rm' is not recognized". The script uses Unix `rm -f`.
  load-db.js already deletes app.db/-wal/-shm itself, so I run `npm run db:load` instead.
* Baseline: check-permissions.js throws at resolve() (NOT_IMPLEMENTED);
  check-jwt.js 0 passed, 43 failed. Expected – nothing implemented yet.


## Phase 1 — token verification

### 2026-09-26 · prediction before coding

* I expect verifyAccessToken needs: split into 3 parts, check header alg/typ,
  recompute the HS256 signature, then check exp, iss, aud, jti.
* Guess: most failures will pass once the signature check works; exp == now may trip me.

### 2026-09-26 · verifyAccessToken – fail-closed bugs

* I was wrong. First run: 36 passed, 7 failed. All the rejection tests passed but the valid
  token got rejected. The function was saying no to everything.
* Added a debug log and it never printed, so the code wasn't even getting past the first line.
* Bug 1: I'd written `typeof token != String`. typeof gives the text "string", and I was
  comparing it to the String function, so it was always "not equal" and every token got thrown out.
* Fixed that and re-ran: still 36 / 7. So something else was also rejecting good tokens.
* Bug 2: `JSON.parse(unb64(segment)).toString('utf8')`. Bracket in the wrong place. It parsed
  the header and then turned it into the text "[object Object]", which then failed my
  "is it an object" check. Changed it to `JSON.parse(unb64(segment).toString('utf8'))`.
* Re-ran: 43 passed, 0 failed.


## Phase 2 — caller context and the resolution engine

### 2026-09-26 · my model before coding
* I think: role gives a set of permissions, allow grants add, deny grants remove,
  and a more specific (device) grant should beat a broader (org-wide) one.

  ### 2026-09-26 · resolve() and the assert functions

* How resolve() works: loadInputs() reads the membership, the permission catalogue, the role
  baseline and the grants that are live right now (4 queries). evaluate() then goes through each
  permission: explicit deny → role baseline → allow grant → implicit deny.
* The case that decides the model: Sam has an org-wide deny on device:terminal, and I added a
  device-scoped allow on lab-win-01. Result is deny. A narrower allow does not beat a broader deny.
* Org-level view (for nav and pages) is a union: device-scoped allows count ("can I do this
  anywhere?"), device-scoped denies don't, because one blocked device shouldn't hide the
  permission for the whole org.
* Wrong assumption: I returned `source` as the bare grant id. `npm run personalisation` failed
  2 checks because it wants "grant:<id>", and check-api.js also checks `startsWith('grant:')`.
  Changed to grant:<id>, and role:<role> for role allows.
* My personalised DB has role "reviewer" and permission "device:reboot". Both work without any
  special code, because everything is read from the tables.
* Measured: resolveDevices() runs the same 4 queries whether the org has 3 devices or 300.
  The per-device decisions happen in memory.

### 2026-09-26 · context.js

* Order: verify token → path org must equal token org (else 404) → membership exists
  (else 401) → suspended (403) → fresh pv (401 TOKEN_STALE).
* First instinct was to check freshness first. But suspending bumps perm_version, so a
  suspended user would only ever see TOKEN_STALE, never "suspended". Moved suspended above it.
* Tested with a throwaway script against a seeded DB: Acme token on /orgs/org_globex → 404;
  after bumpPermVersion Sam's old token → TOKEN_STALE; removed from Acme → 401 there, but
  Sam's Globex token still works.

## Phase 3 — orgs, members, invites

### 2026-09-27 · members and invites

* Equal-rank rule vs the test: PERMISSIONS §6 says admin→admin is 403, but check-api
  "demoting a NON-last owner is allowed" has an owner demoting another owner. So owners may
  modify owners; everyone else only strictly lower ranks (lifecycle.assertCanModify).
* No document says what happens to a removed member's grants. I revoke them on removal so a
  rehire starts clean instead of silently inheriting old grants.
* Invites: an expired, never-accepted invite still sits in the partial unique index and would
  block re-inviting that email forever. I retire expired ones before inserting.

### 2026-09-27 · check-api crashed before any test ran

* check-api.js died with "Command failed: node scripts/load-db.js" and no detail
  (it runs the loader with stdio ignored).
* Ran the loader myself with DATABASE_FILE=check-api.db → "server/auth.js does not
  provide an export named 'hashPassword'". I had accidentally cut off the bottom half of
  auth.js (hashPassword, verifyPassword, refresh/invite token helpers) while editing it.
* check-jwt.js never noticed, because it only imports verifyAccessToken and signToken.
  A passing suite only proves the parts it imports.
* Restored the file, removed a stray editor auto-import, and made the ===/!== match what
  I claimed earlier in this log.
* Then two more file problems before the server would start: routes/orgs.js didn't exist yet,
  and I'd named routes/util.js as utils.js, so the imports failed. Then audit.js was still the
  stub (found it with Select-String for "is yours to write").


## Phase 4 — devices and grants

### 2026-09-27 · wildcard grants and laundering

* Predicted the owner could grant anything. Tried owner → viewer `device:*` → 403 scope_mismatch.
* Why: device:* covers every device permission in the table, including my personalised
  device:reboot, and NO role (not even owner) has device:reboot in its baseline. Granting
  device:* would hand out something the owner doesn't hold. Kept it strict.
* Grant validation order: shape (400) → visibility (404) → expired (400 GRANT_EXPIRED) →
  authority (403). So a cross-org device is a 404 before anyone learns about permissions.


## Phase 5 — sessions

### 2026-09-27 · compound check and exclusivity

* session:start checked before the mode permission, so the two refusals stay distinguishable:
  missing_permission vs missing_device_permission.
* Exclusivity is the partial unique index; I catch the UNIQUE violation and return 409
  DEVICE_BUSY with the holder's id. No check-then-insert.
* Expired sessions are ended lazily (expireSessions) before listing/starting, otherwise an
  expired control session would still hold the unique index and block the device.


## Phase 6 — audit

### 2026-09-27 · what gets audited

* Every change writes one 'allow' row inside the same transaction as the change.
* Every 403 writes one 'deny' row via a guard() wrapper around each route.
* Reads are not audited. 404s are not audited (the caller can't see the thing).
* Result: check-api 66/66, check-permissions 35/35, check-jwt 43/43, personalisation 18/18.


## Phase 7 — the console

_Where did the server's answer and your instinct disagree about what should be on screen?_

## Phase 8 — hardening

_What did you measure, what did you fix, and what did you deliberately leave alone? Anything you
chose not to build belongs here with its reason._

## Open threads

_Things you know are wrong, unfinished, or that you would do differently with another day. Listing
these honestly is worth more than pretending they do not exist — we will find them anyway._

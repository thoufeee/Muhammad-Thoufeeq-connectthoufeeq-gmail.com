# DECISIONS

One section per decision that a reviewer might reasonably have made differently. Every section has
the same four parts, and the third and fourth are the ones we weigh most.

Rules, from `DISCOVERY-BRIEF.md`:

- cite something real in `Why` — a commit, a test, an error string, a file and line
- do not restate what a document says; describe what you did when the documents ran out
- six to twelve decisions is the expected range

---

### I build only in starter/ and do not open q1-starter/

**What I chose:** All my work happens inside starter/. I ran npm install, npm run db:reset and
npm run dev there.I use Claude (AI assistant) for fixing grammar in my BUILD-LOG.md and DECISIONS.md.
**Why:** `npm install` at the repo root failed with ENOENT (no package.json), so I read the root
README.md to find the app. It says q1-starter/ is "the reference implementation, not a starter",
and the task rules say copying the reference solution disqualifies. starter/ has its own
package.json and the app starts from there on http://localhost:8080.

### I fix path handling in load-db.js instead of moving the repo

**What I chose:** Changed `here()` in scripts/load-db.js to use `fileURLToPath(...)` instead of
`new URL(...).pathname`, and I run `npm run db:load` instead of `npm run db:reset` on Windows.
**Why:** `npm test` crashed with ENOENT on `C:\C:\...Ta%CC%80i%20li...\db\schema.sql`.
`.pathname` keeps URL encoding and a leading "/C:/", so a Windows path with a drive letter or
non-ASCII characters breaks. `fileURLToPath` decodes it and handles drive letters, and still
works on Mac/Linux, so graders are unaffected. `db:reset` fails on `rm -f` (not a Windows
command), but load-db.js already deletes the old DB files itself.
**What I rejected:** Moving the repo to a plain path like C:\dev – it hides the bug instead of
fixing it, and I want to keep my folder layout. Editing package.json's db:reset script – graders
run it on their own machines, and I did not want to change a given command they depend on.
**What would change my mind:** If graders run on Windows and need `db:reset` itself to work,
I would replace `rm -f` with a Node-based delete.

### verifyAccessToken checks the signature before it trusts anything in the token

**What I chose:** The order in server/auth.js is: three parts → header must be exactly
`alg: HS256, typ: JWT` → recompute HMAC-SHA256 over `h.p` with our secret → only then read the
payload → check exp is a number and later than now, then iss, aud and jti.
**Why:** Until the signature checks out, the header and payload could say anything. The tests
"alg: none, original signature kept" and "payload swapped, old signature kept" only pass because
the algorithm always comes from our own `ALG` constant, never from the header, and the payload
isn't looked at until the signature matches. All 43 pass.
**What I rejected:** Picking the algorithm from `header.alg`. That's exactly the `alg: none` and
HS512 trick the tests try. I also didn't pull in a JWT library like jsonwebtoken. The file is
deliberately hand-rolled on node:crypto, and I'd be relying on defaults I can't explain.

### Signatures are compared as text, in constant time, with a length check first

**What I chose:** I compare the signature from the token with `b64(expected HMAC)` using
`timingSafeEqual`, after checking the lengths match. Each segment also has to match
`/^[A-Za-z0-9_-]+$/` before I decode it.
**Why:** `Buffer.from(x, 'base64url')` quietly skips characters it doesn't understand, so if I
decoded first, a junk signature could end up looking fine. Comparing the encoded text avoids that
("signature is not base64url" and "signature truncated" both pass). And `timingSafeEqual` throws
if the lengths differ, which would be a crash instead of a 401, so the length check goes first.
**What I rejected:** A plain `given === expected`. It stops at the first wrong character, so in
theory someone could time the responses and guess the signature a byte at a time.

### A deny always wins, and the org-level view is a union

**What I chose:** In server/permissions.js an explicit deny beats everything, whatever its scope.
For org-level questions (nav, page gating) device-scoped allows count but device-scoped denies
don't. For the no-laundering check I use a stricter "everywhere" scope, where device-scoped
allows don't count and any deny does.
**Why:** The check-permissions test "device-scoped ALLOW does NOT carve out org-wide DENY" only
passes if deny is checked before anything else. A viewer with device:control on one device has to
see Control on that row, so the org view must include device allows. But the viewer's deny on
kiosk-lobby-01 shouldn't hide device:view for the whole org. For granting, an admin with an allow
on just one device shouldn't be able to hand that permission out org-wide, so assertMayGrant uses
the stricter scope.
**What I rejected:** "The most specific grant wins", which is what I'd expect from firewall-style
rules. A device allow would then override an org-wide deny, and the test forbids exactly that.
Also rejected using the union for laundering checks: one device allow would become an org-wide grant.
**What would change my mind:** A case where a narrower allow is expected to survive a broader
deny. I couldn't find one in the tests or the docs.

### Everything is read from the database, and resolution is one path

**What I chose:** loadInputs() reads the catalogue, role baseline, membership and live grants in
4 queries; evaluate() makes every decision in memory. resolve() and resolveDevices() both use it.
Nothing from the documented 5-role / 19-permission matrix is in the code.
**Why:** My database has an extra role "reviewer" and permission "device:reboot" that aren't in
any document, and grading uses different ones. `npm run personalisation` passes 18/18 without any
special code. resolveDevices() does the same 4 queries for 3 devices or 300, which avoids the
"one query per row" slowdown the README warns about.
**What would change my mind:** If I measured the device list as slow with a big org, I'd cache
the catalogue (it never changes at runtime) and key anything else by (userId, orgId, perm_version).

### Cross-org is decided in context.js, before any query touches the other org

**What I chose:** buildContext() compares the `:org` path param with the token's `org` claim
right after verifying the token, and throws 404 if they differ. Only then does it look up the
membership.
**Why:** check-api "Acme token against Globex -> 404" and "D18 Acme token cannot address the new
org" both need a 404, and the body must not reveal anything about the other org. Stopping in
context means no route handler can forget a `WHERE org_id = ?`.
**What I rejected:** Letting each route filter by org and return 403 on a mismatch. A 403
confirms the org exists, and one forgotten filter would leak data.
**What would change my mind:** An endpoint that legitimately needs to read across orgs (device
transfer needs device:provision in both). I'd handle that with a second, explicitly checked
token, not by loosening this rule.

### Owners may modify other owners; everyone else only strictly lower roles

**What I chose:** lifecycle.assertCanModify lets an owner modify any member, including other
owners; any other role may only modify strictly lower ranks. Owners may confer owner; others only
lower roles (assertCanAssign).
**Why:** check-api "demoting a NON-last owner is allowed" has Dana (owner) demote another owner and
expects 200, while "admin cannot confer owner" expects 403. Strict "lower rank only" would make a
two-owner org unable to ever demote one of them.
**What I rejected:** Strictly-lower for everyone – it fails that test and locks owners in.
**What would change my mind:** A requirement that owners can only be demoted by themselves.

---

### A wildcard grant is checked permission by permission, so even an owner can be refused

**What I chose:** assertMayGrant expands a pattern like device:* to every permission it covers in
the permissions table, and the caller must hold each one at that scope.
**Why:** Owner → viewer `device:*` returned 403 scope_mismatch. My DB has device:reboot, which no
role's baseline contains, so granting device:* would launder a permission the owner doesn't hold.
**What I rejected:** Checking only the permissions the caller happens to hold – that silently
grants the rest, which is exactly laundering.
**What would change my mind:** If the owner baseline were meant to include every permission,
including new ones. See "Where this repo argues with itself".

---

### Uniqueness races are left to the database, not checked first in code

**What I chose:** One exclusive session per device and one live invite per email are enforced by
the partial unique indexes. The routes just INSERT and turn a UNIQUE violation into 409
(DEVICE_BUSY / CONFLICT). Invite accept and refresh rotation use a conditional UPDATE
(`... WHERE accepted_at IS NULL` / `revoked_at IS NULL`) and check `changes`.
**Why:** check-api "2nd control on same device -> 409" and "reuse -> 409" pass. A check-then-insert
has a gap between the check and the insert where two requests can both pass the check.
**What I rejected:** SELECT-then-INSERT in application code – it races under concurrency.
**What would change my mind:** Moving to a database without partial indexes; then I'd need an
explicit lock or a serialised transaction.


## Where this repo argues with itself

The documents contradict each other, or contradict the schema, in at least one place. Name each
one you found. For each: quote both statements, say which you built against, and say why.

Building against the written rule and arguing in writing is a **full-marks** answer. Silently
working around it, or quietly picking one and saying nothing, scores zero on the section — we
cannot tell the difference between a decision and an oversight.

## Deliberately not built

What you chose not to build, and the reason. A scope cut with a stated reason is a senior
judgement. An unmentioned gap is a gap.

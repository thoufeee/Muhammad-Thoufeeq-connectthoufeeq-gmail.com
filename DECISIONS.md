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


## Where this repo argues with itself

The documents contradict each other, or contradict the schema, in at least one place. Name each
one you found. For each: quote both statements, say which you built against, and say why.

Building against the written rule and arguing in writing is a **full-marks** answer. Silently
working around it, or quietly picking one and saying nothing, scores zero on the section — we
cannot tell the difference between a decision and an oversight.

## Deliberately not built

What you chose not to build, and the reason. A scope cut with a stated reason is a senior
judgement. An unmentioned gap is a gap.

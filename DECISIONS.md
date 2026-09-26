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


## Where this repo argues with itself

The documents contradict each other, or contradict the schema, in at least one place. Name each
one you found. For each: quote both statements, say which you built against, and say why.

Building against the written rule and arguing in writing is a **full-marks** answer. Silently
working around it, or quietly picking one and saying nothing, scores zero on the section — we
cannot tell the difference between a decision and an oversight.

## Deliberately not built

What you chose not to build, and the reason. A scope cut with a stated reason is a senior
judgement. An unmentioned gap is a gap.

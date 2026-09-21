# Audit remediation — 2026-09-21

What the import audit (`audit/github-import-2026-09-21/AUDIT.md`) found, and what
was done about it. Findings that were **not** acted on are listed too, with the
reason, because a remediation note that records only its wins is one you cannot
plan from.

## Fixed

### SEC-1 — `JWT_SECRET` fallback (High)

`assertProductionSecrets()` in `server/_core/env.ts`, called from `startServer()`
before anything binds a port. In production a missing `JWT_SECRET`, or one shorter
than 32 characters, is now a refusal to start rather than a server that signs
HS256 sessions under a zero-length key.

32 bytes is the floor HS256's own security argument assumes, not a house
preference: a shorter secret is brute-forcible offline against any session token
its holder already has, and every session token is handed to a browser. The error
names the length and never the value.

Development and the test suite are untouched — the check returns immediately when
`NODE_ENV` is not `production`, which is why the empty fallback can stay.
`startServer()` now also sets a non-zero exit code on a failed start, so a
supervisor or deploy pipeline reports the failure instead of recording a success.

### SEC-6 — `appId` decoded but never checked (Medium)

`verifySession` compares the token's `appId` against `ENV.appId`
(`server/_core/sdk.ts`). A signing secret shared across deployments — the same
value pasted into staging, or a second app on the same platform — made a session
from either one valid here, because the signature checked out and the claim that
would have distinguished them was decoded and dropped.

Only enforced when the server knows its own identity. `appId` is unset in
development and in the test suite, and refusing every session there would turn a
missing environment variable into an outage rather than the configuration gap it is.

### DEP-1 — unused AWS SDK in production dependencies (High)

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` removed. Nothing in
`server/`, `client/`, `shared/`, `scripts/`, `tools/` or `drizzle/` imported
either; `server/storage.ts` goes through Forge presigned URLs and says why.

They were the **only** path to `fast-xml-parser`, which carried the single
critical advisory in the production tree. That branch is gone.

### DEP-2 — production dependencies behind their security releases (High)

| Package | Was | Now |
|---|---|---|
| `mysql2` | 3.15.1 | 3.24.4 |
| `drizzle-orm` | 0.44.6 | 0.45.2 |
| `axios` | 1.12.2 | 1.20.0 |
| `nanoid` | 5.1.6 | 5.1.16 |
| `@trpc/server` / `client` / `react-query` | 11.6.0 | 11.19.0 |

The three tRPC packages moved together; they share a wire format and splitting
them is how a client and server disagree about it.

Advisory counts across the whole dependency graph: **critical 3 → 2, high 58 → 39,
moderate 81 → 61, low 11 → 8**. Both remaining criticals are development-chain
only — `tar`, reached through build tooling, and `vitest`'s UI server, which this
project does not run. **No critical advisory remains in the shipped tree.**

### A type that described nothing (found by the mysql2 bump)

`SqlRunner.execute` in `server/_core/workflowRuntime.ts` took `params?: unknown[]`.
mysql2 3.24 narrowed its own signature, and `mysql.Pool` stopped satisfying that
type — correctly, because the type was never true. `unknown[]` claims any value at
all can be bound, and there is no wire encoding for a function, a symbol or an
arbitrary class instance.

Replaced with an explicit `SqlParam` union. `undefined` is deliberately excluded:
mysql2 **throws** `Bind parameters must not contain undefined. To pass SQL NULL
specify JS null`, so an `undefined` parameter is not a NULL, it is an exception
inside whatever transaction was open. The compiler now enforces the driver's own
rule at every call site — verified by removing a `?? null` and watching `tsc`
reject it.

**What this did not find.** The seven optional columns in the `operationalTasks`
insert now read `?? null`, and that changed no behaviour: `planTasks` in
`workflowEngine.ts` already normalises every one of them to `null` at
construction. The call sites now agree with what the producer was already doing.
`server/_core/workflowRuntimeBindParams.test.ts` pins the invariant at the
consumer and is honest in its own comment that it passes vacuously today — which
is the moment to install it, since the guarantee lives in two files that do not
reference each other and every way to break it looks ordinary in review.

Three test files bound values typed `unknown` into queries and were flagged by the
same narrowing. Each now says what the value is — `Number(id)` for a row id,
`String(r1.resultRef)` for a ref, `mysql.ExecuteValues` for the vault fixture's
column map. The CI gate's test-file type-error ratchet is back at its pinned **0**.

## Not fixed, and why

### SEC-2 — session JWT mirrored into `sessionStorage` (Medium)

`client/src/main.tsx` reads a `manus-cookie` value out of `sessionStorage` and
forwards the session as `Authorization: Bearer`; `server/_core/sdk.ts` accepts that
header in every environment. It gives away the `httpOnly` cookie's protection: any
XSS reads a valid session token directly.

The obvious fix is to gate it on a development build. It is **not applied** because
the comment says it exists for browsers that block iframe cookies — Safari ITP,
private browsing, WebView — and those are production-built preview sessions, not
development ones. Gating on `import.meta.env.DEV` would fix the exposure by
breaking the preview login it was written for, and which of those matters is a
call about how this is deployed, not one to infer from the code.

**What it needs:** a decision on whether the preview path is still in use. If it
is, an explicit opt-in flag rather than an unconditional fallback; if it is not,
delete both halves.

### SEC-3 — one-year sessions, no server-side revocation (Medium)

`ONE_YEAR_MS` in `server/_core/sdk.ts`, verified by signature alone — no session
table, so logout cannot invalidate a token and a leaked one stays valid until it
expires. Shortening the lifetime is a product decision with a visible cost (users
signed out more often) and the real repair is a revocation path, which is a
feature rather than a patch.

### SEC-4 / SEC-5 — `sameSite: "none"`, no security headers, no rate limiting

`helmet`'s default CSP would need a policy written against what this app actually
loads, and a wrong one breaks the page rather than failing safe. A rate limiter
needs limits chosen per route — the portal already locks an identity after 5
failures, so the gap is request volume and body size, where a guessed number
either does nothing or throttles a legitimate field device.

Both are worth doing and neither is a one-line change.

### Express 4 (`path-to-regexp`, `qs`, `body-parser`)

The remaining shipped advisories all arrive through Express 4.21.2, which is the
last 4.x release; the fixes are in Express 5. That is a framework migration with
its own test pass, not a dependency bump.

### The `tailwindcss>nanoid` override

`package.json` pins `tailwindcss>nanoid` to `3.3.7`, and the build chain resolves
`nanoid` 3.3.11 regardless — the override matches no path in the current tree.
Raising it was tried and changed nothing, so it was reverted rather than left as a
confident-looking no-op. The 3.x copies come from postcss/tailwind at build time
and are not in the shipped bundle.

## Verification

`tsc --noEmit` clean; test-file ratchet 0 against a pinned ceiling of 0; 0 bare
`protectedProcedure`; portal mounts 0 `roleProcedure`; `inboundRouter` mounts 0
role or external procedures (2 `integrationProcedure`); reserved migration slots
0016/0017 free; `LEASEOS_CURRENT_STATE.md` regenerates identically; production
build succeeds; 3,276 tests pass.

### Gate 8 caught this change, and it was right to

The first push of this branch failed CI at **gate 8 — "Current-state document is
generated, not claimed."** Adding `workflowRuntimeBindParams.test.ts` moved the
test counts, and `LEASEOS_CURRENT_STATE.md` still read `290 / 3938` against a
regenerated `291 / 3941`.

The document was regenerated with `scripts/current-state.sh` rather than hand-
edited, which is the whole point of that gate: a figure typed into a document is
a claim, and the same figure produced by a script is a measurement.

The reason it was not caught before pushing is worth stating. The local gate run
was assembled by reading `scripts/ci-gate.sh`, and the reader stopped at the
`Summary` header, taking it for the end — gates 7c and 8 sit after it. So the
local run was not the gate; it was a subset that looked like the gate. Both are
now run, and the table in `audit/github-import-2026-09-21/AUDIT.md` has been
corrected to list all ten.

The 14 failures in `server/fieldroute.test.ts` are the database-dependent ones
described in the import audit (TEST-1) and are unchanged by this work. The clean
database, migration and table-parity gates need MariaDB and run in CI.

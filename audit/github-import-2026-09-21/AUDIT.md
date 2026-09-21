# Repository audit — GitHub import, 2026-09-21

The `leaseos-main` working tree was imported into `dylanmark218-dot/leaseos-2` as a
source snapshot and audited before merge. The snapshot carried no `.git`, so this
repository's history begins at the import; the tree itself is `LEASEOS_RELEASE`
**v23.25**.

Everything below was run against the imported tree. Where a gate could not run here,
it says so rather than assuming it would pass.

## What was imported

| | |
|---|---|
| Files tracked | 1,221 |
| TypeScript / TSX | 747 files, 164,175 lines |
| Test files | 298 (4,143 tests) |
| SQL migrations | 165 |
| Markdown documents | 175 |
| Tree size | 31 MB |

No `node_modules`, no `.env`, no build output, no private keys. The largest objects are
the historical patch and source bundles under `archive/` (4.5 MB, 2.4 MB, 2.0 MB, 1.8 MB),
all well inside GitHub's limits.

## Gate results

`scripts/ci-gate.sh` is the project's own gate. This container has neither MariaDB nor a
usable Docker daemon, so gates 1–3 could not run. The rest were run directly.

| Gate | Result |
|---|---|
| 0. Reserved migration slots 0016/0017 untouched | **pass** — both slots free |
| 1. Clean database | **not run** — no MariaDB available here |
| 2. Migrations | **not run** — same |
| 3. Table parity | **not run** — same |
| 4. Typecheck (`tsc --noEmit`) | **pass** — clean |
| 4b. Test-file typecheck ratchet | **pass** — 0 errors against a pinned ceiling of 0 |
| 5. Bare `protectedProcedure` in routers | **pass** — 0 |
| 6. Test suite | **3,272 passed, 15 failed, 856 skipped** — see below |
| 7. Production build | **pass** — client 1,075 kB (263 kB gzip), `dist/index.js` 2.9 MB |
| 7b. Portal external gate | **pass** — 36 `externalProcedure`, 0 `roleProcedure` |
| 7c. Machine gate | **pass** — 2 `integrationProcedure`, 0 role/external in `inboundRouter` |
| 8. Current-state document is generated | **pass** — `LEASEOS_CURRENT_STATE.md` regenerates identically |

646 role-authorized procedures across the routers.

> **Corrected 2026-09-21.** The first version of this table stopped at 7b and
> omitted gates 7c and 8 — not because they failed, but because the run that
> produced it never invoked them: the gates were enumerated by reading
> `scripts/ci-gate.sh` down to the `Summary` header and taking that for the end
> of the file, when 7c and 8 sit *after* it. Gate 8 then caught the omission the
> hard way on the very next change (PR #2), where adding one test file left
> `LEASEOS_CURRENT_STATE.md` claiming 290/3938 against a regenerated 291/3941.
>
> Worth recording rather than quietly editing: a gate table assembled by reading
> a script is a claim about that script, and this one was wrong in the direction
> that matters — it under-reported coverage while reading as complete. Both gates
> have since been run and pass.

The 856 skipped tests and the 35 `.db.test.ts` files are the database-backed
suites, which self-skip without `DATABASE_URL`. **CI is the authority on those**: the
workflow provisions MariaDB 10.11 and runs the full gate. Nothing in this audit should be
read as having exercised the migration, parity or tenant-scope suites.

### The 15 failures

**14 in `server/fieldroute.test.ts`** — every one is `User holds no domain role`. The
suite's `beforeAll` grants its caller the `office`, `safety` and `management` roles through
the database; with no database the grant is a no-op, `listActiveUserRoles` returns empty,
and `roleProcedure` correctly refuses. These are an artifact of running without MariaDB,
not a defect in the code under test — but see **TEST-1**, because the suite does not
announce that dependency the way its siblings do.

**1 in `server/registerClaims.test.ts`** — fixed in this change; see **TEST-2**.

## Findings

Severity is about this codebase's own exposure, not a generic scale.

### SEC-1 — `JWT_SECRET` falls back to an empty string, with no boot guard (High)

`server/_core/env.ts:3` reads `cookieSecret: process.env.JWT_SECRET ?? ""`, and nothing
validates it at startup. `server/_core/sdk.ts:162` encodes whatever it finds and hands it
to `SignJWT`/`jwtVerify`. Deployed with `JWT_SECRET` unset, the server signs and verifies
HS256 sessions under a zero-length key — anyone can mint a token for any `openId` and the
`roleProcedure` gate will then look up that user's real roles and honour them.

The algorithm is correctly pinned to `HS256`, so this is not an `alg: none` problem. It is
purely the missing secret and the missing guard. A refusal to boot in production without a
secret of adequate length would close it.

### SEC-2 — the session JWT is mirrored into `sessionStorage` (Medium)

`client/src/main.tsx:54` reads a `manus-cookie` value out of `sessionStorage` and forwards
the session token as `Authorization: Bearer`, and `server/_core/sdk.ts:271` accepts that
header in every environment. The comment describes it as a preview fallback for browsers
that block iframe cookies, but neither side is gated on `NODE_ENV`, so it ships.

The cookie is set `httpOnly`. Mirroring the same token into `sessionStorage` gives that
protection away: any XSS anywhere in the app reads a valid session token directly, and by
**SEC-3** that token is good for a year.

### SEC-3 — one-year sessions with no server-side revocation (Medium)

`server/_core/sdk.ts:188` defaults `expiresInMs` to `ONE_YEAR_MS`, and verification is
pure JWT signature checking — no session table, no revocation list. A leaked token stays
valid until it expires, and logout cannot invalidate it. This is what makes SEC-2 costly.

### SEC-4 — `sameSite: "none"` with no CSRF token and no CORS allowlist (Medium)

`server/_core/cookies.ts` sets `sameSite: "none"` on the session cookie (the domain logic
above it is commented out). There is no CSRF token anywhere, and no `cors` middleware in
`server/_core/index.ts`.

In practice the tRPC client sends `content-type: application/json`, which forces a
preflight that the server never answers, so a cross-site page cannot drive a mutation
today. That is a property of the client transport, not an enforced server-side control —
any route that accepts a simple request body would not be covered by it.

### SEC-5 — no security headers, no rate limiting, 50 MB bodies everywhere (Medium)

`server/_core/index.ts:33` applies `express.json({ limit: "50mb" })` and the urlencoded
equivalent to every route including unauthenticated ones. There is no `helmet` (so no CSP,
HSTS, `X-Frame-Options` or `X-Content-Type-Options`) and no rate limiter.

Portal credential brute force *is* covered — `externalIdentityPolicy.ts` locks an identity
for 15 minutes after 5 failures. Nothing else is: not the OAuth routes, not the tRPC
surface, not request volume or body size.

### SEC-6 — `appId` is decoded from the session but never checked (Medium)

`server/_core/sdk.ts:217` pulls `appId` out of the verified payload and confirms only that
it is a non-empty string. It is never compared against `ENV.appId`. A token minted for a
different application under the same signing secret authenticates here.

### DEP-1 — the AWS SDK is a production dependency nothing imports (High)

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are declared in `dependencies`,
and no file in `server/`, `client/`, `shared/`, `scripts/` or `tools/` imports either.
`server/storage.ts` deliberately goes through Forge presigned URLs instead, and documents
why.

They are not merely dead weight. `pnpm why fast-xml-parser` resolves entirely through
`@aws-sdk/client-s3`, and `fast-xml-parser` carries the **only critical advisory in the
production tree** (DOCTYPE entity-encoding bypass via regex injection) plus several highs
alongside it. Dropping these two dependencies removes that whole branch.

### DEP-2 — production dependencies behind their security releases (High)

| Package | Pinned | Fixed in | Issue |
|---|---|---|---|
| `drizzle-orm` | `^0.44.5` | 0.45.2 | SQL injection via improperly escaped SQL identifiers |
| `mysql2` | `^3.15.0` | 3.22.0 | auth-plugin downgrade to `mysql_clear_password` leaks plaintext credentials |
| `axios` | `^1.12.0` | 1.18.0 | large cluster: `Proxy-Authorization` leak across redirect, prototype-pollution gadgets, SSRF via `no_proxy` bypass |
| `nanoid` | `^5.1.5` | 5.1.16 | integer overflow; non-secure generators loop indefinitely on negative size |
| `@trpc/server` | `^11.6.0` | 11.8.0 | prototype pollution in `experimental_nextAppDirCaller` — not used here |

The `drizzle-orm` advisory is worth reading closely rather than assuming it applies: every
raw-SQL site in the codebase uses parameterised tagged templates, `sql.raw` appears
nowhere, and identifiers come from the schema rather than from input. The exposure looks
low, but the fix is a patch release.

### DEP-3 — 153 advisories in total (Informational)

3 critical, 58 high, 81 moderate, 11 low across 915 resolved packages.

**Corrected 2026-09-21. The original text said these were "build- and test-chain
only" and that "none of it ships in `dist/index.js`". That is false**, and the
evidence is in the bundle itself. `esbuild` is run with `--packages=external`,
so every bare import survives into the output; `dist/index.js` carries:

```
from "vite"                            from "@vitejs/plugin-react"
from "@tailwindcss/vite"               from "@builder.io/vite-plugin-jsx-loc"
from "vite-plugin-manus-runtime"
```

They are there because `server/_core/index.ts:9` imports `./vite`
unconditionally, and that module imports `vite` and `../../vite.config` at the
top level. The production branch only calls `serveStatic`, but an ESM import is
evaluated when the module loads, not when the branch is taken.

Two consequences, both pre-existing rather than introduced by this work:

1. **The production server requires five `devDependencies` at runtime.** A
   deployment that installs without dev dependencies gets
   `ERR_MODULE_NOT_FOUND` on `vite` at startup.
2. **`tar` is reachable from the production runtime graph** —
   `@tailwindcss/vite` → `@tailwindcss/oxide` → `tar` — and `tar` carries a
   critical advisory. So the claim "no critical advisory remains in the shipped
   tree" was wrong; `vitest` genuinely is test-only, `tar` is not.

`dompurify` and `mermaid` arrive through `streamdown`, a production dependency,
and were likewise miscategorised as build-chain.

**The obvious repair does not work,** which is worth recording so the next
attempt does not start there: splitting `serveStatic` into its own module and
making `setupVite` a dynamic `import()` leaves the externals list unchanged,
because esbuild inlines a dynamic import of a local module and hoists its
imports. It needs `--splitting`, which changes the shape of the deployment
artifact, so it belongs in a change made deliberately rather than folded into
a dependency patch.

### TEST-0 — 34 tests never run anywhere, including a cross-tenant regression (High)

Added 2026-09-21, and it is the most consequential thing this audit missed the
first time.

`server/widgetPersistence.db.test.ts` (24 cases) gates on `WIDGET_DB_URL`;
`server/widgetConflict.db.test.ts` (10 cases) gates on `WIDGET_DB_SOCKET ||
WIDGET_DB_URL`. Neither `.github/workflows/ci.yml` nor `scripts/ci-gate.sh`
sets either variable — CI provisions MariaDB and exports `DATABASE_URL` only.
So these suites skip locally **and** in CI. They have never run in this
repository.

What is dormant matters. The first file says why it exists, in its own header:

> The security block is the reason this file exists. B23's store could be made
> to overwrite another user's board by supplying their `layoutRef`, and no unit
> test could have caught it, because the defect was in a SQL statement that had
> never executed.

Its case at line 285 is `refuses across tenants, and the read cannot see it
either`. The regression test for a cross-tenant overwrite is switched off by a
variable nobody sets, and it reports as *skipped* — which reads like a suite
waiting for a database rather than a guard that is not guarding.

This also corrects the framing used throughout the rest of this document. "CI is
the authority on the database-backed suites" is true of the 33 that gate on
`DATABASE_URL` and false of these two.

**Fix:** export `WIDGET_DB_URL` alongside `DATABASE_URL` in the CI job — the
same MariaDB service can serve both — and fail the gate if a `.db.test.ts`
suite reports skipped when a database is configured. Not applied here: pointing
both at one database may need schema separation (`WIDGET_DB_NAME` exists), and
switching on 34 previously-unrun tests is a change that should land on its own
rather than inside a dependency patch.

### TEST-1 — `fieldroute.test.ts` needs a database but does not self-skip (Medium)

**Corrected 2026-09-21.** The original text said the `beforeAll` "guards its fixture
inserts with `if (!process.env.DATABASE_URL) return;`, then unconditionally calls
`grantUserRole` and `dispatch.enforcementSet`". It does not: that `return` is the
hook's first statement, so without a database the whole hook exits immediately and
`grantUserRole` is never reached at all.

The effect is the same and the mechanism is the opposite. The suite fails not because
a helper hit a missing database, but because the role grant the hook exists to perform
never happened — so the caller holds no domain role and `roleProcedure` refuses all 14
procedures, exactly as it should. Every failure reads `User holds no domain role`,
which is the gate working, not a defect.

The 35 sibling suites that need a database are named `.db.test.ts` and skip cleanly;
this one is not, so `pnpm test` without MariaDB reports 14 failures that mean nothing.
CI has always had a database, which is why it has gone unnoticed.

**Corrected: the rename this originally proposed would not have worked, and the
reason given for deferring it was false.** The `.db.test.ts` suffix is inert —
`vitest.config.ts` includes `server/**/*.test.ts`, which matches it identically.
Those suites skip because each one opens with its own
`const d = URL ? describe : describe.skip`, not because of its name. Renaming
`fieldroute.test.ts` would leave all 14 failures exactly where they are.

The deferral reason was also wrong. It said renaming "touches the register's
claim checks"; `registerClaims.test.ts` reads only the paths cited in
`docs/REMAINING_BUILD_REGISTER.md`, and that document does not cite this file.
Nothing was at risk. The real fix is the in-file guard every sibling already
has, and it is small — it was declined on a constraint that did not exist.

### TEST-2 — register commit claims could not resolve after import (fixed)

`server/registerClaims.test.ts` verifies that every commit hash cited by a `DONE` row in
`docs/REMAINING_BUILD_REGISTER.md` exists, via `git cat-file -e`. Six short hashes —
`4531847`, `6720087`, `4626eb6`, `54965ee`, `8a03803`, `d6a3433` — name commits in the
pre-import history, which did not come across with the snapshot.

Deleting the citations would have been the wrong repair: those rows are the record of when
that work landed, and the reference is the provenance the register exists to carry. Instead
the six are named once, in a closed `PRE_IMPORT_COMMITS` set in the test, with a comment
explaining what they are. The guard is unchanged for everything else — any commit cited
from this repository's history forward must still resolve, and a new unresolvable hash
still fails.

### QUAL-1 — storage keys are not checked for traversal segments (Low)

`normalizeKey` in `server/storage.ts` strips leading slashes but does not reject `..`.
Every caller today builds its key from a server-side record number (`invoices/${inv.invoiceNumber}/…`,
`tickets/${t.ticketNumber}/…`), so nothing reaches it that a user controls. It is a
missing guard rather than a live bug.

### QUAL-2 — TOTP comparison and replay (Low)

`totpVerify` in `server/_core/externalIdentityPolicy.ts` compares with `===` rather than a
constant-time comparison, and a code stays usable for its whole ±1-step window. The
5-attempt lockout makes both hard to exploit. The AES-256-GCM secret handling around them
is correct: random IV per encryption, auth tag verified on decrypt.

### QUAL-3 — single 1 MB client chunk (Low)

The client builds to one 1,075 kB chunk (263 kB gzip); Vite says so itself. Route-level
code splitting would cut first paint on the field devices this is aimed at.

## What held up well

Worth recording, because an audit that only lists faults misdescribes the codebase.

- **Authorization is enforced server-side and fails closed.** `roleProcedure` throws at
  *wiring* time for an unmapped procedure rather than degrading to authenticated-only, and
  refuses a sensitive action outright when its audit row cannot be written. 646 procedures
  go through it; the gate script counts bare `protectedProcedure` and holds it at zero.
- **The portal gate is built to the same standard.** Bearer tokens stored only as SHA-256,
  scope derived from the resolved identity rather than from the request, MFA on sensitive
  writes, lockout, and an audit row for every decision including denials.
- **No SQL injection surface.** Parameterised tagged templates throughout, `sql.raw` unused.
- **No secrets in the tree.** Pattern scans for private keys, GitHub/AWS/OpenAI/Slack token
  formats and literal credential assignments all came back empty. Every secret is read from
  the environment, and the storage, MFA and webhook consumers fail closed when one is missing.
  **Corrected: "every consumer fails closed" was too broad** — it was contradicted by this
  document's own SEC-1, where `JWT_SECRET` fell back to `""` and nothing checked it. That is
  now true of the session secret too, but it was not true when this line was written.
- **The read-URL proxy was removed rather than gated,** and `server/storage.ts` explains
  why in the file: a gated proxy would have been a second authorization path to the same
  bytes.
- **Data files are public open data, correctly attributed** (Open Government Licence –
  Alberta). No PII.

## Suggested order of work

1. **SEC-1** — refuse to boot in production without an adequate `JWT_SECRET`. One guard,
   closes the worst case.
2. **DEP-1** — drop the two unused AWS SDK packages. Removes the only critical production
   advisory and shrinks the install.
3. **DEP-2** — patch `mysql2`, `drizzle-orm`, `axios`, `nanoid`.
4. **SEC-2 / SEC-3** — gate the `sessionStorage` mirror on a non-production build, and
   bring the session lifetime down from a year.
5. **SEC-5** — `helmet`, a rate limiter, and a body limit scoped to the routes that need one.
6. **SEC-6** — one equality check against `ENV.appId`.
7. **TEST-1** — make the database dependency self-announcing.

None of this is blocking for the import itself.

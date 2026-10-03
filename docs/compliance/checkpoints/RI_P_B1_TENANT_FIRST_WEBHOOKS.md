# RI-P B1 — tenant-first webhook dispatch

Manifest item B1 (`docs/route-intelligence/LATER_FEATURE_PORT_MANIFEST.md` on the T0 branch).
Source in the original lineage: v23.29 `3c4f997`, "filter webhook subscriptions by tenant before
decrypting". It was ported by intent, not cherry-picked. Since that commit was written, `main`'s
dispatcher has gained SEC-004 attempt claiming, the S2-E secret resolver, S2-KMS-A and the SSRF
egress guard, so the old diff no longer applies.

## What `main` already had

The v23.29 defect was that every subscription's secret was decrypted at the top of the loop,
before the tenant check. SEC-004 (`1df0516`) fixed that on `main` independently: the secret is
resolved lazily, the first time an event of the subscription's own tenant is due. A foreign
tenant's secret was therefore never resolved. Nothing pinned that, though.

## What `main` still got wrong

`dispatchWebhooks` still selected **every active subscription in the table**. It then ran
`JSON.parse(s.eventTypesJson)` on each one, before the per-event tenant check. As a result:

- **W4.** One damaged subscription row belonging to *any* organization threw `SyntaxError` and
  aborted dispatch for *every* organization. The worker swallows that throw, so the visible
  symptom is that nothing is delivered.
- **W8.** The retry sweep builds mixed-tenant batches. In those, one tenant's damaged row in
  scope stopped the other tenant's deliveries as well.

`eventTypesJson` is a plain `text` column. The router writes it with `JSON.stringify`, but nothing
at the database layer guarantees its shape.

## The change (`server/webhookDispatchService.ts`)

1. **Scoping moved into the query.** Events are loaded first. Subscriptions are then selected
   with `inArray(orgRef, <the events' tenants>)`. An explicit `orgRef` narrows that set and never
   widens it. A NULL-`orgRef` subscription is excluded by the same `inArray`. The existing
   per-event `ev.tenantId !== s.orgRef` check stays as the second half of the same rule.
2. **A bad event-type list is isolated to its own subscription.** If the list does not parse, or
   is not a list of strings, that subscription is skipped and named in a `console.warn` (reference
   only: no list, no url). This is the same treatment SEC-004 gives an unreadable secret.

Nothing else changed: claiming, signing, the resolver, egress, retry and the result shape are as
before. There is no migration and no schema change.

### Deliberately not ported

v23.29 recorded an unreadable secret as a `failed` delivery row carrying `SECRET_UNREADABLE`.
`main` (SEC-004 / S2-E) instead skips the subscription and logs the resolver's reason. That is a
product decision about delivery-row vocabulary, not tenant isolation, so it is left to the owner
(see "Open question").

## Tests — `server/webhookTenantIsolation.db.test.ts`

The signing-secret resolver is wrapped with `vi.fn` around the real implementation, so behaviour
is unchanged, and every subscription it is asked about is recorded. A damaged row that the
dispatcher reads is named in a warning. So a foreign damaged row that produces no warning was
never read.

| Test | Asserts | Against `main` before the fix |
|---|---|---|
| W1 | A's event: only A resolved and sent | pass (pins SEC-004) |
| W2 | reciprocal | pass |
| W3 | mixed batch: each event goes only to its own tenant | pass |
| W4 | foreign damaged row never read; A delivered | **FAIL** — `SyntaxError` |
| W5 | tenant with no subscriptions: nothing resolved or sent | pass |
| W6 | explicit `orgRef` narrows and never widens | pass |
| W7 | NULL-`orgRef` subscription is inert | pass |
| W8 | mixed batch: B's two damaged rows (unparseable, not-a-list) stop neither A nor B's healthy one; each is warned by reference only | **FAIL** — `SyntaxError` |

**Mutation check.** I applied only change 2, removing the `inArray` scope. W4 failed: the foreign
row was read and warned about. W6 also failed: with `orgRef` set to A, B's subscription was sent
B's event. Each half of the change is therefore load-bearing.

Hygiene: every row this file creates is revoked after each test. Every test uses tenants of its
own, and the scheduling clock is 2036, so no other suite's sweep finds these rows due.

## Open question for the owner

Should an unreadable secret (or unreadable event-type list) also leave an auditable `failed`
delivery row, as v23.29 did, instead of only a log line? Today an operator learns about it from
logs alone.

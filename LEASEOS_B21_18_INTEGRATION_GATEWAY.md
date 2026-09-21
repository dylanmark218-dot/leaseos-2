# LeaseOS — v21.18 Checkpoint: Integration Gateway

| | v21.17 | **v21.18** |
|---|---|---|
| Tables | 227 | **231** (+4) |
| Migrations | 52 | **53** |
| Role-authorized procedures | 306 | **313** (+7, `integrationRouter`) |
| Externally-gated procedures | 33 | **33** |
| **Integration-gated procedures** | — | **2** (`inboundRouter`, `integrationProcedure`) |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 73 | **75** (+2); integration sensitive: ingestion |
| Tests | 1,407 | **1,414** (+7, `integrationGateway.test.ts`) |
| Test files | 72 | **73** |
| Parity | 227/227 | **231/231 column-level** |
| CI gate | PASS | **PASS — step 7c pins the machine gate** |

Every count is read from the source. Reserved slots 0016/0017 untouched.

---

## A machine is an identity

`integrationProcedure` is the third gate, built like `externalProcedure`
and no weaker. A client is registered with a kind and the **scopes** — the
feeds it may send; its key is shown once and stored only as a hash. The
key in `x-integration-key` resolves to exactly one active client; revoked
or locked is refused by name; every decision is an audit row; and
ingestion, the sensitive permission, is refused when its audit row cannot
be written. An unmapped inbound procedure refuses to mount. The gate's step
7c asserts the inbound router mounts only this builder.

## What it sends is a proposal

Every inbound event is **idempotent by the client's own key** and stored
with its hash: the same key returns the same event with no second record,
and different content under the same key is named as such. Intake is by
scope and by shape, with every missing field listed. What an event becomes
is a proposal into a ledger that already holds proposals: a fuel-card
transaction lands in the fuel ledger as `needs_review` with its jurisdiction
sourced to the card statement; a GPS position is **evidence only** — it is
not projected onto a route or a board until a routing source exists, and it
never makes a unit WORKING by itself; a duty record carries its source. A
generic event is kept for a person to route. Nothing a machine sends is
confirmed.

## What goes out is signed, retried, and dead

A webhook subscription names a URL (https only), event types with dotted
wildcards, and a secret shown once and stored **encrypted under the server
key**. Dispatch reads the outbox: each delivery is the event's JSON signed
with HMAC-SHA256 over `timestamp.body`, the receiver verifying within a
five-minute window against replay. A 2xx is delivered and never re-sent; a
failure retries at 1, 5, 30, 120 and 720 minutes; the sixth failure is
**dead until a person re-queues it**, and every attempt is a kept row. The
suite drives the transport with a fake endpoint that verifies the signature
using the secret it was shown once, then fails its way to dead. A revoked
subscription does not come back.

---

## Files

**New:** `0054_integration_gateway.sql` (4 tables) · `integrationGateway.ts`
· `integrationRouter.ts` (7 role + 2 integration) · `integrationGateway.test.ts` (7)

**Changed:** `trpc.ts` (`integrationProcedure`) · `recordsAuthorization.ts`
(3 permissions, 2 sensitive, 7 mapped; `INTEGRATION_PROCEDURE_PERMISSIONS`)
· `db.ts` · `routers.ts` · `schema.ts` · `ci-gate.sh` (step 7c) · generator
· drift guards · inventory

## Not built, and named

A worker loop that dispatches webhooks unattended — dispatch is a callable
step, run by the office or a scheduler. Inbound vendor bills and facility
tickets by machine (those enter by the portal). Client lockout on repeated
bad keys (the columns exist; unknown keys are refused but not counted
against a client, because an unknown key belongs to no client).

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source: positions are evidence, not projection.

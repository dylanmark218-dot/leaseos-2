# LeaseOS — v22.1 Checkpoint: Contract Terms Decide; the Worker Delivers

| | v22.0 | **v22.1** |
|---|---|---|
| Tables | 249 | **250** (+1; `fieldTicketEvents.billableMinutes`) |
| Migrations | 57 | **58** |
| Role-authorized procedures | 353 | **356** (+3 on `closeoutRouter.ts`) |
| Externally-gated procedures | 33 | **33** |
| Integration-gated procedures | 2 | **2** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 89 | **90** (+1) |
| Tests | 1,441 | **1,447** (+6, `contractTerms.test.ts`) |
| Test files | 77 | **78** |
| Parity | 249/249 | **250/250 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots 0016/0017 untouched.

---

## The rule the closeout was waiting for

Since v21.11 the closeout has answered standby, customer and weather holds,
disposal time and return travel as **REVIEW**, because "a contract rule
would decide" — and none existed. The v21.11 events table already carried a
`billingRuleRef` column that nothing wrote. This is the rule.

**Terms per customer account**, versioned: standby billable or not with its
grace minutes, each hold, travel to disposal, disposal queue and unload,
return travel, a minimum, and the clause each answer comes from. They are
recorded by the office and **approved by a controller, management or legal —
never the recorder — against the contract document in the vault**; a draft
decides nothing; a new version supersedes.

## Decided, cited, and never the clock

An approved term in effect on the event's date decides the answer **at
record time**, and the event carries the citation: `TERMS-… v1 §4.3`. Grace
minutes reduce **`billableMinutes`** — 45 of a 75-minute standby — while the
standby clock stays 1.25 hours; a 20-minute standby within the grace is not
billable and says so. An open standby is decided when it closes. A ticket
recorded before terms existed is re-decided **on demand**, review answers
only; a signed ticket's snapshot stands and the re-application is refused.
The snapshot sums billable minutes and names which rule decided each
standby. Without terms, everything is REVIEW, exactly as before.

## The worker delivers

Webhook dispatch moved out of the router into a service. The drain worker
calls it for the **event it just processed** — the attempt is its own row and
never fails the event — and runs the **retry sweep on its heartbeat**, so a
failed delivery is retried when due without anyone pressing a button. The
suite watches a delivery fail from `processEvent`, stay untouched at +30 s,
and go out from the heartbeat at +1 min.

---

## Corrected on the way

The `billableMinutes` column was first declared on the wrong table in
`schema.ts` — the column-level parity test refused it before it shipped.
The router's event mapping narrowed away the new fields before the
composer saw them; the DB test caught the 6.25 that should have been 5.75.

## Files

**New:** `0059_contract_terms.sql` · `contractTerms.ts` ·
`webhookDispatchService.ts` · `contractTerms.test.ts` (6)

**Changed:** `siteCloseout.ts` (billable minutes; the citing finding) ·
`closeoutRouter.ts` (+3; decided at record and close; the event mapping) ·
`integrationRouter.ts` (delegates) · `workflowRuntime.ts` (worker step and
sweep) · `recordsAuthorization.ts` (2 permissions, 1 sensitive, 3 mapped) ·
`schema.ts` · drift guards · inventory · generator

## Not built, and named

A minimum-hours term is recorded but not yet applied to the ticket's hours.
Terms deciding rates (a term names billability; the rate card names the
price). Post-site events decided by terms are recorded on the event; the
supplement's post-site basis still comes from the signatory's authorization.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.

# LeaseOS — v21.20 Checkpoint: Workforce Lifecycle

| | v21.19 | **v21.20** |
|---|---|---|
| Tables | 235 | **243** (+8) |
| Migrations | 54 | **55** |
| Role-authorized procedures | 320 | **336** (+16, `workforceRouter.ts`) |
| Externally-gated procedures | 33 | **33** |
| Integration-gated procedures | 2 | **2** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 78 | **84** (+6) |
| Tests | 1,421 | **1,428** (+7, `workforce.test.ts`) |
| Test files | 74 | **75** |
| Parity | 235/235 | **243/243 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots 0016/0017 untouched.

---

## A hire waits for its screenings

An applicant is HR's record — `hr.applicant.manage`, sensitive — and the
list carries no contact detail. A driver's file opens with the company's
five required screenings: licence, abstract, references, right to work,
road test. **A pass needs its evidence record**; a required screening is
not waved off as not-required. The hire is refused while any required
screening is pending or failed, and says which: *Pending required
screening: road test*. A hired driver gets an operator record — the one
dispatch reads — and an onboarding plan.

## Onboarding and training enter the registry by a second person

The plan is tasks with due dates. A task that stands for a credential —
H2S Alive, first aid, TDG — is completed only with the certificate in the
evidence vault, and **verified by someone other than its completer**; the
verification writes a `complianceDocuments` row, verified, with its expiry
and its source, against the operator dispatch already reads. Training
records the same way: recorded by one person, verified by another, with a
course-to-credential map that is configuration, and an unmapped course is
*training only — nothing enters the registry*. Nothing verified twice.

## Competency, probation, and the doors

Competency is a supervisor's signature — never self-declared — and senior
follows competent. Probation is **recommended by a supervisor and decided by
HR**, who may differ and are named on the difference; an extension carries
its new date. Offboarding revokes every role grant and every field device
in one act, with the offboarding as the reason, and **closes only when every
door is named shut**: roles, devices, tools checked out, final pay proposed,
last day passed. The suite watches a driver's `dispatch.read` disappear on
that one act and the close refused again until the wrench came back.

---

## Files

**New:** `0056_workforce_lifecycle.sql` (8 tables) · `workforce.ts` ·
`workforceRouter.ts` (16) · `workforce.test.ts` (7)

**Changed:** `recordsAuthorization.ts` (10 permissions, 6 sensitive, 16
mapped) · `routers.ts` · `schema.ts` · drift guards · inventory · generator

## Not built, and named

Final pay as a payroll computation (proposed only; payroll decides).
Portal identities are not employee-linked, so offboarding does not touch
them (they are customers, vendors and facilities). Recurring training
reminders (expiry is in the registry; the exception centre already reads
expiring credentials). User account creation (an authentication concern;
the hire names the account).

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.

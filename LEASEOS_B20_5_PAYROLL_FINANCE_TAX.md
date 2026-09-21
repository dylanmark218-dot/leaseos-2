# LeaseOS — B20.5 Checkpoint: Payroll, Finance & Tax Foundation

**Date:** 2026-09-07
**Base:** v20.8 (106 tables · 676 tests)
**Output:** v20.9 — **128 tables · 22 migrations · 747 tests · 33 files**

---

## 1. Exact numbers

| | |
|---|---|
| Tables | **128** (+22) |
| Migration files | **22** (0022, 0023 added; 0016/0017 still reserved) |
| Tests | **747** (+71) |
| Test files | **33** |
| Typecheck | clean |
| Build | clean — `dist/index.js` 290.2 kb |
| Domain roles | **15** (+5 finance) |
| Permissions | **83** |
| Sensitive permissions | **23** |
| `protectedProcedure` remaining | **57** (unchanged — no API added this pass) |

---

## 2. What I built, and what I deliberately did not

You handed me three documents describing roughly 80 tables and 16 sub-builds. Building all of it in
one pass would have produced a lot of plausible-looking code, and the one thing this subsystem cannot
afford is plausible-looking. So this checkpoint is **the foundation the rest has to stand on**, built
properly:

**Built**
- Financial identity separation — one person can be an employee of a corporation *and* a sole
  proprietor, and those books never merge
- **Tax rule engine with provenance** — the piece everything else depends on
- Expense treatment, business-use splitting, duplicate detection
- Payroll: versioned rates, evidence-backed earning events, three-clock reconciliation, pay-run
  lifecycle, contractor/employee boundary
- Authorization: 5 finance roles, 30 new permissions, the employee-private boundary

**Not built, and named as such**
- AI document scanner, OCR, question queue, merchant memory, home-base distance
- GST/HST ledger, capital assets and CCA, year-end package, accountant portal
- Bank/card import and reconciliation, tax calendar, audit response builder
- Any tRPC procedures — this is engines and schema only

---

## 3. The rule that governs the whole subsystem

**LeaseOS catalogues and substantiates. It does not determine tax treatment.**

Every tax rule carries a jurisdiction, tax year, effective window, named source authority and a
verification status. An unverified rule produces **UNKNOWN with a reason**, never a number. This is
the financial form of the routing engine's rule that a satisfied limit on unverified data is REVIEW
rather than PASS — and the stakes are the same, because a confidently wrong tax figure is worse than
an obvious gap.

**Your message contained real figures — a registration threshold, the filing forms for each taxpayer
type. I did not hard-code any of them.** Not the threshold, not "a corporation files a corporate
return." A test asserts that with no rules loaded, `buildFilingProfile` returns *zero* obligations and
`incomplete: true`, even for a corporation. The moment one obviously-true thing gets hard-coded, the
next one does too, and eventually a rate lands in a source file with no date and no source.

A test also pins that an unverified rule carrying `30000` yields UNKNOWN **and that the number does
not appear anywhere in the result**.

Rules are looked up *as of a date*, so amending a prior period re-runs against the rule in force
then.

---

## 4. Separations the engines enforce

**HOS ≠ payroll ≠ billable.** Three clocks are compared, none overwrites another, and a variance
beyond tolerance becomes a payroll exception with the note *"employee time stands until reviewed."*
`payrollActivityAffectsHos()` returns `false` as an assertion, not a comment — tapping "standby" on a
pay screen must never write a duty status.

**A rate is versioned, not overwritten.** Re-running March in September uses the March rate.
Test-pinned with `driver.hourly-v1` at $34 and `-v2` at $36.

**Every dollar points at what produced it.** Four loads at $35 references LOAD-9911 through -9914.
An earning with no supporting record is *blocked*, not calculated — except a manual HR adjustment,
which is allowed to have none because that is what it is.

**A weak measurement does not become a wage.** Tonnage pay reuses the B20 measurement ladder: a rate
requiring `instrument_measured` blocks on an estimate, and blocks on an unrecognized vocabulary
value. Same fail-closed behaviour as the disposal billing gate.

**An employee is not a contractor.** `assertPayrollEligibility` refuses a contractor outright and
`assertSettlementEligibility` refuses an employee. Hard boundary, not a warning — the mistake is easy
to make when both people drove the same truck.

**Paid payroll is never edited in place.** `paid → review` is not a legal transition;
`correctionRouteFor("paid")` returns `adjustment_required`.

**The personal half of a mixed-use purchase is stored.** $135 phone bill at 70% business emits *two*
allocation rows. Deleting the personal portion to make the expense look wholly business is the thing
`buildAllocations` exists to prevent.

**Percentage pay applies to eligible revenue,** not the invoice total — tax and third-party
pass-through are excluded, with the breakdown kept for the payslip explanation.

---

## 5. Authorization

Five roles added — `bookkeeper`, `payroll_admin`, `tax_preparer`, `controller`,
`external_accountant` — because payroll and tax work belongs to people whose job it is, not to HR by
accident of being sensitive or management by seniority.

| Boundary | Enforced |
|---|---|
| Legacy `payroll.read` still **HR alone** | Pinned across all 15 roles |
| Management gets **no individual private payroll** | `read_employee`, `read_all`, `read` all denied |
| Dispatch gets **no payroll** | see flag below |
| Running payroll ≠ approving it | `payroll_admin` runs, `controller` approves; neither does both |
| Reading a rate ≠ changing one | `rate.read` vs `rate.write` |
| Personal tax organizer is **private** | No employer-side role reaches `tax.read_personal_own` |
| Closing a fiscal year | `controller` only |
| External accountant reads books, runs nothing | Denied investigations, releases, amendments, role grants |

**`payroll.bank.read`, `payroll.tax_identifier.read` and `tax.rules.manage` are held by nobody.** They
exist so the permission has a name to be denied under, and so adding a holder is a deliberate,
reviewable act. Same reasoning as the empty `authority_certified` tier in the measurement ladder.

---

## 6. One thing I want to flag rather than decide silently

Your role direction says **"Dispatcher → none"** for payroll. I built exactly that — which also means
**a dispatcher cannot open their own payslip.** Every other worker role (driver, mechanic, shop lead)
gets `payroll.read_own`.

I suspect the spec meant *no access to other people's payroll administration*, not *no access to
their own pay*. I did not quietly widen it. The test is named
`"gives dispatch no payroll access, including their own — as specified"` with the reasoning in a
comment, so the decision is visible and one line to reverse.

---

## 7. Bug found

`shop_lead` was missing `payroll.read_own` — my grant edit landed on the `mechanic` block instead.
Caught by the test asserting every worker role reads their own pay. The **code** was wrong against
your stated direction ("shop lead → none beyond own pay"), so the grant was fixed rather than the
assertion relaxed.

---

## 8. Files changed

| File | Change |
|---|---|
| `drizzle/0022_payroll_finance_tax.sql` | **New** — 22 tables |
| `drizzle/0023_finance_roles.sql` | **New** — 5 roles added to the enum |
| `drizzle/schema.ts` | +22 tables, +5 role values |
| `server/_core/taxRuleEngine.ts` | **New** — provenance, UNKNOWN, filing profile, thresholds |
| `server/_core/expenseTreatment.ts` | **New** — treatment, splits, duplicates |
| `server/_core/payrollEngine.ts` | **New** — rates, earnings, clocks, lifecycle, classification |
| `server/_core/recordsAuthorization.ts` | +5 roles, +30 permissions, +12 sensitive |
| `server/_core/payrollFinanceTax.test.ts` | **New** — 58 tests |
| `server/_core/recordsAuthorization.test.ts` | +13 payroll/tax boundary tests |

---

## 9. Remaining gaps

**Nothing here is reachable over the API.** No tRPC procedures, no UI. The engines are pure and
tested; a caller cannot invoke any of it yet. Same position B20.2 was in before B20.3.

**No tax rules are loaded.** Every determination in the system currently returns UNKNOWN. That is
correct behaviour and it is also useless until an authoritative, dated, sourced rule set is loaded by
someone holding `tax.rules.manage` — which nobody holds yet.

Also outstanding: the 13 sub-builds listed in §2 · 57 authenticated-only procedures · encrypted device
storage · Audit Package Builder · verified statutory retention sources · the spatial + LoadSense and
Integrated Operations branches.

---

## 10. Next recommended step

**B20.6 — Payroll & Finance API**, following the B20.3 pattern: `roleProcedure` on every procedure,
server-side subject resolution, the employee-private boundary enforced at the DTO layer rather than
hidden in the client, and API-level negative tests for each of the boundaries in §5.

After that, the AI scanner is the highest-leverage remaining piece, because it is what removes the
filing work — but it should be built on top of a gated API, not before one.

Status in one line: *the financial foundation is built, tested and honest about what it does not
know; none of it is reachable yet, and no tax rule has been loaded.*

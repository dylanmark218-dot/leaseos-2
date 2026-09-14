# LeaseOS — B20.7 Checkpoint: Payroll, Finance & Tax API (P2)

| | Previous | New |
|---|---|---|
| Version | v20.10 | **v20.11** |
| Tables | 128 | **128** (no schema change) |
| Migrations | 22 | **22** |
| Procedures (role-authorized) | 102 | **142** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 104 | **104** |
| Sensitive permissions | 28 | **31** |
| Domain roles | 15 | **15** |
| Tests | 761 | **791** |
| Test files | 33 | **34** |
| Parity | 128/128 | **128/128** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 357.8 kb |

---

## Completed — P2

The payroll, finance and tax engines built in B20.5 are now callable. **40 new
procedures**, every one through `roleProcedure`, across three routers: `payroll`,
`contractors`, `finance`.

Covered: employee profiles · pay groups · versioned rates · time entries ·
earning events · clock reconciliation · pay periods · pay runs · approvals ·
adjustments · disputes · employee own-pay · contractor settlements · expenses ·
allocations · financial entities · registrations · tax rule sources · tax rules ·
private personal-tax records.

---

## The boundaries, as enforced

**Own pay takes no subject id.** `myPay`, `myTimeEntries`, `myStatements`,
`submitTime` and `raiseDispute` resolve the employee profile from the session.
There is no `employeePayrollProfileId` field on any of them — the boundary is
structural, not filtered. A test asserts it against the `.input()` schemas
specifically.

**Running payroll is not approving it.** `payroll_admin` holds `payroll.run` and
is refused `payroll.approve`; `controller` holds the reverse. Tested through the
router in both directions, and the permission holders are pinned to exactly one
role each.

**Management has no implicit access to private payroll.** Refused
`profilesList`, `earningsList`, `runsList` and `export`.

**Dispatch has no payroll administration** — and, per the flag carried from
B20.5, no own-pay either.

**External accountant reads books and runs nothing.** Reaches entities,
expenses, tax rules and settlements; refused pay runs, trip creation, work
orders, incident investigations and entity creation.

**Paid payroll is not editable in place.** `runApprove` validates against the
lifecycle and refuses illegal transitions, with the message naming adjustment as
the correction route.

**A contractor is not an employee.** `profileUpsert` refuses a contractor;
`settlementCreate` refuses an employee. Both hard errors.

**No wage, banking or tax-identifier data in generic shapes.** `profilesList`
returns a narrowed projection with no rate. Self-service returns purpose-built
shapes.

**UNKNOWN is preserved.** `filingProfile` returns zero obligations and
`incomplete: true` for a corporation with no rules loaded. `thresholdCheck`
returns `unknown`, not "not required".

---

## Real bugs found

**1 — Office, management and bookkeeper could not create an expense.**
`tax.expense.create` was granted to field roles only. Found by an API test where
an office caller was refused its own expense assessment. Grant fixed.

**2 — The `ALL_ROLES` list in the operational test was stale.** It still held the
original 10 roles, so permissions held only by a finance role appeared to have no
holder at all. The "every permission has a holder" guard was checking against an
incomplete universe and would have reported false orphans indefinitely.

**3 — Two of my own tests were wrong, in the same way as before.** One asserted a
string was absent from a code slice that contained it *in a comment I had
written saying it was absent*. The other counted 43 wired procedures where there
are 40. Both were caught, both fixed by correcting the test to check the thing it
meant to check — the `.input()` schemas with comments stripped, and the measured
count.

**4 — The drift guard only inspected `routers.ts`.** With the operational
permission map now spanning two files, 40 declared permissions would have gone
unwired without the guard noticing. It now checks both sources.

---

## Security findings

**A deliberate reversal, documented.** B20.5 left `tax.rules.manage` held by
nobody. B20.7 grants it to `controller` alone. A permission no role can hold is a
procedure nobody can call — the system could never leave UNKNOWN. It stays
sensitive and audited, and the service independently downgrades any rule to
`unverified` unless its source is verified and names an authority, regardless of
what the caller requested. Tested.

**An inconsistency flagged, not silently resolved.** `tax.read_personal_own` is
scoped to the session user, so holding it only ever returns the holder's own
documents. It is granted to workers and HR but not to office, controller or
bookkeeper — who are also people with their own tax slips. The split is
arbitrary. Recorded as an open question in the inventory rather than widened on
my own judgement.

---

## Inventory cleanup — done

`PROCEDURE_AUTHORIZATION_INVENTORY.md` rewritten. The directive was right: it
carried narrative describing the 57-procedure tranche as "next" beside a table
showing it complete. A future agent could have repeated finished work. The
`AUTHENTICATED_ONLY_UNREVIEWED` class is removed entirely — nothing is in it. A
test now asserts the stale phrasings cannot return.

---

## Newly closed

Gap items **#28** (payroll/finance API) and **#49** (contractor settlement
foundation, now callable and correctly refusing to assess information-return
applicability without a verified rule). Directive §3 complete.

---

## Genuine blockers

**BLOCKED — P0 branch reconciliation.**
*Why:* Spatial Navigation, LoadSense and Integrated Operations source has never
been supplied. Uploads contain one file, the v20 trunk; a source-wide grep for
`loadSense`, `roadGraph`, `operationsEngine`, `aiSecretary` returns nothing.
*Required input:* the actual branch ZIPs.
*Safe work continuing:* slots 0016/0017 reserved; everything additive.

**BLOCKED — gap item #5, enforcement-evasion routing guard.**
*Why:* it guards a routing preference structure that lives in the missing branch.
Building it against a structure I invented would create a second thing to
reconcile.
*Required input:* the Spatial branch.

**BLOCKED — P9 authoritative datasets.**
*Why:* no tax rule, HOS rule, retention period or road restriction has been
loaded from an authority. Every determination correctly returns UNKNOWN. The
loading path now exists (`finance.taxRuleLoad`, controller-only) but requires
sourced, dated, verified data.
*Required input:* authoritative source material, or a decision to research it.

---

## Remaining

P3 scanner/OCR · P4 encrypted device storage · P5 spatial (blocked) · P6 UIs ·
P7 GST/HST, banking, capital assets, year-end · P8 comms, TrackNode, equipment
ops, client portal · P9 datasets.

---

## Exact next tranche

**P3 — AI Secretary + Document Scanner + Question Queue + Auto-Filer.**

It is the largest remaining executable piece, it depends on no missing branch,
and it sits on top of two things that now exist: the sealed Evidence Vault
(B20) and the expense/tax surface (B20.7). Order within P3: extraction and
classification engines → question queue → merchant memory and duplicate matching
→ home-base distance → auto-filer → gated API.

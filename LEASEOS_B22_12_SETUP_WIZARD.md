# LeaseOS — v22.12 Checkpoint: The First-Run Setup Wizard

| | v22.11 | **v22.12** |
|---|---|---|
| Tables | 254 | **254** |
| Migrations | 68 | **68** |
| Role-authorized procedures | 378 | **378** (no new procedures) |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,503 | **1,504** (+1 client truth) |
| Test files | 85 | **85** |
| Production build | ✓ | **✓** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots untouched.

---

## A screen on top of what already answers

The server side of setup has existed since v22.7 — the profile, the charge
definitions, their approval, the readiness projection. This tranche gives a
new company the guided screen the spec described, as a panel in the
authoritative portal shell for office portals, not another page:

- **Company** — select the financial entity or create it.
- **What do you do?** — the service catalogue, activated per entity; and the
  **margin guardrails** — target, warning, minimum authority, and who may
  discount to what — business policy, not law.
- **Rates** — proposed here, approved by a different person (the office sees
  *Approve* only on proposals, and the server refuses the proposer);
  customer-specific rates, vendor payables, internal cost per unit — each a
  step keyed to its readiness check.
- **Billing terms** — shown from the readiness projection; recorded from the
  closeout where they belong.
- **Go-live readiness** — the server's percentage and exactly what is
  missing.

Every step calls the real procedure and shows the server's answer. The
wizard opens at the first step the projection says is not done, and with
no projection it claims nothing — every step *unknown*. Dollars a person
types become integers before they leave the screen; a rate keeps its three
decimals.

## Held to account

The client truth guard pins the panel to the eight real procedures it may
call, forbids demonstration identifiers in it, and tests the pure model: a
projection with two proposals pending opens the wizard at *Rates* as
*pending*, the missing vendor and unit costs as *missing*, the rest *done*.

## Files

**New:** `client/src/portal/setupModel.ts` ·
`client/src/portal/panels/SetupPanel.tsx`

**Changed:** `PortalShell.tsx` (setup panel for office portals) ·
`clientTruth.test.ts` (+1) · inventory · generator

## Not built, and named

The AI document reader that fills proposals from uploaded rate sheets,
contracts and invoices (the proposal path exists and requires the document;
the extraction does not). Browser end-to-end tests of the wizard (the
model is tested; the rendered screen is not). Recording contract terms from
the wizard (they are recorded from the closeout).

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.

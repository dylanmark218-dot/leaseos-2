# LeaseOS — v21.12 Checkpoint: Portal Identity Hardening + Billing Closeout Completion

| | v21.11 | **v21.12** |
|---|---|---|
| Tables | 201 | **206** (+5; `externalIdentities` extended) |
| Migrations | 47 | **48** |
| Role-authorized procedures | 258 | **263** (+5) |
| Externally-gated procedures | 10 | **19** (+9) |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 64 | **65** (+1); external sensitive 5 → **8** |
| Tests | 1,360 | **1,369** (+9, `portalHardening.test.ts`) |
| Test files | 65 | **66** |
| Parity | 201/201 | **206/206 column-level** |
| CI gate | PASS | **PASS** — single final line, after step 8 |

Every count is read from the source by `scripts/current-state.sh`. Reserved
slots 0016/0017 untouched.

---

## What the prompt asked, and what this tranche is

The v21.12 prompt lists sixteen surfaces. This tranche builds the ones that
are both highest-value and provable in this container and **names the rest
as not built** — the prompt's own instruction, and the one I hold to most
carefully: *do not fabricate completion metrics.*

**Built and proven:** portal identity hardening (§14), client discretionary
adjustments with the hour-equivalent invariant (§6), real PDF rendering from
frozen revisions (§5), weather and road-hazard evidence (§9), the daily
customer report (§13), audited document access (§12, server side), and the
access log every external read, download, signature, decision and
authorization now writes.

**Not built:** the customer portal *client* (§1), the live job board and its
operational states (§2), compliance pre-clearance (§3), the signing *screen*
(§4 — the signing procedure exists from v21.11; the UI does not), load and
material chain-of-custody views (§8), customer incident notices (§10), the
dispute centre beyond what v21.10/v21.11 already provide (§11), and
notifications (§15). These remain in the generated current-state file under
*not implemented*.

---

## Identity: invited, accepted once, expiring, rotating, locking, MFA

An invitation token is hashed at rest and expires in seven days; **accepting
it comes through the same external gate under its own permission** and
issues the bearer token — hashed, expiring in ninety days — once. A bearer
token rotates with a ten-minute grace window for its predecessor. Five
failures lock the identity for fifteen minutes; even a read is refused
while locked, by name. MFA is a TOTP secret — RFC 6238, reproducing the
published test vector — stored **encrypted under a server key** and, once
confirmed, required on every sensitive external write; a server without the
key refuses to enroll rather than pretending. Revocation clears the grace
token. The suite walks the whole life: the invitation refused as a bearer,
acceptance once, rotation, the wrong code four times, the lock on the fifth,
the right code after reset, revocation, and an access log that reads
*accept_invitation, token_rotate, mfa_enroll, mfa_confirm, view, token_rotate.*

## A client adjustment is billing value, never worked time

A tip, a bonus, a flat amount, a percentage of the site subtotal, or an
**hour-equivalent** at the agreed rate. The suite proves what the document
demanded: after a one-hour equivalent, **every event row is byte-identical
and R1's hash is unchanged** — no duty, payroll, GPS, equipment or standby
clock moved — while the invoice view shows 12.82 hours of which 1.00 is
labelled *billing value, not worked time*. An adjustment meant for the crew
is *proposed* to payroll; the customer's write leaves
`payrollAdjustmentRef` null; a payroll admin turns it into a payroll
adjustment *request*, never applied, with tax treatment left to payroll; a
driver cannot. Idempotent by content.

## The PDF is made from the frozen snapshot

No PDF library is in the tree, so the renderer is a deterministic PDF 1.4
writer of my own — same snapshot, same bytes. It renders from the persisted
revision and its hash, never the live ticket; a second render returns the
record that exists; the bytes carry *Source snapshot <hash>*, the signatory
and exercised authority, the post-site basis, adjustments with the
hour-equivalent marked, and the excluded company activity. R1 holds
site-phase events only — the 20:31 restock belongs to the post-site
revision and the daily report, never to the customer's bill. A download is
served only if the stored bytes still hash to the record, only to the bound
account, and is logged with the hash and the stated purpose.

## Observations and the day

A weather observation records what a worker saw, when, how bad and its
effect; an external source must be named and is never recorded as a worker.
Road hazards likewise. Billing treatment is *review* until a rule decides.
The customer projection carries neither coordinates nor names. The daily
report sums hours by billing answer — 9.48 customer-billable, 0.35 company
internal, 0 under review — counts loads and observations, and reports value
as **not computed** rather than invented.

---

## Files

**New:** `0049_portal_hardening_adjustments.sql` · `externalIdentityPolicy.ts`
· `clientAdjustments.ts` · `ticketPdf.ts` · `portalHardening.test.ts` (9)

**Changed:** `trpc.ts` (gate: invitation, expiry, lockout, MFA) ·
`recordsAuthorization.ts` · `db.ts` · `commercialRouter.ts` (invite
rewritten; revoke) · `portalRouter.ts` (+9; statement reads logged) ·
`closeoutRouter.ts` (+4) · `schema.ts` · drift guards · inventory ·
`commercialPortal.test.ts`, `siteCloseout.test.ts` (acceptance step)

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P0/P5** — no routing source; no GPS-derived segment
is created.

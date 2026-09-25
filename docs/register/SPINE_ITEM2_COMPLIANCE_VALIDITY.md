# SPINE item 2 — compliance-document validity: the first of the four duplications

The SPINE wiring plan's item 2 is *resolve the four duplications before wiring any of them*
(`dispatchMatching`, `openShifts`, `complianceDocumentValidity`, `fieldTicket`). This records the
first, done alone, one duplication at a time as the owner directed.

## The duplication

"Is this compliance document in force?" had two answers:

- **canonical** — `server/_core/documentValidity.ts` (`validityOf`), reached through the adapter
  `server/_core/complianceDocumentValidity.ts`, which was written for this and never wired;
- **inline, live** — the dispatch composer's `credentialState` (`server/readinessComposer.ts`) picked
  a row itself (verified first, then the latest expiry, rejected skipped) and the gate's
  `credentialBlocker` (`server/_core/dispatchReadiness.ts`) read only its date.

Where they disagreed, dispatch cleared what the canonical answer did not:

| | case | inline (before) | canonical |
|---|---|---|---|
| D1 | only an unverified (`needs_review`) licence | cleared | unverified |
| D2 | older verified row, newer verified correction already expired | cleared (later date won) | expired |
| D3 | verified licence whose effective date has not come | cleared | not yet effective |
| D4 | verified licence with no expiry | unknown | in force (see ruling B) |
| L | only the legacy `operators.licenseExpiresAt` date | cleared | — (unverified; ruling) |

## Rulings (owner, 2026-09-24/25)

**C — one path.** Keep the canonical evaluator; redirect the inline logic to it. Adapters may format
the answer; they do not re-decide it. C1a's hardening (typed contract, no free-text inference, one
decision path) is kept, with no second registry or engine built to get it.

**B — a missing expiry is not a permanent one.** A verified document with no expiry is in force only
when its type genuinely does not expire. Otherwise it is incomplete and fails closed. No sentinel
dates (`2099`, `9999`): MariaDB `TIMESTAMP` makes them unsafe as well as untrue.

**Answers given for this checkpoint (2026-09-25):**
- an unverified credential at dispatch → the overridable unknown the gate already gave "expiry unknown";
- no document type is yet named as never-expiring (`EXPIRY_OPTIONAL_TYPES` is empty);
- the legacy licence date is an unverified licence;
- leaseos-2 first; port to leaseos once its CI runs.

## What changed

- `documentValidity`: two states — `incomplete` (verified, no expiry, type not in
  `EXPIRY_OPTIONAL_TYPES`) and `not_yet_effective` (verified, effective date not yet reached, nothing
  earlier in force). `capabilityStatus` blocks on both without change; `countsAsHeld` handles both
  explicitly; `documentExpiry` ranks both as work-stopping.
- `readinessComposer.credentialState` returns the canonical verdict for each accepted document type,
  taking the most favourable where several are accepted (a CVIP certificate *or* an annual inspection).
- `dispatchReadiness.credentialBlocker` maps the verdict onto its existing codes — none, rejected, not
  yet effective → `_missing`; expired → `_expired`; unverified, incomplete → `_unknown`; in force,
  expiring → clear. An unverified or incomplete credential whose own date has passed is `_expired`:
  evidence of expiry is never softened into an overridable finding. No classifier rule or override
  policy changed; under C1a, `_unknown` is UNKNOWN / BLOCK lifted only by an approved override policy.

Tests: `server/complianceValidityDispatch.db.test.ts` (real composer; D1, D2, D3, L and U fail on the
main this branched from), `server/complianceValidityGate.test.ts` (the mapping table),
`server/documentValidity.test.ts` (the contract).

## The consequence to expect

An operator whose only licence is the legacy date now carries `operator_licence_unknown` until a
licence document is filed and verified. Three test fixtures that built an "established" operator from
the legacy date alone needed a verified `driver_licence`; a fleet that has not migrated its licences
will see the same.

## Still open in this duplication

- The `documentExpiry` board tile (`server/widgetSources.ts`) still decides expiry inline in the
  vault's vocabulary. Routing it through the adapter is the next step.
- Insurance-proof selection in `policiesCovering` still picks the latest-expiring proof itself.
- `EXPIRY_OPTIONAL_TYPES` is a list, not document-type metadata. Moving it to canonical type
  metadata is a later hardening checkpoint, not a blocker for this one.

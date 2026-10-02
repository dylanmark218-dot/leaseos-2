# AIL-1B: company intelligence

**Purpose:** LeaseOS may now persistently learn what an organization means, as governed
organization records rather than model memory (R-1). This covers its terminology and shorthand,
SOP knowledge, facility and customer conventions, approved preferences, known gaps and verified
corrections.

Baseline: `eb6b6dd` (TEN-EXC-1 `cd961cf`, approved, plus a remote fixture-review commit), then merged with
the branch after Copilot merged `main` into it (`8898269`, which renumbered AIL-1A's migration 0185 → 0210). Branch:
`claude/relaxed-carson-qfcopf`. Migration: `0214`. **SEC-OUTBOUND-1 remains open.**

This builds on AIL-1A (scopes, proposal tenancy), AIL-1A.1 (user-private conversations, context
authority) and TEN-EXC-1 (operational isolation).

## 1. What was built

| Piece | File |
|---|---|
| Table `organizationKnowledgeEntries`, with 8 CHECK constraints | `drizzle/0214_organization_knowledge_entries.sql`, `drizzle/schema.ts` |
| Rules (pure): kinds, subjects, sources, term key, lifecycle, two-person rule, correction check | `server/_core/companyKnowledge.ts` |
| Write and read paths: `propose`, `review`, `retire`, `list`, `lookup` | `server/companyKnowledgeRouter.ts`, mounted as `companyKnowledge` |
| Permissions: `company_knowledge.read`, `.propose`, `.review` (sensitive, audited before the decision) | `server/_core/recordsAuthorization.ts` |

**Not built, on purpose:**
- Nothing reads an entry into a model context.
- There is no automatic approval, threshold or frequency promotion.
- There is no free-form "remember this".
- Nothing is derived from a raw assistant conversation.
- `merchantMemory` is not wired.

## 2. The seven kinds of company knowledge

| Owner's item | `kind` | Allowed subject | Allowed sources |
|---|---|---|---|
| terminology | `terminology` | none, facility, customer | person, company document |
| aliases / shorthand | `alias` | none, facility, customer | person, company document |
| company SOP knowledge | `sop` | none | company document, person |
| facility conventions | `facility_convention` | facility (required) | person, company document |
| customer conventions | `customer_convention` | customer (required) | person, company document |
| approved preferences | `preference` | none, form field | person, company document |
| knowledge gaps | `knowledge_gap` | none, facility, customer | person only |
| verified corrections | `verified_correction` | form field (required) | a verified correction only |

## 3. The guarantees

### Ownership

- `tenantId` is NOT NULL and is stamped from the session's acting scope. There is no GLOBAL row,
  and a missing owner is never global (R-2).
- Every read and write compares `tenantId` strictly. Another organization's entry is "not found".
- Input naming an organization, a state, a reviewer or a proposer is refused (`.strict()`), not
  dropped.
- A person in two organizations gets an error until it is established which one they act for.
- The same word can mean different things in two organizations, and each sees only its own.

### Approval

- Every entry starts as `proposed` and has no effect until it is approved. `lookup` returns approved
  entries only.
- The approver must be a different person (`mayReview`) who holds `company_knowledge.review`. That
  means safety or management, the same holders as `assistant.curate`, but through a separate
  permission.
- The database enforces this as well:
  - `review_shape`: a row is proposed exactly when it has no reviewer.
  - `two_people`: the reviewer is never the proposer.
- Exactly one statement sets a reviewed state, and it is in `review`. A source scan pins this.
  Nothing in the codebase approves an entry automatically. **Frequency is not truth.**

### Provenance (checked, not asserted)

- **Company document:** the organization's own current passage. That means the same tenant,
  `own_document`, and not superseded. A licensed third-party passage, another organization's
  passage, or a superseded one is "not found".
- **Verified correction:** a committed record (`assistantCommitReceipts`) whose proposal's proved
  owner (0210, formerly 0185) is this organization. The record's sealed field manifest must hold the named field
  with status `corrected`, which means a person changed it. A field that was merely confirmed does
  not count, and neither does another form, another organization's record or a legacy proposal.
- **Person's statement:** the proposer is recorded. A statement carries no source reference, so
  nothing can be laundered in through one.
- **A raw assistant conversation is never a source.** This follows the owner ruling: history is
  private to the person who asked. A source scan pins that neither file names `assistantQueries`.
- **Facility subject:** a public directory facility, or one the organization owns. Another
  organization's private facility is "not found".

### Lifecycle

| From | To |
|---|---|
| `proposed` | `approved` or `rejected` |
| `approved` | `superseded` or `retired` |

- Rejected, superseded and retired are final. Nothing returns to `proposed`.
- Approving a new meaning for the same kind, term and subject supersedes the old one in the same
  transaction, and the old row records which entry replaced it.
- Retiring records who did it, when and why. No row is ever deleted.

### Lookup and the GLOBAL fallback

`lookup(term)` returns two lists that are never merged:
- `organization`: this organization's approved entries for the term key.
- `global`: official aliases from the public facility directory only. A private facility's aliases
  are not public naming.

This keeps the AIL-1A.1 ruling that `facilityAliases` is GLOBAL canonical naming and company
terminology is organization-scoped.

### Authority

An entry is data. A later checkpoint may admit entries into a model context only as `record_data`,
which can never instruct (AIL-1A.1 `contextAdmission`). Nothing here lets an entry change policy,
prompts, permissions or the Constitution.

## 4. Tests

| File | Cases | Proves |
|---|---|---|
| `server/companyKnowledge.test.ts` | 12 | term keys; shape refusals mirroring every CHECK; nothing but a correction can claim to be one; the lifecycle allows no move out of a final state; the two-person rule; supersession keys; the manifest check |
| `server/companyKnowledge.db.test.ts` | 12 | no effect before approval; organization-only visibility; the same word meaning different things in A and B; self-approval, the wrong role and another organization's reviewer refused; forged organization, state, reviewer or proposer refused; supersession keeps both rows; retire and reject are final; provenance for documents, corrections and facilities; GLOBAL aliases kept apart; a two-organization caller refused; the database CHECKs |
| `server/aiSafetyBoundary.test.ts` | +3 (the AIL-1B `todo` became guarantees) | non-null owner; one writer, with only `review` deciding; no raw-conversation source |

**Pins moved on purpose:**
- Procedure census: 634 → 639 (+5 `companyKnowledge.*`).
- Tenant-column surface: 20 → 21 tables. `organizationKnowledgeEntries` is among the NOT NULL ones.
- Mounted router paths (`crossLayerIntegrity`): 696 → 701.
- `procedureAuthorization` now reads the new router.

### 4.1 Mutation checks

Each protection was reverted temporarily and the two AIL-1B suites run. Every one failed, and the
code was restored.

| # | Reverted protection | Failures |
|---|---|---|
| K1 | lookup ignores the organization | 3 |
| K2 | lookup returns unapproved entries | 3 |
| K3 | self-review allowed | 2 |
| K4 | review reaches another organization's entry | 1 |
| K5 | another organization's document accepted | 1 |
| K6 | another organization's correction accepted | 1 |
| K7 | an uncorrected field accepted as a correction | 2 |
| K8 | approval does not supersede | 1 |
| K9 | any facility nameable | 1 |
| K10 | a private facility's alias treated as GLOBAL | 1 |
| K11 | forged fields silently dropped | 1 |
| K12 | a final state can be revived | 2 |
| K13 | list ignores the organization | 1 |
| K14 | a superseded company document accepted | 1 |

## 5. Open items for owner decision

> **Ruled 2026-10-01 (B1–B5):** AIL-1B approved at `d942e1d` / `30f6c6b`. The rulings on admission (B1, AIL-1B.1),
> gap signals (B2), `merchantMemory` (B3), proposers (B4, unchanged) and the inbox (B5, TEN-INBOX-1) are recorded in
> `TEN_INBOX_1_INBOX_TENANCY.md` §0.

1. **Admission into model context.** Approved entries are not yet read by any assistant path. That
   is a separate checkpoint. When it happens, entries go in as `record_data`, organization-first,
   with GLOBAL kept separate.
2. **Derived knowledge-gap signals.** A gap is recorded only when a person states one. A future
   organization-level signal, such as a count of unanswered questions by week, could be added
   without copying any question text. That is an owner decision because it is the first aggregate
   over private history.
3. **`merchantMemory`** still has no organization and no caller. It must get one before anything
   wires it.
4. **Who may propose.** Every holder of `assistant.ask` may propose (driver, dispatcher, mechanic,
   shop lead, safety, office, management), and only safety and management may review. Narrowing
   proposers is a one-line change if wanted.
5. Still open from TEN-EXC-1 §6: the inbox's NULL-tenant role-addressed tasks and notifications.

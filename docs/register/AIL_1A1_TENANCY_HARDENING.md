# AIL-1A.1: tenancy and context hardening

**Purpose:** before LeaseOS persists any company intelligence, make four answers deterministic:

- **Who owns this learning?** (AIL-1A)
- **Who owns this conversation?**
- **Can this data enter this user's context?**
- **Is this information data or system authority?**

Baseline: `9254d89` (AIL-1A, approved). Branch `claude/relaxed-carson-qfcopf`. There is no
migration. **AIL-1B was not started. SEC-OUTBOUND-1 remains open.** No model, research, skill or
learning work is in this checkpoint.

## 0. Owner rulings applied (2026-09-24)

| Ruling | Applied as |
|---|---|
| **Aliases** | Confirmed. `facilityAliases` stays GLOBAL, but only for canonical public naming: regulator names, operator names, official aliases, directory identifiers. Company terminology goes to an ORGANIZATION-scoped structure in AIL-1B. No table is added here. A test pins that a public facility's official aliases are visible to every organization. |
| **Assistant query history** | Raw history is **USER-scoped**: a person reads only their own questions. No permission grants cross-user reading. `assistant.curate`'s stated purpose is "what is loaded decides what every later answer can cite", which is knowledge loading, not conversation review, so it was not reused. Privileged review is future work. Company learning will consume derived signals only. |
| **System proof** | The `system` proof and `system_prompt` kind are server-created only. A context resolver (the only path a record, document, learned item, tool result or model result takes into model context) can no longer produce either. |

## 1. Who owns this conversation: `assistantQueries`

**Before.** Rows were stamped with `tenantId` (acting scope) and `askedByUserId` (session), but
`assistantAsk.history` filtered by tenant only. Any `assistant.ask` holder in the organization,
drivers included, could read everyone's raw questions. `addProbeFromAsk` let a curator copy any
colleague's raw question, verbatim, into the organization's retrieval-probe set.

**After.** No migration; both columns already exist.

| Path | Rule |
|---|---|
| `history` | `tenantId = acting AND askedByUserId = session user`. Input is `.strict()`, so a forged `askedByUserId`, `userId`, `tenantId` or `organizationId` is refused (BAD_REQUEST), not dropped. |
| `addProbeFromAsk` | Only the asker's own question can be labelled. Anyone else's is "No such recorded question", the same answer as for one that does not exist. |
| Legacy row (`tenantId` NULL) | Visible to nobody, including its asker. |

**Exact visibility rule:** a raw assistant question is visible only to the user who asked it, while
they act for the organization it was asked in. There is **no privileged cross-user path.**

**Prepared for AIL-1B/1C.** Each row carries its organization and its asker separately. A future
derived signal (a topic count, a knowledge-gap candidate, a correction frequency) can be written
ORGANIZATION-scoped without copying any raw text, and the raw row stays USER-scoped.

## 2. Is this data or system authority? Context admission

**Before.** `admitSource()` accepted whatever `kind` and `proof` a resolver returned. A resolver
returning `kind: "system_prompt"` was assembled with SYSTEM authority and `mayInstruct = true`. A
resolver returning `proof: { kind: "system" }` skipped the organization check entirely. Today's only
resolver (knowledge passages) returned neither, but nothing stopped the next one.

**After.** `admitSource()` refuses (`not_content`) unless:
- the kind is in `RESOLVABLE_KINDS = retrieved_document | record_data | external_message`, none of
  which may instruct; and
- the proof is in `RESOLVABLE_PROOFS = row | parent | legacy_single_tenant`.

The **only production creator** of a `system` proof is `systemPromptBlock()`, and the only creator of
a `user_message` block is `authenticatedUserBlock()`, which takes the organization from the session.
A source scan pins that no other production file constructs a `system` proof. `company_policy` cannot
come from a resolver either: it is configuration, never a loaded record.

## 3. Remaining gaps from AIL-1A §8, classified

Categories: **A** exposes data across organizations; **B** admits data into assistant or model
context; **C** influences learning or research; **D** unrelated.

| Gap | Category | Outcome |
|---|---|---|
| `surfaces.search` unscoped (14 record kinds) | **A** | **Fixed.** |
| `surfaces.timeline` unscoped | **A** | **Fixed.** |
| `surfaces.chain` unscoped | **A** | **Fixed.** |
| Duplicate-document matching across organizations | **A + C** | **Fixed.** |
| `contextAdmission` `system` proof usable by any resolver | **B** | **Fixed** (§2). |
| Raw assistant history visible org-wide | **A + C** | **Fixed** (§1). |
| Exception Centre's *other* sources (defects, roadside, vendor bills, purchase requests, credentials, sync conflicts, devices, calibration, insurance, carrier reviews, inspector requests…) | **A** (operational UI) | **Not fixed; separate checkpoint (TEN-EXC-1) recommended.** It is not AI context, search, learning input or duplicate matching (the four surfaces the owner's invariant names). It has ~17 sources, several with no owner column at all (sync conflicts, carrier reviews, inspector requests, calibration sweeps), and each needs its own ownership decision. The AI-proposal slice was already scoped in AIL-1A. **Owner ruled 2026-09-24: fix it in TEN-EXC-1 before AIL-1B. Done there:** see `TEN_EXC_1_EXCEPTION_CENTRE_TENANCY.md`. |
| `merchantMemory` (no organization) | **C** when wired | Not fixed: it has no production caller, so nothing reads or writes it. **AIL-1B prerequisite:** it must get an organization before it is wired. |
| `agent.requestAction` target ids unchecked | **B**-adjacent | Not fixed: the agent runtime records decisions and executes nothing. Belongs to **AIL-2** (tool/capability binding), where targets get checked. |
| `trips.create`, `manifestCustody.bind` take unchecked ids | **D** (operational write integrity) | Not fixed; separate task. |
| `assistantQuestions` has no tenant | none today | Not fixed: no production caller. It must get one before it is wired. |
| `agentRuns.tenantId` nullable | none today | Trust-governance G4. Strict equality already keeps NULL runs visible to nobody. |
| Commit adapters read `loadId` / `facilityId` / `fleetCardId` / `operatorId` unchecked | latent | No writer exists. The first writer must add them to `proposalAnchorRefusal`. |

### 3.1 Search, timeline and chain: one shared rule

`anchoredScope(db, scope, anchors)` in `server/db.ts`. A row is in scope only when **every** anchor
it carries is the caller's organization's:

| Anchor | Owner check |
|---|---|
| job | `jobs.orgRef` |
| trip | `trips.orgRef` |
| unit | `coreRecordOwnership` |
| load | through its job |
| financial entity | `financialEntities.orgRef` |

A row naming none of them is the historical single tenant's, and never global. Checking every anchor,
not the first one set, means a row naming one organization's job and another's unit is shown to
neither.

- **Search.** All 14 queries carry the condition, so another organization's row is never returned
  rather than filtered afterwards. Units use ownership; jobs, trips and field devices use their own
  `orgRef`; everything else uses its anchors.
- **Timeline.** The anchor unit, job, trip or load must be in scope (otherwise the timeline is empty,
  as for a record that does not exist), and every event row is scoped by its own anchors.
- **Chain.** The anchor load or disposal ticket and every hop (job, trip, billing book, disposal
  ticket, manifest, field ticket, invoice) are read inside the organization. A hop owned elsewhere is
  absent, which is the rule the chain already applied to a hop the caller may not read.

### 3.2 Duplicate-document matching

**Before.** The commit's fingerprint gate matched priors from every organization. Org B's legitimate
receipt could be refused because org A had filed one with the same vendor, date and total. That
confirmed A's document existed and put A's prior metadata into B's decision.

**After.** A prior matches only if its proposal's proved owner (0210) is the committing organization:
`documentFingerprints.proposalId IN (proposals where tenantId = acting)`, inside the commit
transaction. A fingerprint whose proposal is unresolved matches nobody.

- **No migration.** Every fingerprint is written with its `proposalId`.
- **Honest limit.** On a multi-tenant deployment with legacy unresolved proposals, duplicates of those
  legacy documents are no longer caught. That is the fail-closed direction.

### 3.3 Intentionally GLOBAL surfaces

- the public facility directory (`facilities` rows with a `facilityKey`, `facilityAliases`,
  `facilitySourceLicences`, `wasteStreamVocabulary`), for canonical public naming only;
- HOS rule limits and their promotion ledger;
- the knowledge corpus registry (`knowledgeSources` / `Documents`);
- the source licence registry.

None of these is written by tenant learning. AIL-1A's `GLOBAL` scope still has no constructor.

## 4. Tests

| File | Cases | Proves |
|---|---|---|
| `server/tenancyHardening.db.test.ts` | 12 | **Conversation (property 1):** own history only; managers get no cross-user access; forged user/org refused; a curator cannot copy a colleague's question; a NULL-tenant question is visible to nobody. **Organization (property 2):** search finds A's job, unit and load for A and nothing for B or the single tenant; unowned legacy rows stay the single tenant's; a record naming A's job and B's unit is not shown to B; B gets no timeline for A's job, even through B's own trip mis-linked to it; a ticket naming B's unit stays off A's timeline; the chain gives B nothing for A's load or ticket; B's receipt is not refused because A filed the same one, while a second copy inside A still is. **GLOBAL:** a public facility's aliases are visible to both organizations. |
| `server/contextAuthority.test.ts` | 7 | **Authority (property 3):** for eleven named content sources, a resolver cannot produce `system_prompt` (with any proof), the `system` proof on content, a `user_message` or `company_policy`. Admitted content cannot instruct. The resolvable sets are pinned. The `system` proof has exactly one production constructor. |

**Mutation checks.** Each protection was reverted temporarily, and the suite failed every time.

| Protection reverted | Failures |
|---|---|
| history org-wide | 2 |
| search of jobs unscoped | 2 |
| timeline anchor check removed | 1 (after a case was added that the first version missed: B's mis-linked trip) |
| chain load unscoped | 1 |
| duplicate priors unscoped | 1 |
| resolver kind/proof restriction removed | 3 |

## 5. Intentional behaviour changes

1. **Assistant history is the asker's own.** The calibration page now shows a curator only their own
   questions, and a curator can label only their own asks. Five existing tests encoded "safety labels
   a driver's question"; they now label the curator's own question, and a new test pins the refusal.
   **A privileged cross-user review needs its own permission and an owner decision.**
2. `history` refuses unknown input fields.
3. Search, timeline and chain return only the caller's organization's records. Unowned legacy rows
   are visible only to the single tenant.
4. The duplicate gate compares only against the committing organization's own documents.
5. A context resolver can no longer produce system or user authority.
6. One fixture (`surfaces.test.ts`) named `financialEntityId = 1`; it now creates a real entity.

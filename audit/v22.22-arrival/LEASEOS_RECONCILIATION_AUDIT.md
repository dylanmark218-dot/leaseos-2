# LeaseOS / FieldRoute — Reconciliation & Forensic Audit

**Date:** 2026-09-16 (updated 22:00 UTC for v22.22) · **Scope:** every ChatGPT-produced deliverable from Chats 1–5, the two upload archives, the Project Recovery lineage, and the two chats whose source never reached git (Chat 4, Chat 5).
**Result:** one master repository (424 refs), one reconciled integration branch that passes the clean-database CI gate end-to-end (`== PASS ==`, exit 0 — v22.22 at `6720087`: 193/193 files, 3,050 tests), and 45 files recovered byte-faithfully from conversation transcripts.

---

## 1. What was delivered, in one table

| Deliverable | Where | What it is |
|---|---|---|
| `leaseos-master-2026-09-16.bundle` | this package | Every ref from every bundle ChatGPT produced (423) **plus** `integration/reconciled-2026-09-16` — the only branch that passes the gate |
| `leaseos-reconciled-v22.21-src.zip` | this package | Source tree at `515ce64` (868 tracked files; no `node_modules`) |
| `leaseos-recovered-source-chat4-chat5-2026-09-16.zip` | this package | The 45 transcript-recovered files in their *original* chat form, before renumbering — provenance for §5 |
| `LEASEOS_RECONCILIATION_AUDIT.md` | this file | Findings, fixes, gaps |
| `gate-final.log` | this package | The full CI gate output for `515ce64` |

**Lineage of the reconciled branch:**

```
74d99de  main (pre-recovery, archived)
   └─ 18444d4 → 5d3e42b (Project Recovery RC) → d9b3e51 → d6b8a5a → 068b29c → e9b2047  (ChatGPT tip)
                                                                                      └─ 2ccd305  gate: migrations + typecheck actually pass
                                                                                         4531847  recover Chat 4 + Chat 5 tranches (0118–0122)
                                                                                         8795756  tripwires re-baselined honestly
                                                                                         63e03a6  schema parity for 0122
                                                                                         56390c8  LEASEOS_CURRENT_STATE regenerated (v22.21)
                                                                                         fe3e137  four borrowed-name procedures given their own names
                                                                                         515ce64  field tests migrated to the 0110 signature protocol   ← integration/reconciled-2026-09-16
```

`main` was **not** fast-forwarded. It is eight commits behind the Project Recovery RC by the recovery plan's own design; promoting it is a decision for the repo owner, and the gate result in §3 is what that decision should rest on.

---

## 2. Archive integrity (what was verified, not assumed)

- `Chat_gpt_lease_os.zip` (431 MB, 29 nested zips) and the 8-part split `Chat_gpt_lease_os__1_.zip` + `.z01`–`.z07` (~714 MB) both recombined and extracted cleanly.
- After byte-identical de-duplication (≈55 `-N`-suffixed copies collapsed) **73 unique deliverables** remain; **every one passes its published SHA-256**.
- One file named in a manifest is absent from both archives: `LEASEOS_PROJECT_RECOVERY_BUNDLE_VERIFY_2026-09-14.txt`. Nothing depends on it.
- All 10 git bundles pass `git bundle verify` and `git fsck`. Fusing them yields a single clean ancestry chain (all ancestry tests pass) — there are no divergent histories to reconcile at the git level.
- `restricted/chat5-assessor-key` holds `LEASEOS_ASSESSOR_KEY_CONFIDENTIAL.html`. It is in the bundle. **Do not push that ref to a public remote.**

---

## 3. The gate — the finding that reframes everything else

ChatGPT's tip (`e9b2047`) was described in its own checkpoint as "513 TS/TSX source files parsed/transpiled with zero syntax diagnostics." That statement is true and meaningless: it was a *transpile*, not a typecheck, and **the CI gate had never been run on the recovery lineage at all**. Run clean-database on 2026-09-16 it failed at step 2.

| Gate step | `e9b2047` (ChatGPT tip) | `515ce64` (reconciled) |
|---|---|---|
| 0. Reserved slots 0016/0017 | pass | pass |
| 1. Clean database | pass | pass |
| 2. Migrations | **FAIL at 0108** | pass (118 files) |
| 3. Table parity | — | pass |
| 4. Typecheck | **21 errors** | pass |
| 5. Bare `protectedProcedure` | — | 0 |
| 6. Test suite | — (never reached) | **191/191 files, 3,035 passed, 0 failed, 3 skipped** |
| 7. Build / 7b portal / 7c machine gates | — | pass (36 external, 2 integration, counts pinned) |
| 8. Current-state document | — (stale: 113/350) | regenerated (118 / 356 / 526) |

### 3.1 Defects found in the ChatGPT tip, with root causes

| # | Defect | Root cause | Fix (commit) |
|---|---|---|---|
| 1 | `0108_training_academy_hardening.sql` cannot apply | `scripts/apply-migrations.sh` carried the *verification* half of Chat 5's trigger fix (count the trigger) but not the `DELIMITER` half (make a compound `BEGIN…END` body reach the server intact). The gate could never pass step 2. | Chat 5's `^BEGIN$` heuristic ported (`2ccd305`) |
| 2 | `contractorOperationsRouter.ts`: 14 procedures wired as `roleProcedure("contractor.write")` etc. | Procedures wired by **permission** name instead of registered **procedure** name — the exact defect Chat 3 documented as recurring. The file is also a single-line-per-procedure style the project rules forbid. | Own names (`contractorOperations.*`) registered with the same permissions (`2ccd305`) |
| 3 | `integrationRouter.ts`: `ownershipAssign`, `ownershipList`, `loadSenseBindGateway`, `loadSenseCalibrate` wired under `integration.clientRegister` / `integration.inboundList` | Same defect, third occurrence — and `coreRecordOwnershipBoundary.test.ts` **asserted the borrowed name**, pinning the bug | Own names, same permissions; test asserts the real wiring; census 505→509 (`fe3e137`) |
| 4 | `for…of` over `Map`/`Set` in `loadSenseProtocol.ts`, `trainingAcademy.ts`; top-level `await` in `worker.ts` | The project `tsconfig` has no `target`, so these need `downlevelIteration` / ES2022 that it does not set. Chats 1–3 never wrote these forms. | `Array.from(...)`; explicit `async main()` (`2ccd305`) |
| 5 | `integrationRouter.ts:229` passes a DB row where `LinearCalibration` is expected | `rSquared: number \| null` vs `rSquared?: number` | explicit projection (`2ccd305`) |
| 6 | `readinessComposer.ts:251` `overrideAuthority: "safety"` | `"safety"` is not a role in the `DispatchBlocker` contract (`dispatcher \| manager \| administrator`). Chat 5's own bridge used `manager`. | `"manager"` (`2ccd305`) |
| 7 | `fieldDevice.test.ts` (2) and `fieldRuntime.test.ts` (3) fail | **0110 changed the device protocol** to P-256 SPKI keys + fresh `signedAt` + nonce + P1363 signature — and shipped with **zero tests of the new path** while leaving both existing suites on the fingerprint-only protocol | Real P-256 signer in the tests; virtual clock re-anchored to real time (`515ce64`) |
| 8 | `reservedWordColumns` audit: a new column named with a MariaDB reserved word (`offset`) | 0109 LoadSense migration, unreleased | renamed `interceptOffset` (`8795756`) |
| 9 | `tenantIsolation`: untyped database handle in `loadSense` | post-recovery code | typed (`8795756`) |
| 10 | Four census tripwires stale (procedure counts, engine reachability) | additions without re-baselining | re-baselined with the additions named (`8795756`, `fe3e137`) |

Every one of these is a defect the project's own gate would have caught in under ten minutes. **None was caught because the gate was never run.**

### 3.2 Design notes surfaced by the field-test migration (not changed; flagged)

- **0110 verifies the parsed input, not the wire input.** `receivePackage` verifies the signature over `input` *after* Zod applies `captureAuthorizationClaim: .default("unknown")`. The shipped client always sends the field (`syncEngine.ts:163`) so production is unaffected, but any client that omits a defaulted field signs a payload the server will never match. Verify over the bytes the device signed, or drop server-side defaults from signed schemas.
- **Unknown-key refusals are now thrown, not recorded.** Pre-0110 a package signed by a key the device never held landed as a *rejected row* ("refusals are rows", which the router's own doc comment still says). 0110 throws `UNAUTHORIZED` before writing anything. Defensible — an unattributable package cannot be recorded against a device — but it is a design change nobody wrote down until now.
- **Signature freshness is ±10 minutes of server time.** A tablet whose clock has drifted more than that cannot push. Worth an explicit clock-skew UX in the field runtime.

---

## 4. Per-chat coverage — what reached git and what did not

| Chat | Content | State in the reconciled branch |
|---|---|---|
| **1** | B17–B20: workflow engine, AI proposal/Secretary, dispatch concurrency, billing adjustments, worker entrypoint, weigh-station pin | ✅ present |
| **2** | v20.3→v22.19: measurement ladder, records vault, insurance/risk, exception centre, IFTA, fleet shop, capital assets, integration gateway, telematics, workforce, audit packages, spatial, money precision, rate resolution, road graph, communications, offline package | ✅ present (`siteSignoff` lives as `siteCloseout.ts`) |
| **3** | 0090–0106 AI stack (grounding, context admission, offline capability), document assistant, comms/route/document screens, calibration loop, retrieval probes, corpus hash | ✅ present (`modelGateway.ts` is the renamed model router) |
| **4** | AI perimeter → 0093B knowledge/HOS tranche; B28 Phase 3A–3J widget-on-branch | ✅ **knowledge/HOS tranche recovered** (§5) · ❌ **Phase 3A–3J not recovered** (§6) |
| **5** | Academy 0087–0089: readiness bridge, sheet serials, TDG certificate contents, topic coverage, inspector requests, retention chain, printable tickets | ✅ **TDG/inspector/retention tranche recovered** (§5) · ⚠️ `academyReadinessBridge`/`sheetSerial` still unmerged on `fix/chat5-module-paths-and-vitest` (§6) |

**Root cause of the Chat 4 loss** (established last session, confirmed this one): Chats 3 and 4 both branched from the `0088`-era candidate and both numbered their migrations `0089–0093`. ChatGPT's recovery ingested Chat 3's full source and only Chat 4's markdown checkpoints; when it built the unified repo, Chat 3's numbers were already in place and Chat 4's source was never placed in the object store. It survived only in the conversation transcript.

---

## 5. What was recovered from transcripts, and how

Method: each Chat 4 / Chat 5 assistant turn that created or edited a source file was read from the conversation transcript; the file was reconstructed from the `create_file` text and **every later in-turn `safe-edit` correction was applied in order** (the transcript records each edit's exact `OLD`/`NEW` blocks). The staging copies in `leaseos-recovered-source-chat4-chat5-2026-09-16.zip` are the originals with chat-era migration numbers; the branch copies are byte-identical except where noted.

### 5.1 Chat 4 — knowledge and HOS (33 files, turns 69–94)

| Chat 4 checkpoint | Files | Slot on branch |
|---|---|---|
| AI perimeter | `server/_core/knowledge/admission.ts`, `perimeter.ts` + 2 tests | — |
| Source licence gate | `sourceGate.ts` (511 Alberta record verbatim) + test; `leaseos_511_alberta_license_gate.json` filed beside it | — |
| 0089 knowledge tables | `0118_knowledge_source_registry.sql`, schema block, `repository.ts`, DB test | **0118** |
| 0090 provenance bridge | `0119_hos_limit_provenance.sql`, `rulePromotion.ts` + DB test | **0119** |
| 0091 promotion ledger | `0120_hos_rule_limit_history.sql`, `promotionLedger.ts` + 2 DB tests | **0120** |
| 0092 verification console | `evaluationState.ts`, `citationGuard.ts`, `client/src/pages/HosVerificationConsole.tsx` + route, `verificationConsole.test.ts`, Playwright spec (in staging zip) | — |
| Scope guard / P9 | `scopeGuard.ts` + DB test | — |
| 0093 cited path | `hos.limitPromote` in `hosRouter.ts`, registered in `recordsAuthorization.ts`, `limitPromote.db.test.ts` | — |
| 0093A candidate correction | `hosRuleSeeds.ts`: south 780 / s. 12(1) cited; **north 900 / s. 39(1)** with HISTORY and STILL CONTESTED (on-duty) notes; `hos.test.ts` assertion inverted; `federalCandidates.db.test.ts`, `federalCandidateCorrection.test.ts` | — |
| 0093B one door | `hos.limitVerify` closed (refuses, names `limitPromote`); `promoteVerifiedLimit` closed; `oneDoorInvariant.db.test.ts` | — |

Invariants these restore, in ChatGPT's tip they were **absent**: no source is ingested without a stored licence assessment; chunking is gated on *reproduce*, not *search*; a regulatory figure reaches `verified` through exactly one door, which requires a named verifier, a binding instrument, a citation on a registered publisher's domain, a schedule scoped no wider than the reading, a plausible figure and three separate attestations; every promotion is an immutable ledger row; **P9 holds — no real HOS figure is verified anywhere in the tree**.

The only deliberate deviation from the transcript: `tdgTopicCoverage.ts` uses `Array.from(...)` instead of spread over a `Set` (tsconfig, see §3.1 #4).

### 5.2 Chat 5 — TDG evidence chain (12 files, turns 17, 47, 51, 59, 61)

| Module | What it enforces | Slot on branch |
|---|---|---|
| `tdgCertificateContents.ts` + test (25) | s.6.2 (a)–(m) topic list verbatim from the 2026-06-21 consolidation; s.6.3(1) content gate; aspects **derived** from course coverage, never free text; 6.2(l)/(m) mode-conditional (the bug Chat 5's own tests found) | pure module |
| `tdgTopicCoverage.ts` + test (24) | closed vocabulary; declaration must reconcile with the union of module coverage in both directions; approval binds to an order-independent fingerprint; seven distinct refusal codes | pure module |
| `inspectorRequest.ts` + test (20) | s.6.7 15-day clock from the later of dated/received; a partial package never reports complete; `irrecoverable` for material lost before the guards | pure module |
| retention chain guards (Chat 5 PENDING-5) | five `BEFORE DELETE` guards so a certificate cannot outlive its course version, modules, content blocks, assessment or statement of experience | **0121** |
| inspector requests table (Chat 5 PENDING-6) | `academyInspectorRequests` with `dueAt > requestDatedAt` enforced | **0122** |

These three modules are **declared unwired** in `engineReachability.test.ts` with reasons: the issuance and inspector-request procedures that consume them are the next Academy checkpoint. Chat 5's PENDING-2/3 (assessment sheet registry + integrity triggers) and PENDING-4 (`tdgTopicCoverageHash` / `tdgTopicReviewedHash` columns) are in the staging zip and **not** on the branch — they depend on the still-unmerged `sheetSerial` work.

---

## 6. Remaining gaps (in priority order)

1. **B28 Phase 3A–3J** (Chat 4 turns ≈40–68): the widget engine's integration onto the real branch — `boardSemantics`, `widgetService`, `widgetRegistry`, the `/widgets` route, the three widget integration tests, accessibility spec, licence-gate script, template adoption. The branchless engine source is preserved on `candidate/b28h-widget-engine` (`bc91356`); only the integration layer must be mined from the transcript the same way §5 was. Next free slots: **0123+**.
2. **Chat 5 `academyReadinessBridge` / `sheetSerial` / `sheetSerialAllocator`** on `fix/chat5-module-paths-and-vitest` (`54965ee`): import path fix, numbered-copy filenames, and the PENDING-2/3/4 SQL to port. Then wire the three §5.2 modules into `trainingAcademyRouter` and remove them from `DECLARED_UNWIRED`.
3. **`limitPromote` separation of duties**: `profileVerify` requires a second person; `limitPromote` does not (needs `recordedByUserId` on `hosRuleLimits` — its own migration). Named by Chat 4's 0093B; still open.
4. **`CA_FEDERAL_NORTH60.daily_on_duty_minutes`** still carries the southern 840 — marked STILL CONTESTED in the seed. A verifier with s. 39 open decides it.
5. **Native field runtime** (Capacitor/SQLite/keystore/camera/GPS/biometric), **provincial routing runtime**, **multi-company tenant isolation**, **LoadSense hardware ingestion**, **LICENSE file** — unchanged from the 2026-09-14 gap matrix; none was in scope here.
6. The three §3.2 design notes.

---

## 7. How to use the package

```bash
git clone leaseos-master-2026-09-16.bundle leaseos && cd leaseos
git checkout integration/reconciled-2026-09-16
pnpm install --frozen-lockfile
export DATABASE_URL="mysql://leaseos:leaseos@127.0.0.1:3306/leaseos_ci"
bash scripts/ci-gate.sh          # clean database, 8 steps, exit 0 expected
```

Verified on: MariaDB 10.11.14, Node 22, pnpm 10.4.1. The gate drops and recreates the database it points at.

---

## 8. What this audit does **not** claim

- It does not claim the recovered code is *correct* beyond what its own tests assert; it claims the code is what Chat 4 and Chat 5 actually wrote, plus their own corrections, plus the three fixes in §3 needed to compile under this tree's `tsconfig`.
- It does not claim any regulatory figure is verified. Every HOS value in the tree is an unverified candidate or a fixture, and the tests say so.
- It does not claim ChatGPT's post-recovery features (LoadSense gateway, contractor payables, security runtime) are *complete*; it claims they now typecheck, migrate and pass their tests, and that four of their procedures were wired under other procedures' names until today.

---

## 9. Package checksums (SHA-256)

```
b1577ddfcfca1758099936c370d9cc1627dd141a3d7cad395d00423b0a9f6a23  leaseos-master-2026-09-16.bundle
3347dd71e86c77e7ae41d4b1c0beafd4ed6957dfe9afd363628adee7b9bed05f  leaseos-reconciled-v22.21-src.zip
316903d64cd86cecb2c15094f1fbfc494038b1033894319d8f3a2f10ad2223fa  leaseos-recovered-source-chat4-chat5-2026-09-16.zip
10ef97b96ad531906f0463324cf5dca925660ebdcb3865d36e7f432f990a9445  gate-final.log
```

Bundle: 424 refs, `git bundle verify` clean, round-trip clone of `integration/reconciled-2026-09-16` yields 868 tracked files at `515ce64`.

---

## 10. Addendum — v22.22 (same day, commits `6720087`, `d6a3433`)

Executed from the portfolio audit's P0 list, same protocol, gate green after each:

| Item | Result |
|---|---|
| Chat 5 Academy modules wired | **0123** `academy_tdg_topic_coverage`: coverage authored per module, approved by a second person, bound to a fingerprint. `certificateIssue` now **derives** the s.6.3(1)(d) aspects from approved coverage and **refuses typed aspects** — the client-text path to a certificate face is closed. Inspector requests (0122) served: create / assemble / list. 10 router tests. |
| HOS separation of duties | **0124** `hos_limit_recorded_by`: `limitPromote` refuses the person who recorded an unverified candidate, mirroring `profileVerify`. 5 tests. |
| Field-signature design issues (§3.2) | signed schemas carry no server-side defaults; signature and freshness refusals are rows again; the freshness refusal reports server time and skew. |
| B28 widget engine | **staged, not applied**: `docs/b28/B28_RECONCILIATION_MATRIX.md` resolves all twelve sources against the real branch (7 map as-is, 3 need new reads, 1 mounts over the readiness composer, 1 is device-local); the engine's SQL renumbered to 0125/0126 in `archive/` until the checkpoint applies it. Applying it is twelve judgement calls the engine's own recipe forbids scripting. |
| Remaining Build Register | `docs/REMAINING_BUILD_REGISTER.md` — every open item as a checkpoint with a definition of done, P0–P6; P6 is the list no code can finish. |

Current state after the addendum: **356 tables, 120 migrations, 532 role procedures, 0 bare `protectedProcedure`, 193 test files / 3,050 tests, gate exit 0.**

### 10.1 Second addendum — `1505e7f` (22:23 UTC)

| Item | Result |
|---|---|
| P0.6 Academy sheet serials | `sheetSerial` + `sheetSerialAllocator` ported from `fix/chat5-module-paths-and-vitest` (31 pure tests, BigInt literals → `BigInt()`); **0125** registry tables + **0126** transcribe-once trigger (split, because the runner wraps any file with a compound body in DELIMITER as a whole). **Deadlock found**: `INSERT IGNORE` inside the transaction took a shared lock the `UPDATE` had to upgrade; six concurrent print runs hit `ER_LOCK_DEADLOCK`. Seed moved out of the transaction; 150 serials across 6 concurrent runs, distinct, checksum-valid, contiguous. `academyReadinessBridge` **not** ported — `readinessComposer` already composes `trainingDispatchDecision`. |
| P0.5 B28 | Phase 3 applied on **`integration/b28-widgets-wip`** (`8bb9e15`): engine in, context adapted, procedures registered, 0127/0128 live, iteration fixes. **Does not typecheck** — six errors, one cause: five widget sources have no procedure on the branch (`records.documentExpiry`, `shop.unitReadiness`→`readiness.unit`, `jobs.active`, `trips.active`, `sync.status`→device-local). `B28_WIP_STATUS.md` names each. Not merged; the green line is untouched. |

State: **359 tables, 122 migrations, 532 role procedures, 196 test files / 3,083 tests, gate exit 0.**


What "make the full repo complete and functional" honestly means here: the *code* baseline is complete and green; the *product* is not — a native device, licensed provincial data, and five human verifications (P6) stand between this tree and a field release, and none of them is something a build session can produce.

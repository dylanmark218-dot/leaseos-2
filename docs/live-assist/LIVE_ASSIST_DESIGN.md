# AI Secretary Live Assist — multimodal visual assistance: architecture and design

**Status: design only, draft for owner approval.** No production code, no migrations, no dependencies,
no seeds, no tests are added by this document. Nothing here is built unless a row says **EXISTS**, which
means verified in the tree at the commit below rather than believed.

| | |
|---|---|
| Surveyed at | branch `claude/live-assist-architecture-qg4jgp` = `main` = `6f52b57` (release `v23.25`) |
| Migration head | `0174_dispatch_override_provenance.sql` on `main`. Open branches claim `0168`–`0184`, several twice; the first number no branch claimed on 2026-09-24 was `0185` (§23.3) |
| Open branches reconciled | 16 branches overlapping Live Assist, read on 2026-09-24; §23 records what each changes. Where a row below says MISSING, it means missing on `main`; §23 says where an open branch supplies it |
| Owner source reconciled | `docs/knowledge/source/LeaseOS_Live_Assist_Unified_AI_Build_Plan_v2_0.txt` (19 Sep 2026; v1.0 beside it), indexed **PARTIAL** at `docs/knowledge/INDEX.md:26` |
| Binding constraints read | `docs/register/SPINE_WIRING_PLAN.md`, `docs/register/AI_RUNTIME_TERMINOLOGY.md`, `docs/REMAINING_BUILD_REGISTER.md` §P1, §P9, `docs/register/SCOPE_RECONCILIATION_2026-09-21.md`, `LEASEOS_MASTER_PROGRAMMING_MANIFEST_V8.md` §1, §28 |
| Companion | `docs/live-assist/LIVE_ASSIST_LA1_IMPLEMENTATION_PLAN.md` (checkpoint LA-1, §22) |

### Status vocabulary used below

The terms follow `docs/register/AI_RUNTIME_TERMINOLOGY.md` §0 so there is one vocabulary.

| Mark | Meaning |
|---|---|
| **EXISTS (live)** | Reached from a mounted router and exercised in production paths. |
| **EXISTS (unwired)** | Code and tests exist; no production caller. |
| **PARTIAL** | Some of it exists and is reached; a named piece is missing. |
| **MISSING** | Not in the tree. |
| **PROPOSED** | Introduced by this design; not built. |
| **OWNER** | A decision this design cannot make; §20 lists each with a recommended default. |

### Naming

The repository name is canonical where an industry term disagrees
(`docs/register/AI_RUNTIME_TERMINOLOGY.md:9`). This design therefore does **not** use "orchestrator",
"assistant brain" or "memory", all of which appear in the owner plan (§3.3 maps them).

The user-facing name is **Live Assist**. The request's "Multimodal Assistance Session" is called a
**Live Assist session** here, which is the owner plan's own table name (`liveAssistSessions`, plan §8.1).

---

## 0. Binding constraints the request did not mention

These come before any architecture because each one changes what may be built, or when.

1. **The SPINE moratorium.** `docs/register/SPINE_WIRING_PLAN.md:3-4` says: "The moratorium stands: no new
   engines until this path is wired." Live Assist is a new engine and new AI wiring.
   `docs/register/AI_RUNTIME_TERMINOLOGY.md:320` says: "Do not implement the production path while the
   moratorium prohibits AI wiring." `server/spineWiringPlan.test.ts` guards the plan's text.
   **Implementation cannot start without an owner ruling that either lifts the moratorium or carves Live
   Assist out of it** (decision D-01). This document is permitted, because it is documentation.
2. **Security work that is ordered ahead of new AI features.**
   - `docs/register/SCOPE_RECONCILIATION_2026-09-21.md:235-236`: "Storage authorization, production secret
     validation and the tenancy contradiction stay ahead of all nine."
   - `docs/REMAINING_BUILD_REGISTER.md` P9.1 (high priority, security): `server/_core/llm.ts:220-223` falls
     back to the hard-coded host `https://forge.manus.im` when `BUILT_IN_FORGE_API_URL` is unset, and only
     checks that a key is present. Sending camera and screen images through that path before P9.1 is
     closed would send the most sensitive data LeaseOS handles through its least-hardened seam.
     **P9.1 is a hard precondition for any Live Assist inference** (§22).
   - Two open branches restate and widen this ordering (§23.2). The hardening audit on
     `claude/leaseos-code-audit-yvggvw` declares a "Wave 0" in which there is "No major new feature work. Only
     security, correctness, deployment and release blockers" (`audit/hardening-2026-09-24/BACKLOG.md:2215-2217`)
     and names P9.1 as AI-001 and P9.6 as AI-006. The security program on
     `claude/leaseos-security-architecture-f2j1vn` orders SEC-1 (tenant and resource authorization) before
     SEC-12 (AI hardening: timeouts, allow-listed hosts, an LLM-only credential). Neither is merged; both are
     read as the direction the owner is being asked to approve.
3. **Organization-wide isolation is not yet a property of the system.**
   `LEASEOS_CURRENT_STATE.md:1001` says so, and `server/tenantIsolation.test.ts:133-143` asserts that the
   sentence stays until it is fixed. `evidenceRecords` (`drizzle/schema.ts:48`) has no organization
   column; it inherits scope through `jobId` or its capturer (`server/db.ts:858-867`). Live Assist must not
   widen this gap (§8, §5 S-3).
4. **A conversation store is declared intentionally unsupported.**
   `docs/register/AI_RUNTIME_TERMINOLOGY.md:685` lists: "Any 'AI memory', conversation store or reasoning
   store — intentionally unsupported." The request asks the session to hold "voice/chat context". §6.3
   resolves this as session-scoped **Conversation State** with a hard expiry, which the register does allow
   ("persisted interaction state, where appropriate", line 331). It is not a store, is never retrieved
   across sessions and is never used for retrieval or evaluation. **OWNER** (D-05).
5. **No hidden reasoning may be persisted.** `docs/REMAINING_BUILD_REGISTER.md` P9.9: "No table, column or
   type for chain-of-thought, thoughts, scratchpads or reasoning transcripts is added." Live Assist stores
   observations, which are observable outputs, and never model deliberation.
6. **An owner plan for this feature already exists.** Section 3 reconciles against it rather than starting
   over. The request and the plan agree on almost every principle. They differ on platform (web versus
   Android), on input modes (the plan has no live camera, Freeze/Inspect or video clip), and on naming.

---

## 1. What already exists (verified at `6f52b57`)

### 1.1 AI runtime

| Concept | Where | State |
|---|---|---|
| Model call | `invokeLLM()` at `server/_core/llm.ts:345`, OpenAI chat-completions shape, 4 retries, no timeout | **EXISTS (live)**, one caller: `server/routers.ts:690` (`assistant.draft`), text only |
| Image and video input types | `ImageContent {type:"image_url", image_url:{url, detail}}` (`llm.ts:10-16`), `FileContent` including `video/mp4` (`llm.ts:18-29`) | **EXISTS (unwired)**. The type admits images; nothing sends one. |
| Provider | Forge gateway only (`server/_core/env.ts:8-9`); no vendor SDK in `package.json` | **EXISTS (live)**, P9.1 open |
| Model routing by task | `server/_core/modelGateway.ts` (`ModelTask`, `route()`, licence gate). There is no `vision` task (`:26-34`). | **EXISTS (unwired)** |
| Speech to text | `transcribeAudio({audioUrl, language?, prompt?})` at `server/_core/voiceTranscription.ts:78`, Whisper through Forge, 16 MB cap | **EXISTS (unwired)** |
| Text to speech | only the `"speak"` enum value in `modelGateway.ts` | **MISSING** |
| Typed proposals | `server/_core/aiProposal.ts`: five forms (`unload_stop`, `defect_report`, `expense_receipt`, `disposal_ticket`, `fuel_receipt`), gaps, at most 3 questions, read-back, `detectOverreach` | **EXISTS (live)** via `fieldRoute.assistant.*` (`routers.ts:656-863`); no client page calls it |
| Field source `photo_ocr` | `FieldSource` (`aiProposal.ts:23-29`), `proposalFields.source` (`drizzle/schema.ts:2245`) | **EXISTS**; no production path writes it |
| Proposal to record | `executeAssistantCommit()` (`server/_core/assistantCommitService.ts:115`): row lock, read-back check, typed intent with its own permission, re-authorization, fingerprint duplicate gate, one receipt | **EXISTS (live)** |
| Action gateway | `decide()` (`server/_core/actionGateway.ts:150-221`); `RiskLevel` = `read` / `prepare` / `low_risk_action` / `approval_required` / `restricted` (`:35-40`); `NEVER_AUTONOMOUS` (`:60-67`) | **EXISTS (live)** via `agent.requestAction`; nothing executes (`server/agentRouter.ts:16-19`) |
| Offline class per capability | `OfflineClass` = `local_safe` / `local_capture` / `local_prepare` / `server_authoritative`, bound to the gateway's risk levels (`server/_core/offlineCapability.ts:1-40`) | **EXISTS (unwired)** |
| Context admission | `admitSource()` (`server/_core/contextAdmission.ts:117-190`): tenant ownership plus permission, then a branded `AdmittedContextBlock` | **EXISTS (live)** for document Q&A only |
| Prompt-injection spans | `instructionLikeSpans()` (`server/_core/contextAssembly.ts:83-103`) | **EXISTS (unwired)** |
| Overreach and safety wording | `detectOverreach` (`aiProposal.ts:686-700`); system-prompt ban on "safe, unsafe, legal, compliant" (`server/_core/assistantExtraction.ts:130-132`); dangerous-goods and securement disclaimers (`server/_core/complianceSecretary.ts:215, 384, 481`) | **EXISTS (live)** |
| Conversation or session table for AI | none; `assistant.draft` is single-turn (`routers.ts:691-697`); `AIChatBox` keeps messages in React state only | **MISSING** |
| Token, cost or budget metering | `InvokeResult.usage` is typed and never read; `agentRuns.maxSteps`/`stepsUsed` exist and nothing reads them (P9.5, P9.6) | **MISSING** |

### 1.2 Client, device and transport

| Concept | Where | State |
|---|---|---|
| Client platform | React 19 + Vite web app; tRPC `httpBatchLink` only (`client/src/main.tsx:42-76`) | **EXISTS** |
| Native shell | No `@capacitor/*` dependency, no `android/` or `ios/`, no `capacitor.config` | **MISSING** (register P1.1) |
| Native adapters | `client/src/runtime/adapters/capacitor.ts`: three `open()` methods that throw `NotOnDeviceError`; `camera` is listed as native-only (`:53`) | **PARTIAL** (stubs) |
| PWA / service worker | none | **MISSING** |
| Camera, screen, recorder APIs | no `getUserMedia`, `getDisplayMedia`, `MediaRecorder`, `<video>`, `<canvas>` or image resizing anywhere in `client/src` | **MISSING** |
| Chat UI shell | `client/src/components/AIChatBox.tsx`, with `onVoice`, `onCamera` and `onAttach` props wired to buttons (`:46-48`) | **EXISTS**, used only by the showcase with simulated replies |
| Quick capture | `QuickCapture` offers Photo, Defect, Incident and Voice for the field portals (`client/src/portal/viewModels.ts:136-157`); without a runtime it links to a static `/evidence` page | **PARTIAL** |
| Offline capture library | `client/src/runtime/outbox.ts`, `syncEngine.ts`, `contracts.ts` (`CaptureKind` includes `photo` and `voice_note`); photos sync at the lowest priority (40) | **EXISTS (unwired)**. `mountBrowserFallbackRuntime` has no caller, storage is in memory only, there is no client `Transport`, and only `files[0]` of a capture is uploaded (`syncEngine.ts:139-141`) |
| Realtime transport | no WebSocket, SSE, tRPC subscription or WebRTC; `http.createServer` with no `upgrade` handler (`server/_core/index.ts:45-77`) | **MISSING** |
| Upload | base64 inside tRPC JSON; `fieldRoute.evidence.upload` caps decoded size at 15 MB (`routers.ts:403-455`); Express body limit 50 MB (`index.ts:49-50`) | **EXISTS (live)** |
| Device enrolment and signed sync | `server/deviceRouter.ts` (`device.enroll/activate/rotateKey/revoke`, `sync.receivePackage` with nonce replay protection) | **EXISTS (live)**; the device half is unbuilt |

### 1.3 Evidence, authorization and audit

| Concept | Where | State |
|---|---|---|
| Evidence object | `evidenceRecords` (`drizzle/schema.ts:48`): `storageKey`, `clientCaptureRef` unique, `sealState`, `legalHold`; no organization column, no content hash | **EXISTS (live)** |
| Versions, seals, links | `evidenceVersions` (:2756), `evidenceSeals` (:2772, SHA-256 manifest), `evidenceRelationships` (:2737, 24 entity types including job, trip, workOrder, incident, inspection, disposalTicket) | **EXISTS (live)** through `records.evidence.*` (`server/recordsRouter.ts:95-204`) |
| Retention and legal hold | `retentionPolicies`, `recordRetentionState`, `legalHolds`; `server/_core/retentionPolicy.ts` (longest of company, contract and verified statute; eligibility only, never deletes) | **EXISTS** |
| Viewing evidence bytes | no procedure mints a signed URL for an `evidenceRecords` object; only `auditRouter` and `telematicsRouter` call `storageGetSignedUrl` | **MISSING** |
| Purpose-logged media access | `telematics.videoView` requires a stated purpose and writes `videoAccessLog` before returning a short-lived URL (`server/telematicsRouter.ts:75-84`) | **EXISTS (live)**; the precedent Live Assist follows |
| Authorization | `roleProcedure(procedureName)` (`server/_core/trpc.ts:71`) writes `authorizationDecisions` for every decision; `SENSITIVE_PERMISSIONS` fail closed when that row cannot be written (`:111-117`); procedure to permission maps in `server/_core/recordsAuthorization.ts` | **EXISTS (live)** |
| Acting organization | `resolveActingScope(db, userId)` (`server/_core/actingScope.ts:65-103`), from membership, never from request input | **EXISTS (live)** |
| Audit | per subsystem only: `authorizationDecisions`, `evidenceAccessEvents`, `videoAccessLog`, `restrictedAccessEvents`, `agentActions`; only `academyAuditEvents` is hash-chained | **PARTIAL**; there is no general ledger or `writeAudit` helper |
| Logging | plain `console.*`, no logger, no redaction, no test against sensitive logs | **MISSING** |
| OCR engine | `documentExtraction.ts` takes OCR output from something else; nothing produces it; `documentExtractions` is written only by a test | **MISSING** (the engine); **EXISTS (unwired)** (the downstream code) |
| Driver portfolio / equipment portfolio | not named concepts. The closest are the compliance passport, `academy.ticketPortfolio`, the per-unit safety binder (`server/_core/safetyBinder.ts`) and `asset.twin` (a cost view) | **MISSING** as named |

---

## 2. Contradictions between the request and the repository

| # | The request says or assumes | The repository says | Resolution in this design |
|---|---|---|---|
| C-1 | Build a major new subsystem. | No new engines until the spine is wired (`docs/register/SPINE_WIRING_PLAN.md:3-4`). | Design now; build only after D-01. |
| C-2 | Four modes including screen sharing, on "the device". | The owner plan targets Android `MediaProjection` (plan §6). The repository is a web app with no native shell (P1.1 unbuilt). Mobile browsers do not offer `getDisplayMedia` as of this writing. | Screen share is **desktop web first**, Android native later (§17). Phone screen sharing waits for P1.1. |
| C-3 | "Existing camera/scanner work". | There is none on the client. The only file input is on a showcase page whose writes are refused (`client/src/showcase/Home.tsx:1808-1818`, `client/src/lib/showcaseGuard.ts`). | The first slice builds the first real capture UI. Open scanner branches add device scanner contracts and a quality verdict, but still no camera acquisition or UI (§23.1). |
| C-4 | "Existing realtime/voice functionality". | No realtime transport of any kind. `transcribeAudio` exists with no caller. | Recommended approach needs no realtime transport (§4). |
| C-5 | "Existing AI/vision provider" behind an adapter. | One text-only caller on a gateway with an open security item (P9.1); `modelGateway` has no vision task and is unwired. | Propose a `VisionAdapter` seam and a `vision` task; vendor is **OWNER** (D-03). |
| C-6 | The session holds voice/chat context. | Conversation store is intentionally unsupported (terminology §20). | Session-scoped Conversation State with hard expiry (§6.3, D-05). |
| C-7 | "Existing offline/sync" will queue snapshots. | The outbox is real code with in-memory storage and no caller; durable encrypted storage needs the native shell (P1.1, HS1). | Web: no offline evidence queue; say so to the user. Native: reuse the outbox (§9.3). |
| C-8 | "Existing audit ledger". | No general ledger; per-subsystem tables. | A Live Assist lifecycle table, pointer-only, plus the existing per-subsystem rows (§12). |
| C-9 | "Existing document scanner / paperwork engine". | Typed forms and the commit path exist; OCR does not; `documentExtractions` has no production writer. | The vision model's reading of a document becomes a `photo_ocr` proposal through the existing forms (§10). No OCR engine is chosen here. |
| C-10 | Hand off to "Driver Portfolio" and "Fleet/Equipment Portfolio". | Neither exists on `main`. The Driver Portfolio exists on open branches (`claude/driver-portfolio-credential-wallet-ya8928`, PR #16, and the API branch stacked on it); the Fleet & Equipment Portfolio is a design on `claude/fleet-equipment-portfolio-design-3d13d5`. | Hand off to `driverPortfolio.submitCredential` once merged; to unit, trailer and equipment evidence links and the `defect_report` form today (§10, §23.1). |
| C-11 | Risk ladder L0–L5 (owner plan §3). | The gateway has five named levels and a separate `NEVER_AUTONOMOUS` floor. | The gateway's names are canonical; §8.3 maps the plan's ladder onto them. |
| C-12 | Evidence has tenant ownership. | `evidenceRecords` has no organization column. | A save must link to a scoped entity, or it is refused (§7.3). The column itself is not added here. |
| C-13 | "Protection from another tenant accessing frames". | Organization-wide isolation is not a system property (§0.3). | Every new table carries `orgRef` NOT NULL; every read is filtered and tested (§14). |

---

## 3. Reconciliation with the owner's Live Assist plan v2.0

### 3.1 Where the plan and the request agree (kept as-is)

- One assistant that routes to capabilities internally; Live Assist is its visual layer, not a separate chatbot (plan §1).
- AI observes, explains, extracts, recommends and prepares; business writes pass only through typed actions and confirmation (plan §1, §3).
- Read-only visual assistance before any cross-app action; no unrestricted model tap loop (plan §6.1, §6.4, P6 before P7).
- Capture is explicit, visibly active and instantly revocable; raw frames are transient by default (plan §3, §11.2, §17.11).
- Frame change detection before any cloud call; no continuous video streaming to the cloud (plan §6.1, §6.3).
- Unknown and stale stay UNKNOWN; screen and document text is untrusted input (plan §3, §11.1).
- Evidence contracts separate the artifact from the claims made about it (plan §17.2).

### 3.2 What the request adds that the plan does not have

| Addition | Where it goes |
|---|---|
| Live camera assistance (the plan covers screen capture and document photos only) | §4, §6, §13 |
| Freeze / Inspect | §6.4, §13.3 |
| Video clip analysis | §13.5; last phase |
| Web delivery (desktop screen share, mobile-browser camera) | §17 |
| AI-requested follow-up views as a structured contract | §11.2 |
| Four named degradation levels with defined behavior at each | §9 |

### 3.3 Naming map from plan terms to repository terms

| Plan term | Repository term | Note |
|---|---|---|
| Orchestrator, Assistant Brain | agent runtime (`server/agentRouter.ts` + `server/_core/actionGateway.ts`) | "do not add the word" (terminology :610) |
| Authority Gateway | action gateway, `decide()` | EXISTS |
| Action Registry, `ActionDefinition` | `CapabilityDefinition` (gateway) and the typed commit intents in `assistantCommitAdapters.ts` | P9.8 records that these two key spaces are not yet joined |
| Layered memory | none; session Conversation State (§6.3) plus the existing domain records | "do not introduce 'memory'" (terminology :616) |
| L0–L5 | `read` … `restricted` plus `NEVER_AUTONOMOUS` | §8.3 |
| `assistantAuditEvents` | the proposed `liveAssistEvents` (§12), linked to `authorizationDecisions`, `agentActions` and `assistantCommitReceipts` | no parallel receipt model |
| `EvidenceArtifact` | `evidenceRecords` + `evidenceVersions` + `evidenceSeals` | "an evidence object has one identity, not two" (`drizzle/schema.ts:64-65`) |
| `EvidenceClaim` | `proposalFields` (per-field source, confidence, precision, status, correction) | EXISTS |
| Model Router | `modelGateway.route()` | EXISTS (unwired); needs a `vision` task |
| `screenObservations` | the proposed `liveAssistObservations` (§15), which covers all four sources | one table, not one per source |

---

## 4. Architectural approaches

The transport decision drives everything else, because the repository has no realtime channel and field
connectivity is poor. Three approaches were considered.

### Approach A — device-side sampling, request/response over the existing tRPC channel (recommended)

The device holds the camera or screen stream. A client-side **frame sampler** chooses the few frames worth
sending: on stability after a change, on Freeze, on an AI request for a new view, or when the user
finishes a spoken or typed turn. Each chosen frame is downscaled, compressed and posted with the user's
turn as one tRPC mutation. The server authorizes the call, adds admitted LeaseOS context, calls the vision
adapter, stores the observations, and returns the answer.

- **For:**
  - No new transport, server upgrade handler, TURN/SFU, or vendor realtime lock-in.
  - Bandwidth is spent only on chosen frames. It degrades naturally to snapshot-only, because snapshot-only is the same call made less often.
  - Every frame passes through `roleProcedure`, which writes `authorizationDecisions`, and through the session checks.
  - The server never receives the video stream, which removes the largest retention risk.
  - Fits `offlineCapability`'s rule: "The device is the source of truth for what it observed. It is not the source of authority for what that observation permits."
- **Against:**
  - Latency is a request round trip plus inference; expect seconds, not sub-second.
  - Voice is turn-based (push-to-talk), not full duplex.
  - base64 inflates each frame by about a third. That is acceptable at the proposed frame sizes (§13.2).

### Approach B — realtime media stream to the server or a vendor realtime API

WebRTC or a WebSocket carries continuous audio and video; the server or vendor samples frames.

- **For:** natural full-duplex conversation; lowest perceived latency on good networks.
- **Against:**
  - Needs a new transport, an `upgrade` handler, TURN/SFU infrastructure, and very likely one vendor's realtime API.
  - It streams everything before choosing anything, which inverts the privacy and cost goals.
  - It is fragile exactly where LeaseOS operates.
  - The server would hold raw continuous media, which is the retention risk the request asks to avoid.
  - The request says not to introduce WebRTC "merely because this prompt mentions realtime media".

### Approach C — A for vision, plus a streaming channel for audio and reply text only

Approach A, plus a later WebSocket or SSE channel that streams push-to-talk audio up and reply tokens down.

- **For:** better conversational feel without streaming video.
- **Against:** still needs a new transport and upgrade handler; its value appears only once A is proven.

### Recommendation

**Build Approach A, behind a transport interface that lets Approach C be added later without changing the
session, sampler, adapter or evidence contracts.** Do not plan for Approach B. Revisit C after the field
pilot measures whether turn latency is actually the complaint.

---

## 5. Security and privacy issues found

| # | Issue | Why it matters here | Design response |
|---|---|---|---|
| S-1 | LLM provider is not fail-closed (P9.1). | Images of licences, paperwork and screens would leave through a hard-coded host. | P9.1 closed before any Live Assist inference. The vision adapter refuses to run unconfigured (§16.1). |
| S-2 | Vendor data retention is unknown. | A vendor may keep or train on frames. | Vendor choice requires a written zero-retention / no-training term (D-03). The adapter records which route and policy served each call. |
| S-3 | Organization isolation is incomplete (§0.3). | Frames and observations are among the most sensitive rows LeaseOS would hold. | `orgRef NOT NULL` on every new table, re-resolved from `resolveActingScope` on every call, never from input; not-found across boundaries; db tests per procedure. |
| S-4 | No log redaction exists. | A careless `console.log(input)` on a frame mutation writes a base64 image to logs. | Frame procedures never log input. A test asserts the Live Assist routers contain no `console.*` call that takes the input object. Observation text is length-capped and pattern-redacted before storage (§7.4). |
| S-5 | Screen sharing shows everything, including other apps and credentials. | The user may share a password manager, banking or personal messages. | Desktop default is **tab or window**, not the entire screen. A mandatory region-crop tool. Pre-send preview in CONSTRAINED mode. Masking is manual until on-device OCR exists (§7.4). |
| S-6 | Prompt injection through pixels. | A screen, PDF or placard can contain "ignore previous instructions". | Visual text is data, never instructions. Observations render as data blocks. `instructionLikeSpans()` runs on extracted text. The model cannot request capabilities outside the session allowlist, and the gateway validates every argument (plan §11.1). |
| S-7 | Stale or hijacked session reuse. | A leaked `sessionRef`, or a session continuing after logout. | `sessionRef` is random and bound to user, organization and (when enrolled) device. Every call re-checks owner, state, expiry and a strictly increasing frame sequence. Idle expiry. The client tears down on any auth error (§6.2). |
| S-8 | Background or silent capture. | The request forbids it. | Capture starts only from a user gesture. Tracks stop on `visibilitychange` to hidden, page unload, auth loss, session end or track end. There is no server-initiated start. |
| S-9 | The client-supplied content hash is trusted at seal time. | `records.evidence.seal` takes `contentHash` from the client (`recordsRouter.ts:99`). | A save from Live Assist recomputes SHA-256 on the server from the uploaded bytes and compares it with the frame hash recorded in the session (§7.3). |
| S-10 | Nobody can view saved evidence. | A saved inspection frame is unreadable today. | Depend on `records.files.get` / `records.files.download` on `claude/leaseos-records-file-manager-bqgyjk` (a signed URL plus an `evidenceAccessEvents` row), not a new `evidence.view`. Unmerged; its record-type visibility rule affects how frames are saved (§15, §23.1). |
| S-11 | Workplace-monitoring perception. | Camera and screen features look like surveillance to workers. | Audit decisions, not traffic (§12). No per-frame audit rows. `monitoringNotices` (`schema.ts:8800`) records worker notice; a `live_assist` purpose is **OWNER** (D-08). |
| S-12 | Model confidence presented as fact. | Visual misidentification in a safety context. | A certainty vocabulary chosen by the server contract, not the model's number (§11.1). Safety classes force an escalation notice (§11.3). |

---

## 6. The Live Assist session

### 6.1 States

```
            start (user gesture)
                  │
                  v
  ┌──────────► ACTIVE ◄────────────┐
  │               │                │
  │  pause        │ source stops   │ resume (user gesture,
  │  (user, or    │ (stop sharing, │ same source or a new one)
  │  app hidden)  │ track ended)   │
  │               v                │
  └────────── PAUSED ──────────────┘
                  │
    idle timeout, │ user ends, auth invalid, org changed,
    budget spent, │ policy disabled, device revoked
                  v
    ENDED (endReason)       EXPIRED (idle, no heartbeat)
                  │
                  v
       purge of transient rows at purgeAfter
```

- **ACTIVE** means a visual source may be live. **PAUSED** means no source is live, but the conversation
  continues; a typed question with no frame is still allowed.
- Link quality (§9) is a separate field (`linkLevel`), because a session can be ACTIVE at any link level.
- ENDED and EXPIRED are terminal. Resuming creates a new session that may cite the previous
  `sessionRef`; the old one is never reopened. This is what makes a leaked or stale reference useless.
- Server-side transitions are fixed in code, like `TRANSITIONS` in `server/agentRouter.ts:76-88`. The
  model never sets session state.

### 6.2 Binding and liveness

| Check | Where | On failure |
|---|---|---|
| Caller is the session owner (`ctx.user.id`) | every call | NOT_FOUND |
| Acting organization equals `session.orgRef`, re-resolved per call | every call | session ENDED (`org_changed`), NOT_FOUND |
| Session state allows the call | every call | CONFLICT with the state; the client stops all tracks |
| `frameSeq` strictly greater than the last accepted | frame submit | CONFLICT (replay) |
| Heartbeat within the idle window (default 120 s) | a sweep on read, no worker needed | EXPIRED (`idle_timeout`) |
| Device active, when `deviceRef` is bound (`server/_core/fieldDevice.ts:62-111`) | start and every call | ENDED (`device_revoked`) |
| Budget remaining (§13.4) | frame submit | a budget error; the user may continue in text |

The expiry sweep runs lazily: any read of an overdue session moves it to EXPIRED inside the same
transaction. This needs no production-worker handler, which matters because worker wiring is itself
SPINE-blocked (`docs/REMAINING_BUILD_REGISTER.md` P9.4).

### 6.3 What the session holds, mapped to the request

| Request item | Held as | Lifetime |
|---|---|---|
| conversation/session ID | `sessionRef` | durable (lifecycle row) |
| tenant/organization | `orgRef`, from `resolveActingScope` | durable |
| authenticated user | `userId`; `deviceRef` when enrolled | durable |
| active visual source | `source` enum (`photo`, `camera`, `screen`, `video`) plus `sourceHistory` (json) | durable |
| voice/chat context | `liveAssistTurns` (redacted text, frame hashes) | **transient**, purged at `purgeAfter` (D-05) |
| attached LeaseOS context | `contextRefs`: typed references only (`job:123`, `unit:U-17`), admitted through `admitSource()` on every use | durable references; content is never copied |
| selected frames | `liveAssistFrames`, **only** for frozen, marked, inspected or saved frames: hash, perceptual hash, size, region; **no bytes** | transient unless saved |
| user-marked or frozen frames | `liveAssistFrames.kind` = `inspect` / `crop`, `markedByUser` | transient unless saved |
| AI observations | `liveAssistObservations` | transient |
| uncertainty | `certainty` enum on each observation (§11.1) | transient |
| requested follow-up views | `requestedView` on an observation | transient |
| user decisions | `liveAssistEvents` (for example `view_request_declined`, `save_confirmed`) | durable |
| proposed actions | `agentActions` via the agent runtime; typed form drafts via `assistantProposals` | durable (existing tables) |
| action approvals | `agentApprovals`, `readBackAcknowledged`, `proposalFields.status` | durable (existing) |
| deliberate evidence saves | `evidenceRecords` + `evidenceRelationships` + `liveAssistFrames.savedEvidenceRecordId` | durable, under retention policy |
| lifecycle timestamps | `startedAt`, `lastHeartbeatAt`, `pausedAt`, `endedAt`, `endReason` | durable |
| disconnect/reconnect | `linkLevel`, `linkHistory` (json, level changes only) | durable |

**Durable** means the lifecycle row and events: who, when, which source, how long, which level, what was
decided and saved. **Transient** means anything that describes what the camera or screen showed. The
default purge is 24 hours after the session ends (D-05). Turns are never readable from another session and
never enter retrieval, evaluation or training.

### 6.4 Freeze / Inspect

1. The user taps **Freeze**. The client keeps the current frame at capture resolution and stops sending context frames.
2. The user may pinch-zoom and drag a rectangle. The crop is taken from the **full-resolution** frame, not the downscaled preview, so a small placard becomes legible.
3. The client sends the crop (and, optionally, a low-resolution context frame so the model knows where the crop sits) with the question.
4. The server records a `liveAssistFrames` row (`kind = inspect` or `crop`, `markedByUser = true`) with SHA-256 of the exact bytes sent.
5. The answer is anchored to that frame hash, and the frame row also carries the hash of the **original** capture it was cut from. "Save this" saves the original, never re-encoded, and the crop the AI looked at stays recorded as provenance (§7.3).
6. **Unfreeze** resumes live sampling. A frozen frame is the natural unit for "Save as evidence".

---

## 7. Transient media versus deliberate evidence

### 7.1 The boundary

| | Transient Live Assist context | Deliberately saved evidence |
|---|---|---|
| Created by | the sampler, Freeze, Photo | an explicit **Save as evidence** action with a chosen link |
| Bytes on the server | **none persisted**. Frame bytes are forwarded to the vision adapter in memory and dropped when the call returns. | stored through `storagePut`, like any evidence |
| Bytes on the device | the client's recent-frame ring buffer (§13.1), cleared on session end | the existing outbox or upload |
| Server record | hash, perceptual hash, dimensions, region | `evidenceRecords` + version + relationship + seal |
| Retention | purged at `purgeAfter` | `retentionPolicy.ts`, legal hold honoured |
| Visible in | the session only | the linked job, unit, incident, defect or work order |
| Audit | lifecycle events only | `evidenceAccessEvents`, `authorizationDecisions`, `liveAssistEvents.evidence_saved` |

**The client is the frame cache; the server keeps the frame's identity, not its pixels.** A follow-up
question about the same frame re-sends it. This keeps the server stateless about images, works across
multiple server instances, and removes any need for a transient-object sweeper.

### 7.2 Vendor handling of transient frames

`llm.ts` sends images as a URL. There are two ways to supply one:

- (a) an inline `data:` URL, where nothing is written to storage;
- (b) a short-lived signed URL to a transient storage object.

**Recommended default: (a)**, if the chosen vendor accepts inline images. (b) needs an object-expiry
guarantee this repository cannot prove (storage lifecycle rules live outside the tree) and a sweeper that
worker wiring does not yet allow. This must be verified against the chosen vendor (D-03).

### 7.3 Saving a frame as evidence

1. The user taps **Save as evidence** on a frozen frame, photo or clip.
2. The user must pick a link: the current job, unit, trailer, equipment, trip, load, incident, inspection or work order, pre-filled from `contextRefs`. A defect is **not** a link target on `main` (`drizzle/schema.ts:2740-2749`); until the mechanic design's CP7 adds one, a defect photo links to the unit and is attached to the defect proposal. **With no link, the save is refused.** This matches the outbox rule that a capture with no `jobId` or `unitId` is refused (`client/src/runtime/outbox.ts:37-45`), and it gives the evidence an organization through its link (§0.3).
3. The client uploads the **original capture bytes, never re-encoded**, through the existing `fieldRoute.evidence.upload` with `clientCaptureRef = la:{sessionRef}:{frameSeq}`, which makes the save idempotent. This follows the scanner work's rule that the evidence original is stored as captured; the downscaled or cropped image the AI saw is a derivative, and its hash and crop region are kept as provenance.
4. The server recomputes SHA-256 over the stored bytes and compares it with `liveAssistFrames.originalHash`, which the client declared when it asked about the frame. On a mismatch the save is refused as `hash_mismatch`, closing S-9 for this path. The declaration binds the saved file to the question; it does not prove the crop was cut from it, which is why the crop region and derivative hash are kept beside it.
5. The server writes `evidenceRelationships` for the chosen link, then sets `liveAssistFrames.savedEvidenceRecordId` and appends `liveAssistEvents.evidence_saved`.
6. The evidence starts `needs_review` / `draft`, like every upload. Sealing stays the existing driver action.
7. **AI observations are not copied into the evidence record.** If the user wants the AI's reading kept, it goes through a typed proposal (§10). An observation is an inference, and evidence is what was seen.

Provenance recorded on the saved evidence: source (`camera`, `screen`, `photo` or `video`), `sessionRef`, `capturedAt` (device clock) and `receivedAt` (server), frame hash, capture resolution, crop region, device when enrolled, and GPS only if the user attached a fix.

### 7.4 Sensitive-content handling

- **Before sending:** the region crop (all sources); tab or window sharing by default (screen); pre-send preview in CONSTRAINED (screen); a "sensitive screen" pause button that stops sampling without ending the session.
- **Detection of sensitive text:** automatic masking needs on-device OCR, which does not exist on web. It is deferred to the native build (Android ML Kit, plan P6). Until then, the design does not claim automatic redaction.
- **After inference, before storage:** observation and turn text passes a server-side pattern redactor for credential-shaped strings, payment card numbers, Canadian SIN-shaped numbers and licence-number patterns. It is length-capped. Redaction is recorded as a flag, never as the original value.
- **Refusal list for saving:** a frame whose observations were flagged as showing credentials cannot be saved as evidence without an explicit second confirmation, and the flag stays on the record.

---

## 8. Permission and authorization boundaries

### 8.1 Proposed permissions

These are **PROPOSED**. Names follow the existing `domain.verb` pattern.

| Permission | Purpose | Sensitive (fail-closed)? | Suggested roles |
|---|---|---|---|
| `liveAssist.use` | start, submit, end a session with photo and camera | yes | driver, dispatcher, mechanic, shop_lead, office, management (today's holders of `assistant.use`) |
| `liveAssist.screenShare` | the screen source | yes | office, dispatcher, management; driver only when D-06 allows |
| `liveAssist.video` | the video-clip source | yes | as `liveAssist.use` |
| `liveAssist.saveEvidence` | save a frame or clip as evidence | yes; the save **also** requires the existing `evidence.upload` | driver, mechanic, shop_lead, office, management (today's holders of `evidence.upload` among them) |
| `liveAssist.administer` | organization policy: budgets, sources allowed, retention within limits | yes | management (there is no `administrator` role in `GRANTS`) |
| `liveAssist.review` | read another user's session lifecycle, **never** observations or turns | yes | safety, management |

- No role can read another user's frames, turns or observations. There is no procedure for it.
- The lifecycle row is the only thing a reviewer sees. This is a deliberate anti-surveillance boundary (D-08).
- Adding these requires updating `PROCEDURE_AUTHORIZATION_INVENTORY.md`, the pinned operational map size in
  `server/procedureAuthorization.test.ts:161`, and regenerating `LEASEOS_CURRENT_STATE.md` with
  `scripts/current-state.sh`. That is implementation work, not done here.

### 8.2 Layers, in order

1. **Organization policy** (`liveAssist.administer`) can disable sources or shorten budgets and retention. It can only reduce, the same one-way rule as `resolveAutomation` overrides (`server/_core/automationPolicy.ts:220-234`).
2. **Role permission** (§8.1) through `roleProcedure`.
3. **Session binding** (§6.2).
4. **Context admission.** Every LeaseOS record the AI is given passes `admitSource()` for this user now. Attaching `job:123` to a session does not grant it; it is re-admitted on every turn.
5. **Action gateway.** Any action the AI proposes is a `CapabilityDefinition` decided by `decide()`. There is no path from a vision observation to a domain write except §10's typed proposals and the gateway.

### 8.3 The owner plan's ladder mapped onto the gateway

| Plan level | Gateway `RiskLevel` | Live Assist phase |
|---|---|---|
| L0 Observe | `read` | Phase 1 |
| L1 Assist (highlight, guide) | `read` / `prepare` | Phase 1 (guidance is text; highlighting is on the user's own preview) |
| L2 Prepare (drafts) | `prepare` | Phase 1, through typed proposals only |
| L3 Routine execute | `low_risk_action` (needs `autoExecute`; `agentRouter` passes `[]`) | not before the gateway executes anything |
| L4 Consequential | `approval_required` / `restricted` | not before the gateway executes anything |
| L5 Restricted "never" | `NEVER_AUTONOMOUS` | never |

### 8.4 Computer-use boundary

- **Observation and control are different subsystems with no shared code path.** The screen source produces
  frames; nothing in Live Assist can emit input events.
- A future "the AI does it" capability is a new `CapabilityDefinition` whose executor is a reviewed
  deterministic adapter (plan P7): a LeaseOS deep link, a navigation intent, or a typed LeaseOS mutation.
  It is never a coordinate click, and never a plan-and-tap loop.
- **In-app guidance for LeaseOS's own screens should use structured UI context, not pixels** (plan P5). When
  the user shares LeaseOS itself, the preferred source is the page's own route and record references,
  admitted through `admitSource()`, which respects permissions. Pixels are the fallback for other
  applications.

---

## 9. Degraded and offline behavior

### 9.1 Levels

| Level | Entered when (client measures, with hysteresis) | Visual behavior | Voice/chat | Shown to user |
|---|---|---|---|---|
| **LIVE** | median round trip under 1.5 s **and** recent upload rate above about 400 kbit/s | sampler active; context frames at 1024 px long edge; Freeze sends up to 2048 px crops | push-to-talk clips and typed text | "Live" |
| **CONSTRAINED** | round trip 1.5–5 s, or upload rate 100–400 kbit/s | sampler throttled to at most 1 frame per 15 s at 640 px; Freeze still full-quality but with a progress bar | typed text preferred; voice clips capped at 15 s | "Limited connection — fewer images, slower answers" |
| **SNAPSHOT_ONLY** | round trip over 5 s, repeated timeouts, or upload rate under 100 kbit/s | live preview stays on the device; **nothing is sent until the user taps Send**; one frame per turn | typed text only | "Weak connection — snapshot assistance only" |
| **OFFLINE** | `navigator.onLine` false, or three consecutive failed calls | no AI assistance of any kind; the camera may still take a photo | none | "No connection — Live Assist unavailable. You can still take a photo." |

- **The thresholds are unverified starting defaults** to be calibrated in the pilot. They are placed in organization policy, not in code (D-07).
- Level changes are recorded as events, only on change.
- The client must hold a level for about 20 s before stepping up again, so a flapping signal does not flap the UI.

### 9.2 Rules that hold at every level

- **Never pretend.** At SNAPSHOT_ONLY and OFFLINE the UI says what is not available. A queued question is never answered later "as if live" without being labelled with the time it was asked.
- **No automatic send on reconnect.** Frames taken offline are not sent to the AI automatically. The user chooses to ask about them when the link returns.
- **No local AI verdicts.** There is no on-device model in this design. Offline, the device records; it does not decide (`offlineCapability.ts` header).

### 9.3 Offline evidence queue

| Platform | Behavior |
|---|---|
| Web (the first slice) | **No offline evidence queue.** The in-memory store would lose the photo on reload, and `adapters/memory.ts:4-8` states it is not at-rest protection. The user is told plainly, and the photo can be saved to the device's own gallery with the browser's download. |
| Native (after P1.1 / HS1) | Save-as-evidence while offline becomes a `LocalCapture` of kind `photo` in the existing outbox, which encrypts it into the vault, requires `jobId` or `unitId`, and syncs through `sync.receivePackage` (signed, nonce-protected) at priority 40. The `la:` `clientCaptureRef` keeps it idempotent. |

`offlineCapability` classification of the Live Assist capabilities: taking and saving a photo is
`local_capture`; asking the AI anything is `server_authoritative`, so it is unavailable offline by
declaration and cannot be inferred into availability.

---

## 10. Connection to the AI Secretary and LeaseOS domains

Hand-off means the Live Assist session produces a **reference and a proposal**, and the target domain's
existing procedure decides. Live Assist never writes a domain table itself.

| Domain | What exists | Live Assist hand-off | State of the target |
|---|---|---|---|
| AI Secretary typed forms | `aiProposal` forms, read-back, `executeAssistantCommit` | "Fill this from the photo": the frame goes to the vision adapter with the form's output schema (`buildOutputSchema`), fields arrive with `source = photo_ocr`, then the normal gaps, read-back and commit | EXISTS (live); no client page yet |
| Disposal tickets | `disposal_ticket` form; `disposalTickets` (`schema.ts:1048`); fingerprint duplicate gate | as above; the saved photo is linked with `evidenceRelationships.entityType = disposalTicket` | EXISTS |
| Defects | `defect_report` form (observation only, no diagnosis field, `aiProposal.ts:213-219`); `maintenanceDefects` | "Report this as a defect": a proposal with the frame saved as evidence linked to the unit | EXISTS; the AI may describe, never diagnose (manifest line 417) and never sets severity, lifts a hold or implies return to service (`claude/mechanic-portal-domain-82efa9:docs/register/MECHANIC_PORTAL_FLEET_MAINTENANCE_DESIGN.md:138`, six-step release at `:487-498`) |
| Work orders / maintenance | `workOrders`, `workOrderReleases`, `mechanicRelease.ts` | reference only in Phase 1; attach evidence via relationship `workOrder` | EXISTS; **release is never proposed by Live Assist** (`maintenance.clearOutOfService` is `NEVER_AUTONOMOUS`) |
| Expenses and fuel receipts | `expense_receipt`, `fuel_receipt` forms | photo to proposal | EXISTS |
| Dispatch / jobs | `jobs`, dispatch readiness, `jobInScope` | the current job is the default `contextRef`; answers may cite readiness blockers through `admitSource()` | EXISTS |
| Route / map | `routeEvaluation`, route approvals, road restrictions | reference only: "open route context" is an in-app link; Live Assist never approves a route | EXISTS |
| Inspections | `inspections` (`schema.ts:298`), no media column | attach through `evidenceRelationships.entityType = inspection`; no pass/fail from AI | EXISTS (server); no client form |
| Incidents / safety | `records.incident`, `incidentReports`, `nearMissReports` | attach evidence to an incident the user is filing; the AI may draft a description, the person files it | EXISTS |
| Dangerous goods | `evaluateDangerousGoodsAssist` with disclaimer | a placard photo may be *read*; any TDG determination goes through the existing assist, which returns `needs_review` at best | EXISTS |
| Driver qualifications | compliance passport, `complianceDocuments`, training academy | a certificate photo is saved as evidence, then `driverPortfolio.submitCredential({code, evidenceRecordId})` writes a `needs_review` credential; a second person runs `credentialVerify`; AI-read dates are pre-filled for the verifier, never written as facts | EXISTS on `main` as `complianceDocuments`; the portfolio API is on open branches (PR #16 plus `claude/driver-portfolio-api-ya8928`). Its submit path is self-only, so a safety user photographing someone else's card still uses the older `compliance.credentialRecord` |
| Fleet / equipment | `units`, safety binder, `asset.twin`, telematics fault codes | the unit is a `contextRef`; fault codes are admitted context; the AI may explain a warning light **and must say to follow the operator's manual and company procedure**; saved photos link to `unit`, `trailer` or `equipment` with the fleet design's photo-purpose `role` values (`front`, `vin_plate`, `serial_plate`, `damage`, `defect`, …) | EXISTS on `main`; the Fleet & Equipment Portfolio is design only (`claude/fleet-equipment-portfolio-design-3d13d5`), and its proposed `fleet.holdRelease` joins `NEVER_AUTONOMOUS` |
| Document knowledge | `assistantAsk` (full-text, graded, no model) | the AI may cite admitted knowledge passages; `verifyClaim` grading applies | EXISTS |
| Exception Centre | category `"ai"` (`server/_core/exceptionCentre.ts:206`) | unresolved Live Assist proposals surface there like any AI proposal | EXISTS |

---

## 11. AI behavior contract

### 11.1 Certainty is a server vocabulary, not a model number

Every observation carries one of:

| `certainty` | Meaning | UI wording |
|---|---|---|
| `visible_clearly` | the thing is plainly in frame and legible | "I can see…" |
| `visible_partially` | in frame but cut off, blurred, glared or small | "It looks like… but I can't see it clearly" |
| `not_visible` | asked about, not in frame | "I can't see that in this view" |
| `inferred` | not directly visible; reasoned from what is | "I'm inferring… this is not confirmed" |

- The model fills a constrained output schema. A model-reported numeric confidence is not stored. That
  follows door 2's rule that it "refuses to store the model's own number" (terminology §17).
- Anything the user acts on displays its certainty.
- `inferred` is never displayed with the same styling as `visible_clearly`, following plan §5.3's
  MEASURED / OBSERVED / INFERRED / CONFIRMED distinction.

### 11.2 Requested follow-up views

The model may return at most one `requestedView` per answer:

`closer` · `wider` · `other_side` · `more_light` · `hold_steady` · `freeze` · `region` (with a
normalized rectangle on the last frame) · `context_question` (a question in words, when the problem is
information rather than pixels).

- The UI renders it as a prompt with **Do it** and **Skip**. Skipping is recorded as a user decision.
- In LIVE, satisfying a `hold_steady` or `closer` request lets the sampler send the next stable frame
  automatically. In other levels, the user sends it.

### 11.3 Safety classes

Each answer carries a `safetyClass`:

| Class | Trigger topics (the model classifies; the server enforces the text) | Required behavior |
|---|---|---|
| `none` | ordinary how-to, paperwork, software | — |
| `advise_qualified_inspection` | brakes, steering, tires, couplers, securement, pressure vessels, hydrovac or vacuum equipment, electrical, lifting, structural damage, warning lights | a fixed server-authored notice that visual assistance does not replace a qualified inspection, the operator's manual or company procedure; no statement that anything is safe, legal, compliant or fit for service |
| `stop_work_escalate` | leaks of unknown or dangerous goods, fire, smoke, H2S or gas indications, injury, a vehicle or equipment in an unsafe state in traffic, downed lines | a fixed notice to stop, make the area safe per company procedure and contact the supervisor or emergency services; a one-tap link to the job's contacts where they exist; the event is recorded |

- The notice text is server-authored and versioned, never model-generated, so it cannot be argued away.
- `detectOverreach` (`aiProposal.ts:686-700`) runs on every Live Assist answer. A hit is stored as a flag,
  and the answer is shown with the overreach phrase replaced by the safety notice.
- The manifest's hard boundaries apply unchanged: no diagnosis, no TDG certification, no route approval,
  no HOS certification, no vehicle release, no customer-acceptance inference, no billable amounts from
  unconfirmed values (§28, lines 1545-1610).

### 11.4 Screen-share guidance

- Step-by-step guidance refers only to what is visible ("the blue **Submit** button at the bottom right of
  this form"). When the target is not visible, the answer is `not_visible` with a `region` or `wider` request.
- The AI never types into or clicks the shared screen (§8.4).

---

## 12. Audit model — decisions, not traffic

There is no general ledger (§1.3), so Live Assist adds one pointer-only lifecycle table and otherwise
reuses per-subsystem rows.

| Event | Recorded in |
|---|---|
| session started / paused / resumed / ended / expired (with `endReason`) | `liveAssistEvents` |
| source started / stopped (camera, screen, photo, video) | `liveAssistEvents` |
| link level changed | `liveAssistEvents` (on change only) |
| inspection frame submitted (Freeze / crop) | `liveAssistEvents` with frame hash, no bytes |
| context frames submitted | **counters on the session row only** (`framesSubmitted`, `bytesSubmitted`) |
| safety class `stop_work_escalate` returned | `liveAssistEvents` |
| requested view declined | `liveAssistEvents` |
| frame / clip saved as evidence | `liveAssistEvents` + `evidenceRecords` + `evidenceRelationships` |
| AI action proposed | `agentActions` (existing) |
| user approved / rejected | `agentApprovals`, `proposalFields.status`, read-back acknowledgement (existing) |
| typed commit executed / refused | `assistantCommitReceipts`, `authorizationDecisions` (existing) |
| every procedure call, allowed or denied | `authorizationDecisions` (automatic through `roleProcedure`) |

- **Never in any audit or log row:** frame bytes, base64, storage keys of transient objects, turn text,
  observation text.
- Whether `liveAssistEvents` is hash-chained like `academyAuditEvents` is **OWNER** (D-09). The
  recommended default is yes, with the previous-hash read taken under lock, which the academy
  implementation lacks.
- **Inference telemetry** (vendor route, model, latency, input and output tokens, failure) must go through
  the single seam P9.6 describes, not a Live Assist-only table. If P9.6 is not built first, the first
  slice builds it (D-10).

---

## 13. Frame sampling, cost and performance

### 13.1 The client-side sampler

The sampler runs on the device, on a small offscreen canvas.

1. **Preview and analysis are separate.** The preview renders at camera rate. Analysis reads a 64×64 grayscale thumbnail at most every 250 ms. Nothing sends at camera rate.
2. **Change detection:** a 64-bit difference hash (dHash) per thumbnail. A Hamming distance above a threshold (starting default 10) marks "scene changed".
3. **Stability:** mean absolute difference between consecutive thumbnails under a threshold for 600 ms marks "steady".
4. **Quality gates:** blur as variance of the Laplacian on the thumbnail, and exposure as mean luminance within limits. A failed gate yields a local hint ("hold steady", "more light") **without spending an AI call**.
5. **Deduplication:** a candidate within Hamming distance 6 of the last sent frame is skipped.
6. **Send triggers:**
   - the user ends a turn (the best steady frame in the last 3 s rides along);
   - Freeze;
   - a steady frame after a scene change, in LIVE only, at most one per 8 s;
   - a steady frame satisfying an AI `requestedView`.
7. **Ring buffer:** the last 8 sent frames are kept in memory so follow-ups can re-send without recapture. The buffer is cleared on session end.

Screen frames change rarely and in large steps, so the same pipeline works with a lower threshold. Region
crops are the normal case for screens.

All thresholds are **unverified starting defaults**, to be tuned in the pilot and held in organization
policy (D-07).

### 13.2 Size and format

| Kind | Long edge | Format | Typical size (estimate) |
|---|---|---|---|
| Context frame, LIVE | 1024 px | JPEG, quality 0.7 | 80–200 KB |
| Context frame, CONSTRAINED | 640 px | JPEG, quality 0.6 | 30–80 KB |
| Inspect crop | up to 2048 px from the full-resolution frame | JPEG, quality 0.85 | 150–600 KB |
| Saved evidence | original capture resolution | JPEG as captured | as captured, at most 15 MB (existing cap) |

A per-call cap of 2 MB decoded is proposed for frame mutations, well under the 50 MB body limit. EXIF
data is stripped from transient frames. Saved evidence keeps EXIF only where the evidence policy wants it,
and GPS is included only if the user attached it (D-11).

### 13.3 Why Freeze is cheaper and better

One 2048 px crop of the region that matters costs about the same as a handful of context frames and is far
more legible. The UI makes Freeze the primary action for "what is this part?" questions.

### 13.4 Budgets

| Budget | Default (policy-held, unverified) | On exhaustion |
|---|---|---|
| Session duration | 20 minutes | a warning at 18, then ENDED (`budget_spent`); the user may start again |
| Frames per session | 60 | the session continues in text; Freeze still allowed up to the inference cap |
| Inference calls per session | 40 | ENDED (`budget_spent`) |
| Inference calls per user per day | 150 | start refused with a clear message |
| Organization daily spend ceiling | set by a holder of `liveAssist.administer`; none means Live Assist is off | start refused |

- Counters live on the session row and are enforced server-side. The model cannot raise them. This
  follows the direction of P9.5, where `maxSteps` "the model cannot raise".
- An organization with no spend ceiling set has Live Assist **off**. This is fail-closed, the same shape as
  "an entitled but unconfigured capability resolves to MANUAL".

### 13.5 Video clip

- Clips are recorded on the device (`MediaRecorder` on web) and capped at 30 s and 25 MB.
- Frames are extracted **on the device**, using the same sampler run over the clip: scene-change keyframes
  plus one frame per 2 s, capped at 12 frames.
- Only the extracted frames and the user's question go to the vision adapter. The clip itself is uploaded
  only if the user saves it as evidence.
- Sending `video/mp4` directly to a vendor (the type exists in `llm.ts`) is **not** the default, because it
  moves the frame choice, and the cost, to the vendor.

### 13.6 Observability

- Per session: frames submitted, bytes, inference calls, tokens, latency percentiles, link-level time
  shares, budget exhaustion, safety classes, requested views issued and satisfied.
- Per organization: the daily spend against the ceiling.
- None of it contains content.

---

## 14. Tests and failure cases

These are to be written with the implementation. They are the definition of done, not a wish list.

**Authorization and isolation**
- every Live Assist procedure × every role: allowed or refused as §8.1 says;
- denied calls still write `authorizationDecisions`;
- a sensitive permission refuses when the decision row cannot be written;
- organization A's session, frames, observations and events are NOT_FOUND from organization B (a `.db.test.ts` per procedure);
- a user in two organizations is refused as `AmbiguousOrganization`;
- an acting-organization change mid-session ends it.

**Session lifecycle**
- start without a user gesture is impossible from the API (the start mutation requires a client-declared source and returns a fresh `sessionRef`);
- replayed and out-of-order `frameSeq` are refused;
- a submit to ENDED or EXPIRED is refused, and the client stops its tracks;
- the idle sweep expires on read;
- logout, token expiry and device revocation end the session;
- a resumed session gets a new reference and the old one stays dead.

**Capture lifecycle (client)**
- the browser denies permission;
- the user stops sharing from the browser UI (`track.onended`);
- the tab is hidden, rotated or backgrounded (tracks stop);
- the page reloads (nothing persists, the session expires);
- two tabs try to share at once (the second is refused while one session is ACTIVE for this user and device).

**Transient versus evidence**
- no frame bytes in any table after a session;
- turns and observations are purged at `purgeAfter`;
- a save without a link is refused;
- a save whose recomputed hash differs from the frame hash is refused;
- save idempotency by `clientCaptureRef`;
- a legal hold on saved evidence survives session purge.

**AI behavior**
- invalid schema output is rejected before display;
- an unknown `requestedView` value is rejected;
- `detectOverreach` hits are replaced with the safety notice;
- the `advise_qualified_inspection` and `stop_work_escalate` notices are the server text, verbatim;
- injected instructions in frame text do not change capabilities (golden images with "ignore previous instructions" text);
- a vision observation cannot create a domain write except through a typed proposal with read-back.

**Degradation**
- each level's send behavior;
- the hysteresis holds;
- OFFLINE refuses AI calls with a clear state;
- nothing auto-sends on reconnect;
- web has no offline evidence queue.

**Cost**
- every budget refuses at its cap;
- no ceiling means off;
- counters cannot be written from input.

**Logging**
- a static test that Live Assist routers pass no input object to `console.*`;
- a runtime test that an induced adapter failure logs no base64.

**Adapter**
- unconfigured provider refuses (P9.1);
- adapter timeout and retry do not double-count budgets;
- the vendor route is recorded per call.

---

## 15. Schema changes (proposed, not migrated)

No migration is created. At implementation time the number must be taken from the collision register,
after `0174` and clear of `0172`/`0173`.

**`liveAssistSessions`**
- `id`, `sessionRef` (unique, random), `orgRef` NOT NULL, `userId`, `deviceRef` (null), `source` enum, `sourceHistory` json
- `state` enum (`active`, `paused`, `ended`, `expired`), `linkLevel` enum (`live`, `constrained`, `snapshot_only`, `offline`), `linkHistory` json
- `contextRefs` json (typed refs only), `policySnapshot` json (budgets, retention, vendor route key)
- `startedAt`, `lastHeartbeatAt`, `pausedAt`, `endedAt`, `endReason` enum
- counters: `framesSubmitted`, `bytesSubmitted`, `inferenceCalls`, `inputTokens`, `outputTokens`
- `purgeAfter`, `previousSessionRef` (null)

**`liveAssistTurns`** (transient; D-05)
- `id`, `sessionId`, `orgRef`, `seq`, `role` (`user` / `assistant`), `channel` (`text` / `voice`)
- `text` (redacted, capped), `frameHashes` json, `redactionFlags`, `createdAt`, `purgeAfter`

**`liveAssistFrames`** (only frozen, inspected, cropped or saved frames)
- `id`, `sessionId`, `orgRef`, `frameSeq`, `kind` (`context` / `inspect` / `crop`)
- `frameHash` (SHA-256 of the bytes sent), `originalHash` (SHA-256 of the capture it was derived from, declared by the client), `perceptualHash`, `width`, `height`, `byteSize`, `region` json
- `markedByUser`, `savedEvidenceRecordId` (null), `createdAt`, `purgeAfter` (cleared when saved)

**`liveAssistObservations`** (transient)
- `id`, `sessionId`, `orgRef`, `turnId`, `frameHash`
- `kind` (`identified`, `read_text`, `condition`, `guidance_step`)
- `statement` (redacted, capped), `certainty` enum, `requestedView` enum (null), `requestedRegion` json (null)
- `safetyClass` enum, `overreachFlags`, `createdAt`, `purgeAfter`

**`liveAssistEvents`** (durable, append-only, pointer-only)
- `id`, `sessionId`, `orgRef`, `actorUserId`, `eventType`, `frameHash` (null), `evidenceRecordId` (null)
- `detail` (≤ 200 chars, no content), `occurredAt`, and `previousHash`, `eventHash` if D-09 chooses a chain

**`liveAssistPolicies`** (per organization, append-only with supersession like `automationPolicies`)
- `orgRef`, sources allowed, budgets, level thresholds, retention within LeaseOS hard limits
- spend ceiling, vendor route key, `supersededAt`

**Changes to existing tables**
- None required on `main`.
- **Save frames under the domain record type** (`photo`, `defect_report`, `inspection`, `credential`, and so on), with the Live Assist source in provenance, **not** under a new `live_assist_frame` type. The records file manager branch decides visibility by record type, and an unlisted type is visible only to its owner (`claude/leaseos-records-file-manager-bqgyjk:server/_core/recordFiles.ts:46-106`). A saved defect photo must be visible to the mechanic.
- `proposalFields.source` already has `photo_ocr`.
- `evidenceRecords` lacking an organization column is the known gap, fixed by the tenancy work in §0.2, not here.

**Explicitly not added**
- A frame-bytes table, a conversation table outliving its session, a reasoning column (P9.9), a numeric model-confidence column.

---

## 16. Backend services and interfaces (proposed)

### 16.1 Vision adapter

```ts
// PROPOSED — server/_core/liveAssist/visionAdapter.ts
export type VisionFrame = {
  frameHash: string;              // SHA-256 of `bytes`, computed server-side on receipt
  mimeType: "image/jpeg" | "image/png";
  bytes: Buffer;                  // in memory only; never persisted by the adapter
  role: "context" | "inspect";
  region?: { x: number; y: number; w: number; h: number }; // normalized 0..1
};

export type VisionRequest = {
  sessionRef: string;
  orgRef: string;
  instruction: SystemInstructionRef;      // versioned, server-authored
  admittedContext: AdmittedContextBlock[]; // from admitSource(); never raw records
  turns: RedactedTurn[];                  // this session only
  frames: VisionFrame[];                  // at most 4 per call
  outputSchema: OutputSchema;             // observations / proposal fields
  budget: { maxOutputTokens: number; timeoutMs: number };
};

export type VisionResult =
  | { ok: true; output: unknown; usage: { inputTokens: number; outputTokens: number };
      route: { provider: string; model: string; policyKey: string }; latencyMs: number }
  | { ok: false; reason: "unconfigured" | "timeout" | "provider_error" | "refused" | "schema_invalid" };

export interface VisionAdapter {
  analyze(req: VisionRequest): Promise<VisionResult>;
}
```

- **Which model door it sits behind is D-13.** `main` has one door, `invokeLLM`, which carries the P9.1 defect
  but already types `ImageContent`. The Secretary model layer on `claude/secretary-model-dialogue-yzszcv`
  (PR #7) has a second door, `LlmProvider`, which refuses to run unconfigured, has a 60 s timeout and no
  default host, but whose messages are text only ("no tools, no images",
  `server/_core/ai/llm/provider.ts:31-72` on that branch). The recommended default is to extend
  `LlmProvider` with image parts and build the adapter on it, so Live Assist never touches the forge
  fallback. Either way it is selected by `modelGateway.route("vision")`, which needs `vision` added to
  `ModelTask`.
- It refuses with `unconfigured` rather than falling back to any default host (P9.1).
- The output is validated against the schema before anything reads it. `schema_invalid` is a refusal, not
  a retry-until-plausible.

### 16.2 Server modules and procedures

| Module (PROPOSED) | Role |
|---|---|
| `server/_core/liveAssist/session.ts` | pure: state transitions, binding checks, budget arithmetic, expiry rule |
| `server/_core/liveAssist/observation.ts` | pure: output schema, certainty and safety vocabularies, redaction, safety notice text (versioned) |
| `server/_core/liveAssist/visionAdapter.ts` | §16.1 |
| `server/liveAssistRouter.ts` | procedures below, all `roleProcedure` |
| `server/liveAssistService.ts` | database writes, in transactions |

| Procedure | Permission | Notes |
|---|---|---|
| `liveAssist.start` | `liveAssist.use` (+ `screenShare` / `video` by source) | returns `sessionRef`, policy snapshot, level thresholds |
| `liveAssist.ask` | `liveAssist.use` | turn text plus up to 4 frames; the one AI call path |
| `liveAssist.heartbeat` | `liveAssist.use` | link level, liveness |
| `liveAssist.pause` / `resume` / `end` | `liveAssist.use` | |
| `liveAssist.saveFrame` | `liveAssist.saveEvidence` + `evidence.upload` | §7.3 |
| `liveAssist.proposeForm` | `liveAssist.use` + `assistant.use` | frame to typed proposal with `photo_ocr`; commit stays `assistant.commit` |
| `liveAssist.policyGet` / `policySet` | `liveAssist.administer` | reduce-only against LeaseOS limits |
| `liveAssist.lifecycleList` | `liveAssist.review` | lifecycle rows only; no content |

### 16.3 Transport interface (client)

```ts
// PROPOSED — client/src/liveAssist/transport.ts
export interface LiveAssistTransport {
  ask(input: AskInput): Promise<AskResult>;   // Approach A: one tRPC mutation
  heartbeat(input: HeartbeatInput): Promise<HeartbeatResult>;
  // Approach C later adds a streaming implementation behind the same interface.
}
```

---

## 17. Mobile and web changes

**Platform facts that shape the phases** (re-verify at build time; browser support changes):

| Capability | Desktop browser | Mobile browser | Native shell (after P1.1) |
|---|---|---|---|
| Photo from camera | file input with `capture`, or `getUserMedia` | yes (HTTPS required) | Capacitor camera plugin |
| Live camera preview | `getUserMedia` | yes; stops when the tab is backgrounded | WebView `getUserMedia` (permission bridging must be verified on device), or a native preview |
| Screen share | `getDisplayMedia` (tab, window or screen) | **not available** as of this writing | Android `MediaProjection` with a foreground service and per-session consent (plan §6.4); iOS would need a broadcast extension (not planned) |
| Video clip | `MediaRecorder` | yes; codec support varies (Safari records MP4, Chrome WebM) | native recorder |
| On-device OCR for redaction | not practical | not practical | ML Kit (Android) |
| Encrypted offline queue | no | no | SQLCipher + keystore (P1.1) |

**Client additions (PROPOSED):**

- `client/src/liveAssist/` holding:
  - `LiveAssistPanel`, built on `AIChatBox` by wiring its existing `onCamera`, `onVoice` and `onAttach` props;
  - `CaptureSurface` (preview, Freeze, crop);
  - `SharingIndicator`, a persistent bar showing the **CAMERA / SCREEN / PHOTO / VIDEO** label, elapsed time and a one-tap **Stop sharing**, rendered at the app shell level so no route can hide it;
  - `sampler.ts` (§13.1), `linkMonitor.ts` (§9.1), `transport.ts` (§16.3).
- Entry points: the existing `QuickCapture` Photo action and a Live Assist button in the portal shell for the field portals. Office and dispatch get the screen source on desktop.
- Teardown in one place: `stopAllTracks()` is called on Stop, `visibilitychange` to hidden, `pagehide`, any tRPC `UNAUTHORIZED` or `CONFLICT` from Live Assist, a session state that is no longer active, and `track.onended`.
- A Permissions-Policy header allowing `camera`, `microphone` and `display-capture` for the app's own origin only. None exists on `main`. The hardening branch sets `camera=(self), microphone=(self)` and does not list `display-capture` (`claude/leaseos-code-audit-yvggvw:server/_core/httpHardening.ts:35`); LA-3 adds `display-capture=(self)` explicitly, with a test. The same branch lowers the tRPC body limit to 25 MB and returns 415 for non-JSON mutations, which the frame sizes in §13.2 already respect.
- Accessibility: large touch targets for gloved use, and a screen-reader label for the sharing state (the repository has `a11yCoverage.test.ts` to extend).

**Native (after P1.1, not in the first slices):** a `CameraAdapter` and `ScreenCaptureAdapter` added to the
runtime contracts beside the existing `NATIVE_ONLY_CAPABILITIES`, the `MediaProjection` foreground service,
the outbox hand-off for offline saves, ML Kit masking, and MDM restriction detection (plan P9).

---

## 18. Platform limitations discovered

1. **No native shell.** Phone screen sharing, durable offline queues, on-device OCR redaction and keystore-bound device keys all wait for P1.1.
2. **No realtime transport.** Full-duplex voice needs Approach C, a new transport, which is deliberately later.
3. **Only one AI provider path, which is not hardened.** P9.1 first. Vendor choice is open (D-03).
4. **No OCR engine.** Document reading in the first slices is done by the vision model, into typed proposals, and every field is reviewed. Whether a dedicated OCR engine should back the high-volume ticket path is a later decision.
5. **No logger or redaction infrastructure.** Live Assist must not be the feature that introduces base64 into logs (§14 logging tests).
6. **No evidence viewer.** A saved frame cannot yet be opened by anyone (S-10).
7. **Organization isolation incomplete.** New tables can be correct; inherited evidence scope remains the known gap.
8. **Mobile browser camera stops in the background.** That is desirable for privacy and must be treated as a normal end, not an error.
9. **Codec variance.** Clip recording differs by browser, so frame extraction on the device is also the portability answer.

---

## 19. Phasing

| Phase | Scope | Depends on |
|---|---|---|
| **LA-0** preconditions | D-01 moratorium ruling; P9.1 closed; D-03 vendor with retention terms; the P9.6 telemetry seam | owner; security work |
| **LA-1** Photo + Freeze/Inspect + session foundation | session tables, lifecycle, binding, budgets, vision adapter, observations with certainty and safety classes, Save as evidence with link and hash check, photo-to-typed-proposal for the five existing forms; web only | LA-0 |
| **LA-2** Live camera | sampler, link monitor, degradation levels, requested views, push-to-talk through `transcribeAudio` (wired for the first time) | LA-1 |
| **LA-3** Screen share (desktop) | tab/window default, region crop, pre-send preview, the sensitive pause; in-app structured context for LeaseOS's own pages | LA-2 |
| **LA-4** Video clip | on-device frame extraction, clip evidence save | LA-2 |
| **LA-5** Native | Android camera and `MediaProjection`, offline evidence queue through the outbox, ML Kit masking, MDM detection | P1.1, HS1 |
| **LA-6** Proposed actions | Live Assist proposals to agent-runtime capabilities; only after the gateway executes anything | P9.3, P9.4, P9.8, SPINE |
| **LA-7** Streaming voice (Approach C) | only if the pilot shows turn latency is the complaint | pilot data |

---

## 20. Owner decisions (with recommended defaults)

| # | Decision | Recommended default |
|---|---|---|
| D-01 | Lift the SPINE moratorium for Live Assist, carve it out, or wait | **Wait** until at least SPINE items 1–2 are done, then carve out LA-1 only, recorded beside `docs/register/SPINE_WIRING_PLAN.md` without editing it (it is hash-pinned) |
| D-02 | Accept Approach A | Yes |
| D-03 | Vision vendor and model | No default. Requirements: written zero-retention / no-training terms for API traffic, inline image input, schema-constrained output, a Canadian or otherwise acceptable data-residency answer, and a licence that passes `modelGateway`'s licence gate |
| D-04 | Web first, or wait for the native shell | Web first for LA-1 to LA-4; native is LA-5 |
| D-05 | Persist session turns and observations at all, and for how long | Persist, purge 24 h after session end; never retrievable across sessions |
| D-06 | Drivers may screen-share | No for LA-3 (desktop office/dispatch only); revisit with native |
| D-07 | Budget, threshold and level defaults (§9.1, §13.4) | As listed, held in policy, tuned in pilot |
| D-08 | Worker notice for Live Assist in `monitoringNotices`; reviewer visibility | Add a `live_assist` purpose; reviewers see lifecycle rows only |
| D-09 | Hash-chain `liveAssistEvents` | Yes, with a locked previous-hash read |
| D-10 | Build the P9.6 telemetry seam inside LA-1 if not already built | Yes |
| D-11 | EXIF and GPS on saved evidence | Strip EXIF on transient frames; keep capture time; GPS only when the user attaches a fix |
| D-12 | Documents: may a document image be read by a cloud vision model, or only on the device? The scanner branches read on the device only ("never uploaded to be read") | Cloud reading allowed only for the five typed forms' document kinds, and only after SEC-6 classification exists; payroll, medical and contract documents never |
| D-13 | Which model door carries images (§16.1) | Extend the Secretary layer's `LlmProvider` (PR #7) with image parts; never add images to `invokeLLM` |
| D-14 | Record type of saved frames | The domain type (`photo`, `defect_report`, `credential`, …) with Live Assist provenance; no `live_assist_*` type |

---

## 21. What this design deliberately does not do

- It does not choose an AI or video vendor.
- It does not introduce WebRTC, WebSockets or any realtime transport.
- It does not give the AI any way to click, type, submit or send.
- It does not persist raw frames, clips or audio except as deliberately saved evidence.
- It does not add a conversation store, AI memory or reasoning column.
- It does not create migrations, tests, permissions or routes.
- It does not modify `docs/register/SPINE_WIRING_PLAN.md`, the backlog register or the terminology register.
- It does not claim automatic redaction on the web.
- It does not name a "Driver Portfolio" or "Equipment Portfolio" that the code does not have.

---

## 22. The exact next implementation checkpoint

**Checkpoint LA-1 — Photo + Freeze/Inspect + Live Assist session foundation (web).** It may begin only
when all four LA-0 preconditions hold:

1. D-01 is ruled, allowing LA-1, and the hardening "Wave 0" freeze, if adopted, is lifted for it.
2. P9.1 (AI-001, part of SEC-12) is closed: the model path refuses to run unconfigured and has no hard-coded vendor host.
3. D-03 names a vendor whose retention terms are on file.
4. The P9.6 telemetry seam (AI-006) exists, or D-10 puts it inside LA-1.

The full precondition list, including the open-branch dependencies of §23, the work breakdown and the
per-file plan are in `docs/live-assist/LIVE_ASSIST_LA1_IMPLEMENTATION_PLAN.md`.

**Build:**
- The six tables of §15 in one migration.
- `session.ts` and `observation.ts` as pure modules with tests.
- The vision adapter.
- `liveAssistRouter` with `start`, `ask`, `heartbeat`, `pause`, `resume`, `end`, `saveFrame`, `proposeForm` and `policyGet`/`policySet`.
- The six permissions, the inventory and the pinned counts.
- A web `LiveAssistPanel` with Photo and Freeze/crop (a still image only; no live sampler yet).
- The sharing indicator, and teardown.

**Done when:**
- every test family in §14 that applies to photos passes, including the organization-isolation `.db` tests and the no-content-in-logs tests;
- the clean-database gate is green;
- `LEASEOS_CURRENT_STATE.md` is regenerated;
- a photographed disposal ticket goes photo → `photo_ocr` proposal → gaps → read-back → commit through the existing `executeAssistantCommit` with no new write path;
- a frozen crop can be saved to a job with a server-verified hash;
- nothing about the image remains on the server 24 hours after the session ends, except saved evidence.

---

## 23. Open-branch reconciliation (read 2026-09-24)

Sixteen open branches overlap Live Assist. None is merged into `main`. The rows say what each supplies, and
what this design now does about it. "PR" is given only where a number was found.

### 23.1 Capture, evidence and domain hand-offs

| Branch | What it carries | Effect on this design |
|---|---|---|
| `claude/mobile-hardware-scanner-mzp1e1` (one commit on `main`) and `…-v2327` (the same work redone on an unrelated history, with fixes) | A client `ScanSession` (not persisted, no server table); `captureQuality` verdicts `acceptable` / `unjudged` / `reshoot` over platform-reported signals; device OCR and barcode **interfaces** with no engine; `scanAutoLink` (proposes a tracking-number link, never links); `scanReview` checklist; a read-only `paperwork` (or `scanning`) router. No camera acquisition, no UI, no model call. The first version gates review on `compliance.read`, which drivers do not hold; the rework adds `paperwork.read` | Reuse the verdict vocabulary and the "advises, never confiscates" rule in the sampler (§13.1), with a separate floor set for frames; reuse `scanAutoLink` and `scanReview` for photographed tickets instead of a second matcher or checklist; follow its `available()` + `NotOnDeviceError` adapter pattern for LA-5. Its on-device-only reading policy is D-12. Its `ScanSession` is a different thing from a Live Assist session and keeps its name |
| `claude/driver-portfolio-credential-wallet-ya8928` (PR #16) and `claude/driver-portfolio-api-ya8928` (stacked, no PR) | Requirement bindings, an append-only portfolio event log, and a `driverPortfolio.*` API whose `submitCredential` takes an `evidenceRecordId` and writes a `needs_review` credential; `credentialVerify` refuses the operator and the submitter | The certificate-photo hand-off in §10 |
| `claude/fleet-equipment-portfolio-design-3d13d5` | Design only: `units` as the canonical asset, holds, components, meters, photo-purpose `role` values; `fleet.holdRelease` in `NEVER_AUTONOMOUS` | Photo-purpose roles for saved unit photos (§10) |
| `claude/mechanic-portal-domain-82efa9` | Design only: AI never sets severity; a six-step return to service; CP7 adds a `maintenanceDefect` evidence target and a `shop.evidenceRead` viewer | Defect links go to the unit until CP7 (§7.3) |
| `claude/leaseos-records-file-manager-bqgyjk` | `records.files.list/get/download`: per-record authorization, not-found for anything not visible, a signed URL and an `evidenceAccessEvents` row | The evidence viewer (S-10); frames saved under domain record types (§15, D-14) |
| `claude/leaseos-sign-attest-design-5993ar` | Design only: server-recomputed hashes, one canonical payload, a hash-chained event table with triggers | §7.3 step 4 already follows its rule; the D-09 chain reuses its shape rather than a new canonicalizer |

### 23.2 AI layer, security and tenancy

| Branch | What it carries | Effect on this design |
|---|---|---|
| `claude/secretary-model-dialogue-yzszcv` (PR #7) | The fail-closed `LlmProvider` (text only), `RunProvenance` with prompt and input hashes, injection fences and `scanForInjection`, a dialogue machine, typed tools with `NEVER_AUTONOMOUS` enforced, and the moratorium document, whose carve-out option is limited to "no new AI capability, no new tools wired" | D-13; `RunProvenance` gains a frame hash; §5 S-6 uses its fences; the moratorium ruling for Live Assist must be separate from its carve-out |
| `claude/document-control-design-imsd3n` | An owner ruling recorded 2026-09-24 for Document Control only: carve out the checkpoints that are spine record-layer work, defer OCR and the rest, "every new module reached or declared", and the AI worker-boundary ruling kept separate | The template for D-01. LA-1 is not spine work, so under that template it would stay deferred unless the owner rules otherwise |
| `claude/leaseos-code-audit-yvggvw` | Security headers (camera and microphone for self), an outbound-HTTP guard with a host allowlist and timeouts (not yet applied to AI calls), a 25 MB tRPC limit, JSON-only mutations, and a backlog with a Wave 0 feature freeze and AI-001 to AI-008 | §0.2, §17; the vision adapter's vendor calls go through the outbound guard |
| `claude/leaseos-platform-architecture-uyd8gs` | HS5 client contract headers; drain-only installs may call only evidence upload, seal, sync and auth; `UploadReceipt`; `SessionScope` | Web is exempt; native Live Assist sends the headers; a 426 means "Live Assist unavailable, upgrade"; saves return an `UploadReceipt`-shaped result |
| `feature/tenant-scope-foundation` (unrelated history) | Nullable `orgRef` on 13 tables (not `evidenceRecords`); per-uploader `clientCaptureRef` uniqueness; a per-user acting-organization selection | The `la:` capture reference relies on per-uploader uniqueness; a selection change in another tab must end the session (`org_changed`) and is tested |
| `claude/leaseos-security-architecture-f2j1vn` | SEC-0 to SEC-18. SEC-1 items 7 and 8 (per-uploader capture refs; storage-key ownership), SEC-2 server-side sessions, SEC-6 classification (RESTRICTED excluded from AI, HIGHLY_RESTRICTED never), SEC-11 audit triggers, SEC-12 AI hardening, and a shared redaction layer | Preconditions in the LA-1 plan; S-4 uses the shared redactor rather than its own; until SEC-2, "logout ends the session" is enforced by the client and by the per-call re-check only |
| `docs/identity-secrets-architecture` | A competing server-side session table (`sessionFamilies`) with 15-minute access tokens; does not cover the AI vendor key | §6.2 binds to whichever session table the owner picks; assume up to 15 minutes of residual access after revocation |
| `claude/leaseos-trust-governance-fx7v2x` | Survey only: `monitoringNotices` cannot be issued by anything yet; AI prompts and outputs have no retention class; proposed `governanceReceipts` | D-08 needs the notice procedures mounted first; D-05's purge period follows the retention-class decision rather than being set here |

### 23.3 Migration numbers

Claimed on open branches at the time of reading: `0168`–`0173` (tenant scope, unregistered, colliding with
`main`), `0172`–`0175` (training academy), `0175`–`0177` (driver portfolio), `0175` (identity sessions,
planned), `0178`–`0183` (document control, with SQL for `0182`/`0183`), `0179` (ELD and PR #17),
`0182`–`0184` (sign-and-attest and governance, planned). The first number no branch claimed was `0185`.
The rule stays: take the number when the PR opens, check every remote branch, and record the check.


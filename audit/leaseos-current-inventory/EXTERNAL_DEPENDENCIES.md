# LeaseOS — external dependencies and blockers

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only.

Everything here is blocked on something that is **not code**: a key, a licence, a person, a device or a
platform. For each: what is needed, why, what already exists, and what remains blocked.

---

## 1. AI / LLM provider — **BLOCKED on an endpoint and key**

- **Needed**: `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY`.
- **Why**: `server/_core/llm.ts` is a hand-written OpenAI-shaped HTTP client (458 lines). `assertApiKey()` throws when the key is absent. `package.json` contains **no** LLM SDK — not `openai`, `anthropic`, `langchain`, `@ai-sdk`, `ollama` or any equivalent.
- **Exists**: the client, the prompt builder, the output-schema builder, the proposal pipeline (`assistantProposals`, `commitState: "awaiting_readback"`), `assistantExtraction.ts`, `assistantCommitService.ts`, and exactly one call site (`server/routers.ts:691` — voice transcript → structured form proposal).
- **Blocked**: every AI path. `modelGateway` is declared unwired with the reason *"no AI provider is configured yet"*.

## 2. Owner notification service — **BLOCKED on the same endpoint**

- **Needed**: the same two Forge variables.
- **Why**: `notifyOwner()` (`_core/notification.ts:64`) throws `"Notification service URL is not configured"` / `"...API key is not configured"` before it ever sends.
- **Exists**: payload validation, the POST, one caller (`system.notifyOwner`, `adminProcedure`).
- **Blocked**: the only outbound notification path in the system.

## 3. SMS / email / push — **NOT IMPLEMENTED**

- **Needed**: a provider and an integration that does not exist. No Twilio, SendGrid, Mailgun, SMTP, nodemailer, FCM, APNs or web-push dependency; the only `sms` matches in the tree are two string literals.
- **Exists**: nothing. In-app surfaces only.
- **Blocked**: driver alerts, document-expiry warnings, HOS warnings, dispatch notifications by any channel other than in-app. The repository's roadmap lists *"Customer alerts by email or SMS (in-app only today)"* under **Product not built**.

## 4. Alberta 511 — **BLOCKED on written permission (P6.3, P2.2)**

- **Needed**: written permission for commercial use.
- **Why**: register row **P2.2 is the only row in the register explicitly marked BLOCKED**. P6.3: *"Store written permission (or decline) for 511 Alberta commercial use"* — OPEN.
- **Exists**: source seed `ab511` in `externalSourceSeeds.ts` with `status: "unverified"`; the feed machinery (`feedIngest`, `feedCollector`, `feedHttp`, `feedScheduler`) exists and is **declared unwired because the scheduler is never started**.
- **Blocked**: live road closures, incidents and conditions.

## 5. AER (ST37 / ST102 / ST107) — **BLOCKED on written permission (P6.8)**

- **Needed**: AER written permission to mirror ST107, and confirmation of ST37/ST102 terms.
- **Exists**: three source seeds (`aer_st37`, `aer_st102`, `aer_st107`), the licence text reference *"AER Terms of Use / Copyright and Disclaimer"*, the facility directory (`facilitySourceLicences`, `facilityImportRuns`, `facilityEvidence`) and the ArcGIS importer (`_core/arcgisImport.ts`).
- **Blocked**: authoritative well and facility mirroring. P6.10 additionally requires re-verifying one facility's operating status by hand; P6.11 requires verifying 17 waste-stream vocabulary rows against AER Directive text.

## 6. Provincial data licences — **BLOCKED / UNVERIFIED**

`server/_core/externalSourceSeeds.ts` declares **21 sources; 13 carry `status: "unverified"`**.

| Source | Purpose |
|---|---|
| `osm`, `nrn`, `canvec` | base road network |
| `ats`, `ats_road_allowance` | Alberta Township System / LSD |
| `drivebc_open511` | BC road events |
| `msc_geomet`, `cwfis` | weather, wildfire |
| `sk_iris` | Saskatchewan wells — **P6.9 OPEN**: confirm the IRIS / Standard Unrestricted Use Data Licence |
| `mb_petroleum` | Manitoba petroleum |
| `bc_resource_road_maps` | BC resource roads |
| `ised_*` (4 sources) | radio spectrum / licensing |
| `statcan_boundaries`, `crtc_coverage` | boundaries, coverage |

**Blocked**: province-wide routing (P2.1), commercial mapping resources (P2.4), radio/comms verification (P2.5).

## 7. Commercial mapping / routing engines — **NOT DEPLOYED (P2.1, P2.4)**

- **Needed**: Valhalla and/or HERE deployment and licences.
- **Exists**: the pure graph engines (`osmImport`, `osmTopology`, `osmLoad`, `osmLoadPlan`), validated against Alberta's 508 807 routable ways / 536 506 junctions per their own headers — **all four declared unwired**. `valhalla` appears as a string in the source seeds.
- **Blocked**: the roadmap states *"the graph only works inside imported areas; Valhalla and HERE not deployed"*.

## 8. Android — **NOT IMPLEMENTED (P1.1)**

- **Needed**: a Capacitor shell, four plugins (`@capacitor-community/sqlite`, `@capacitor/filesystem`, `capacitor-secure-storage-plugin`, `@capacitor/camera`, `@capacitor/geolocation`), a signing identity, and Play Store enrolment.
- **Exists**: `client/src/runtime/adapters/capacitor.ts` — 53 lines in which every binding throws `NotOnDeviceError`. Its header states what *"must be true on the device, and cannot be proven here"*: SQLCipher encryption at rest, hardware-backed keystore attestation, biometrics never leaving the platform authenticator.
- **Blocked**: no `android/` directory, no Capacitor dependency, plugins not installed. Encrypted local storage, camera evidence capture, GPS, biometric signing and offline field use all depend on this.

## 9. iOS / App Store — **NOT IMPLEMENTED**

No `ios/` directory, no Apple tooling, no register row. Nothing exists.

## 10. LoadSense hardware — **BLOCKED on devices (P4.2)**

- **Exists**: persistence (`loadSenseScaleReconciliations`, `materialDensityProfiles`) and two engines (`loadSenseMaterialMovement`, `loadSenseEvents`), both declared unwired *"device ingestion does not emit it yet"*.
- **Blocked**: volume/weight telemetry from real hardware.

## 11. Hosting, database and DNS — **EXTERNAL, and undescribed in the repository**

- **Needed**: a host, `DATABASE_URL`, TLS, domain and DNS.
- **Exists**: nothing describing any of it. The repo's own `audit/hardening-2026-09-21/REMEDIATION.md:188` records that there is *"no Dockerfile, no compose file, no `.env` or `.env.example`, no platform manifest, no Terraform, no Kubernetes, no deployment document… The whole production database configuration is one runtime variable, `DATABASE_URL`, supplied by the host."*
- **Blocked**: it cannot be determined from this repository whether a production deployment exists at all. The roadmap lists *"no deploy, backup or restore runbooks"* as an open item.

## 12. HOS regulatory verification — **BLOCKED on a person (P6.1, P6.4, P6.5, P0.8)**

Each requires a qualified human reading a regulation, not code:

- **P6.1** verify `CA_FEDERAL_SOUTH60.daily_drive_minutes` against its clause;
- **P0.8 / P6.5** `CA_FEDERAL_NORTH60.daily_on_duty_minutes` — **"STILL CONTESTED in the seed"**;
- **P6.4** confirm the s.6.7 clock anchor (dated vs received) against the regulator.

**Exists**: the HOS registry, promotion ledger, separation-of-duties gate (`limitPromote` refuses the recorder of an unverified candidate) and the `/hos-verification` console. The values themselves are unverified.

## 13. TDG s.6.2 coverage mapping — **BLOCKED on authoring and approval (P6.2)**

The evidence modules are built (P0.2 DONE). The first real coverage mapping has not been authored and approved.

## 14. Legal / licensing review — **BLOCKED on people (P4.5, P6.6)**

- P4.5 legal/licensing generally; `docs/legal/LEGAL_DOCUMENT_REGISTER.md` exists.
- P6.6: confirm the approval-ladder role mapping seeded in `0133`/`0136`.

## 15. P8.4 safety ceilings — **BLOCKED on an owner decision**

- **Exists**: the full mechanism. `SafetyCeiling` type, level ordering, clamp-and-report in the resolver, `safetyCeilingApplied` recorded on every policy row, and `automationPolicySurface.test.ts:67` pinning `SAFETY_CEILINGS = {}` so the list cannot be decided by inference.
- **Blocked**: which capabilities may never run AUTO. The register's P8.4 row and the roadmap's *"Automation safety floor"* both sit under owner decisions.
- **Note**: the automation mode currently has **no operational consumer** (`committedProvenance` is called only from its own test), so a ceiling today constrains what may be *recorded as policy*, not what any engine does.

## 16. Owner product decisions — **BLOCKED on a person**

From `docs/register/ROADMAP_2026-09-21.md` → *"Waiting on an owner decision"*: where service codes live; the baseline window; the binder requirement set per jurisdiction; the automation safety floor; **and the product name — "LeaseOS or BighornOS"**.

## 17. Six-month field pilot — **BLOCKED on operations**

The register's *"Only a person can close"* section: each HOS figure verified against its clause; written 511 Alberta and AER permissions; and *"the six-month pilot, with every workflow change versioned"*.

---

## Dependency vulnerabilities

`pnpm audit` reports **110 findings (2 critical, 39 high, 61 moderate, 8 low)** against the current
lockfile. **The repository has no dependency, SAST or secret scanning in CI** — the roadmap lists this
as an open item. This is a standing external/tooling gap, not a code defect, and nothing in this audit
changed `package.json` or `pnpm-lock.yaml`.

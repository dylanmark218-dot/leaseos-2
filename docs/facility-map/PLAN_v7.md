# Disposal Facility Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-backed, tenant-safe disposal facility map with verified contacts, explicit coordinate precision, fail-closed load compatibility, commercial-route review, and Google/Apple navigation handoffs.

**Architecture:** Extend the canonical `facilities` record with normalized operator, capability, evidence, alias, and assessment tables. A pure compatibility engine and pure navigation-link builder serve authenticated tRPC procedures and a single map/list UI contract; seed imports remain unverified until evidence review.

**Tech Stack:** TypeScript 5.9, React 19, tRPC 11, Zod 4, Drizzle ORM/MySQL, Google Maps JavaScript API, Vitest 2, Vite 7.

**Spec:** `docs/superpowers/specs/2026-09-17-disposal-facility-map-design.md`

## Global Constraints

- Coordinates use WGS84 decimal degrees and always carry precision and provenance.
- Approximate, community-only, unknown, stale, or conflicting evidence fails closed.
- Google Maps and Apple Maps are external navigation handoffs, never commercial-route authorization.
- Domestic septage, hydrovac slurry, industrial fluids, hazardous solids, and ordinary commercial waste remain distinct.
- Contact values and links are source-labelled; absent facts stay unknown.
- No secrets, dependency directories, caches, or generated build output enter the checkpoint ZIP.

## File Structure

- `shared/facilities.ts`: shared enums and transport-safe facility contracts.
- `server/_core/facilityCompatibility.ts`: pure compatibility decision engine.
- `server/_core/facilityNavigation.ts`: pure, encoded external navigation links.
- `server/_core/facilitySeed.ts`: validate and normalize reviewed seed records.
- `server/_core/facilityCompatibility.test.ts`: fail-closed engine tests.
- `server/_core/facilityNavigation.test.ts`: handoff encoding and gate tests.
- `server/_core/facilitySeed.test.ts`: coordinate/provenance validation tests.
- `data/western-canada-facilities.json`: reviewed source records and unresolved leads.
- `data/western-canada-facilities.geojson`: derived interchange export.
- `data/western-canada-facilities.csv`: derived tabular export.
- `drizzle/schema.ts`: normalized persistent records.
- `drizzle/0012_facility_directory.sql`: forward migration.
- `server/db.ts`: scoped facility/evidence/assessment persistence.
- `server/routers.ts`: authenticated facility procedures.
- `server/facilities.router.test.ts`: auth, scoping, filtering, and decision receipts.
- `client/src/pages/DisposalDirectory.tsx`: map/list workspace and actions.
- `client/src/lib/facilityLinks.ts`: browser/Android handoff adapter.
- `client/src/pages/DisposalDirectory.test.tsx`: interaction tests.
- `research_disposal_sources.md`: authoritative sources and claim audit.
- `docs/FACILITY_DATA_AUDIT.md`: per-location disposition and evidence report.

---

### Task 1: Shared contracts and database migration

**Files:**
- Create: `shared/facilities.ts`
- Modify: `drizzle/schema.ts`
- Create: `drizzle/0012_facility_directory.sql`
- Test: `server/_core/facilitySeed.test.ts`

**Interfaces:**
- Produces: `CoordinatePrecision`, `WasteCode`, `AcceptanceStatus`, `FacilityRecord`, and `FacilityMapFeature`.
- Produces tables: `facilityOperators`, `facilityCapabilities`, `facilityEvidence`, `facilityAliases`, `loadFacilityAssessments`.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { coordinatePrecisionSchema, facilityRecordSchema } from "../../shared/facilities";

it("rejects coordinates without precision and provenance", () => {
  expect(() => facilityRecordSchema.parse({ facilityKey: "x", name: "X", latitude: 53, longitude: -117 })).toThrow();
});
it("accepts all five precision values", () => {
  for (const value of ["verified_entrance", "verified_site", "approximate_site", "community_only", "unknown"])
    expect(coordinatePrecisionSchema.parse(value)).toBe(value);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm vitest run server/_core/facilitySeed.test.ts`
Expected: FAIL because `shared/facilities.ts` does not exist.

- [ ] **Step 3: Add shared schemas and table definitions**

```ts
export const coordinatePrecisionSchema = z.enum(["verified_entrance", "verified_site", "approximate_site", "community_only", "unknown"]);
export const acceptanceStatusSchema = z.enum(["verified", "confirmation_required", "not_accepted", "unknown"]);
export const compatibilityOutcomeSchema = z.enum(["compatible_verified", "facility_confirmation_required", "incompatible", "insufficient_information"]);
```

Add foreign keys and indexes for operator, facility, waste code, status, province, evidence review state, and assessment load/facility IDs. Extend `facilities` with stable key, address components, coordinate metadata, dispatch/email/site/account/place links, account flags, confidence, and status date.

- [ ] **Step 4: Write the forward-only SQL migration and verify schema generation**

Run: `pnpm drizzle-kit generate`
Expected: generated SQL matches the five new tables and facility columns; reconcile it into `0012_facility_directory.sql` without destructive drops.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run server/_core/facilitySeed.test.ts && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/facilities.ts drizzle/schema.ts drizzle/0012_facility_directory.sql server/_core/facilitySeed.test.ts
git commit -m "feat: add facility directory data model"
```

### Task 2: Fail-closed compatibility engine

**Files:**
- Create: `server/_core/facilityCompatibility.ts`
- Test: `server/_core/facilityCompatibility.test.ts`

**Interfaces:**
- Consumes: `WasteCode`, `AcceptanceStatus`, `CoordinatePrecision`.
- Produces: `assessFacilityCompatibility(input: FacilityAssessmentInput): FacilityAssessmentResult`.

- [ ] **Step 1: Write the decision-table tests**

```ts
it.each([
  ["domestic_septage", "hydrovac_slurry", "incompatible"],
  ["hydrovac_slurry", "domestic_septage", "incompatible"],
  ["produced_water", "produced_water", "compatible_verified"],
])("matches %s against %s", (loadWasteCode, capabilityWasteCode, outcome) => {
  expect(assessFacilityCompatibility(verifiedInput({ loadWasteCode, capabilityWasteCode })).outcome).toBe(outcome);
});
it.each(["approximate_site", "community_only", "unknown"])("blocks %s coordinates", precision => {
  expect(assessFacilityCompatibility(verifiedInput({ coordinatePrecision: precision })).outcome).toBe("insufficient_information");
});
```

Also test stale evidence, explicit rejection precedence, missing load classification, account/pre-approval requirements, conflicting evidence, and reason-code stability.

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm vitest run server/_core/facilityCompatibility.test.ts`
Expected: FAIL because the engine is absent.

- [ ] **Step 3: Implement a deterministic engine**

```ts
export type FacilityAssessmentResult = {
  outcome: CompatibilityOutcome;
  reasonCodes: string[];
  blocking: boolean;
  evidenceIds: number[];
  engineVersion: "facility-compatibility/1";
};
```

Evaluate explicit rejection, identity/coordinate validity, evidence conflict and age, exact waste-code match, acceptance state, account approval, hours, and route-review state in that order.

- [ ] **Step 4: Run focused and full core tests**

Run: `pnpm vitest run server/_core/facilityCompatibility.test.ts server/_core/disposalReconciliation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/_core/facilityCompatibility.ts server/_core/facilityCompatibility.test.ts
git commit -m "feat: add fail-closed facility compatibility engine"
```

### Task 3: Navigation and contact handoffs

**Files:**
- Create: `server/_core/facilityNavigation.ts`
- Create: `client/src/lib/facilityLinks.ts`
- Test: `server/_core/facilityNavigation.test.ts`

**Interfaces:**
- Produces: `buildFacilityLinks(facility): FacilityLinks` with `googleDirections`, `googlePlace`, `appleDirections`, `androidIntent`, `tel`, `mailto`, `website`, and `accountRegistration`.

- [ ] **Step 1: Write failing encoding and safety tests**

```ts
it("prefers verified entrance coordinates", () => {
  const links = buildFacilityLinks({ entrance: { lat: 53.1, lon: -117.2 }, site: { lat: 53, lon: -117 } });
  expect(links.googleDirections).toContain("destination=53.1%2C-117.2");
});
it("does not build directions for community-only coordinates", () => {
  expect(buildFacilityLinks({ precision: "community_only", site: { lat: 53, lon: -117 } }).googleDirections).toBeNull();
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run server/_core/facilityNavigation.test.ts`
Expected: FAIL because `buildFacilityLinks` is absent.

- [ ] **Step 3: Implement URL builders with `URL`/`URLSearchParams`**

Use `https://www.google.com/maps/dir/?api=1&destination=<lat,lon>` and `https://maps.apple.com/?daddr=<lat,lon>&dirflg=d`. Build `geo:`/Google intent only in the client adapter; retain HTTPS fallback.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run server/_core/facilityNavigation.test.ts && pnpm check`
Expected: PASS.

```bash
git add server/_core/facilityNavigation.ts server/_core/facilityNavigation.test.ts client/src/lib/facilityLinks.ts
git commit -m "feat: add verified facility contact and map handoffs"
```

### Task 4: Research and reviewed seed dataset

**Files:**
- Create: `data/western-canada-facilities.json`
- Create: `server/_core/facilitySeed.ts`
- Modify: `server/_core/facilitySeed.test.ts`
- Modify: `research_disposal_sources.md`
- Create: `docs/FACILITY_DATA_AUDIT.md`

**Interfaces:**
- Produces: `validateFacilitySeed(records): SeedValidationResult` and `toMapFeatures(records)`.
- The audit accounts for every named location in the approved brief.

- [ ] **Step 1: Add failing whole-dataset invariants**

```ts
it("accounts for every approved location lead", () => {
  expect(validateFacilitySeed(seed).unaccountedSourceNames).toEqual([]);
});
it("requires sources for coordinates and contacts", () => {
  expect(validateFacilitySeed(seed).errors).toEqual([]);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run server/_core/facilitySeed.test.ts`
Expected: FAIL until the approved source names and records are complete.

- [ ] **Step 3: Verify every lead against primary sources**

Search operator facility pages, Alberta/Saskatchewan/BC regulators, municipal utilities, county landfill pages, and official acquisition notices. Store retrieval dates, exact URLs, claim types, and coordinate precision. Record ambiguous items such as generic “Regional Landfill,” service contractors, and city hubs in the audit rather than manufacturing a facility pin.

- [ ] **Step 4: Populate records and unresolved dispositions**

Each record contains `sourceBriefNames`, stable key, operator, aliases, facility type, address, coordinates/precision/source, contacts/source, capabilities/evidence, restrictions, and review state. Community-only coordinates are discovery aids and `routable: false`.

- [ ] **Step 5: Run dataset tests**

Run: `pnpm vitest run server/_core/facilitySeed.test.ts`
Expected: PASS with zero validation errors and zero unaccounted source names.

- [ ] **Step 6: Commit**

```bash
git add data/western-canada-facilities.json server/_core/facilitySeed.ts server/_core/facilitySeed.test.ts research_disposal_sources.md docs/FACILITY_DATA_AUDIT.md
git commit -m "data: add reviewed western Canada facility registry"
```

### Task 5: Tenant-scoped persistence and API

**Files:**
- Modify: `server/db.ts`
- Modify: `server/routers.ts`
- Create: `server/facilities.router.test.ts`

**Interfaces:**
- Produces tRPC procedures: `facilities.list`, `facilities.detail`, `facilities.mapFeatures`, `facilities.assess`, `facilities.reviewEvidence`, and `facilities.export`.
- `assess` persists the immutable engine input/output snapshot.

- [ ] **Step 1: Write failing authentication and isolation tests**

```ts
it("rejects anonymous facility access", async () => {
  await expect(anonymousCaller.fieldRoute.compliance.facilities.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
it("does not expose another tenant's private evidence", async () => {
  expect(await tenantB.fieldRoute.compliance.facilities.detail({ facilityKey: tenantAKey })).toBeNull();
});
```

Add viewport filtering, enum filtering, invalid coordinate, evidence review, and immutable assessment receipt tests.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run server/facilities.router.test.ts`
Expected: FAIL because procedures do not exist.

- [ ] **Step 3: Implement scoped DB readers/writers and Zod inputs**

Map queries accept bounded `north/south/east/west`, limit 1–500, and controlled filters. Administrative review requires the existing authorization pattern; never accept client-supplied verification timestamps as trusted review.

- [ ] **Step 4: Run router and regression tests**

Run: `pnpm vitest run server/facilities.router.test.ts server/fieldroute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db.ts server/routers.ts server/facilities.router.test.ts
git commit -m "feat: expose scoped facility registry API"
```

### Task 6: Interactive directory and map

**Files:**
- Modify: `client/src/pages/DisposalDirectory.tsx`
- Modify: `client/src/components/Map.tsx`
- Create: `client/src/pages/DisposalDirectory.test.tsx`

**Interfaces:**
- Consumes: `facilities.mapFeatures`, `facilities.detail`, and `FacilityLinks`.
- Produces filterable pins, detail drawer, contact actions, and route-review-first navigation.

- [ ] **Step 1: Write failing interaction tests**

Test that approximate pins show a warning and no directions button; selecting a verified entrance exposes call/site/Google buttons; clicking Google before route review opens the LeaseOS route review; filters change the query; missing contact values render “Not published.”

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run client/src/pages/DisposalDirectory.test.tsx`
Expected: FAIL against the current static directory.

- [ ] **Step 3: Replace static seeds with the shared map contract**

Add clustered markers, precision styling, list synchronization, viewport querying, accessible buttons, and filters for province/operator/type/waste/status/verification/precision/account requirement.

- [ ] **Step 4: Add the detail drawer and guarded handoffs**

Display all source-labelled contacts, evidence age, acceptance decision, documents, restrictions, entrance/site coordinates, copy controls, call/email/site/account actions, and the commercial-navigation warning.

- [ ] **Step 5: Run UI tests, typecheck, and build**

Run: `pnpm vitest run client/src/pages/DisposalDirectory.test.tsx && pnpm check && pnpm build`
Expected: PASS and build exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/DisposalDirectory.tsx client/src/components/Map.tsx client/src/pages/DisposalDirectory.test.tsx
git commit -m "feat: add disposal facility map workspace"
```

### Task 7: Workflow, offline, and export integration

**Files:**
- Modify: `server/_core/disposalReconciliation.ts`
- Modify: `server/_core/disposalReconciliation.test.ts`
- Modify: `server/routers.ts`
- Create: `server/_core/facilityExport.ts`
- Create: `server/_core/facilityExport.test.ts`
- Create: `data/western-canada-facilities.csv`
- Create: `data/western-canada-facilities.geojson`

**Interfaces:**
- Disposal reconciliation consumes a persisted `loadFacilityAssessmentId`.
- Exports preserve precision, routability, verification state, and source dates.

- [ ] **Step 1: Write failing reconciliation, cache, and export tests**

```ts
it("holds disposal billing when facility eligibility is not verified", () => {
  expect(reconcileDisposal(input({ facilityOutcome: "facility_confirmation_required" })).releaseDisposalCharge).toBe(false);
});
it("GeoJSON never marks approximate pins routable", () => {
  expect(toGeoJson([approximateFacility]).features[0].properties.routable).toBe(false);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run server/_core/disposalReconciliation.test.ts server/_core/facilityExport.test.ts`
Expected: FAIL until integration and exporters exist.

- [ ] **Step 3: Implement billing gate, offline snapshot, and exporters**

Include facility identity, entrance coordinate/precision, decision outcome/reasons, evidence timestamp, gate instructions, required documents, contacts, and conflict state in the assigned-trip cache. Generate CSV with RFC 4180 quoting and GeoJSON `Point` features only for valid coordinates.

- [ ] **Step 4: Generate deterministic exports and rerun tests**

Run: `pnpm vitest run server/_core/disposalReconciliation.test.ts server/_core/facilityExport.test.ts && pnpm check`
Expected: PASS; rerunning export generation yields no Git diff.

- [ ] **Step 5: Commit**

```bash
git add server/_core/disposalReconciliation.ts server/_core/disposalReconciliation.test.ts server/_core/facilityExport.ts server/_core/facilityExport.test.ts server/routers.ts data/western-canada-facilities.csv data/western-canada-facilities.geojson
git commit -m "feat: connect facility decisions to records and exports"
```

### Task 8: Full verification and v7 checkpoint

**Files:**
- Create: `CHECKPOINT_v7.md`
- Create: `SHA256SUMS`
- Create outside repo: `leaseos-fieldroute-v7.zip`

**Interfaces:**
- Produces a reproducible release record and clean source ZIP.

- [ ] **Step 1: Run the complete verification gate**

Run: `pnpm test && pnpm check && pnpm build`
Expected: all tests pass, TypeScript exits 0, production build exits 0.

- [ ] **Step 2: Audit requirements and source coverage**

Run: `pnpm vitest run server/_core/facilitySeed.test.ts server/_core/facilityCompatibility.test.ts server/_core/facilityNavigation.test.ts server/facilities.router.test.ts server/_core/facilityExport.test.ts client/src/pages/DisposalDirectory.test.tsx`
Expected: PASS; audit reports zero unaccounted source names.

- [ ] **Step 3: Scan for secrets and excluded content**

Run: `git status --short && find . -type d \( -name node_modules -o -name .cache -o -name dist \) -prune -print && rg -n "(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AIza[0-9A-Za-z_-]{30,}|sk_live_)" . --glob '!pnpm-lock.yaml'`
Expected: clean Git state before checkpoint documentation; no secret matches. Remove `dist` from the archive input, not with a destructive broad command.

- [ ] **Step 4: Write checkpoint evidence and hashes**

Record commit, migration, exact test counts, build result, dataset record/disposition counts, known limitations, and rollback instructions in `CHECKPOINT_v7.md`. Generate file hashes with `find ... -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS` while excluding `.git`, dependencies, caches, build output, and the checksum file itself.

- [ ] **Step 5: Commit checkpoint metadata**

```bash
git add CHECKPOINT_v7.md SHA256SUMS
git commit -m "chore: record verified v7 facility-map checkpoint"
```

- [ ] **Step 6: Build and inspect the ZIP**

Run from the parent directory: `zip -qr leaseos-fieldroute-v7.zip leaseos-fieldroute-v7 -x '*/.git/*' '*/node_modules/*' '*/dist/*' '*/.cache/*' && unzip -t leaseos-fieldroute-v7.zip`
Expected: archive integrity test reports no errors.

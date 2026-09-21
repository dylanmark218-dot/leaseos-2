# feature/facility-map-v7 → integration/reconciled-2026-09-16 — reconciliation matrix

The v7 checkpoint forked off the original base (migrations 0000–0011 byte-identical to this lineage) and added one migration, `0012_facility_directory.sql`. This lineage already had a different 0012, its own `facilities` table (P3), organization links made by a person (0134) and facility statements (0135). Rule 34: do not overlay; compare and choose.

| v7 | This lineage | Chosen | Migration / test |
|---|---|---|---|
| `drizzle/0012_facility_directory.sql` (new tables incl. its own `facilities`) | `facilities` exists since P3, with `orgRef` (0134) and statements (0135) | **One `facilities` table, extended** with key, province, type, municipality, legal location, coordinate precision + source + verifier, disposition, regulator ref, website, account URL. Child tables re-based. | `0139`; `facilityDirectory.db.test` |
| `facilityOperators` table + `operatorKey` | `organizations` + `disposal_facility` role (0133); links are a person's act (0134) | **No operators table.** The source's operator name is kept as `operatorNameFromSource`; linking to an organization goes through `commercialOffice.links.set` / `links.candidates` (exact-name proposal, human confirm). | — |
| `facilityEvidence` (publisher, url, claim, review state) | none | **Kept, plus `licenceKey` and `cachedContent`.** A licence register (`facilitySourceLicences`) seeded from the 2026-09-17 registry research; caching content a licence forbids is refused by name (AER, Manitoba). | `0139`; test "refuses to cache content under the AER's copyright" |
| `facilityCapabilities`, `facilityAliases`, `loadFacilityAssessments` | none | **Kept.** A verified acceptance needs reviewed `accepts_waste_stream` evidence; assessments are immutable rows with engine version and input snapshot. | `0139` |
| Engines: compatibility, navigation, export, seed (+19 tests) | none | **Ported byte-faithfully** (only import paths). All 19 tests pass unchanged. | `server/_core/facility*.ts` |
| `shared/facilities.ts` (zod schemas) | `shared/` had no such file | **Copied.** | — |
| Seed compiled into the client as a fallback | — | **Server-side `facilityDirectory.seedLeads`**, review permission, idempotent, refuses any seed row claiming verified coordinates. | test "imports the 23 v7 leads as leads" |
| `client/src/pages/*` (v7-era pages) | pages have moved on since v7 | **Left behind.** The map/list workspace is P5 UI work on the current screens; the API is complete. | — |
| 55 shared files with v7 versions | current versions | **Not overlaid.** | — |
| Waste vocabulary (17 internal codes, enum) | none | **Kept as the enum; a `wasteStreamVocabulary` table maps internal codes to AER Directive 047/058 terms as CANDIDATES** until a person verifies each against the directive text (new edition effective 2026-06-04). | `0139` |

Safety posture unchanged from v7: no seed record is a verified entrance; community-level coordinates are discovery aids; directions links exist only for verified coordinates; a pin is not disposal authorization.

# Hash classification — `stableHash` call sites and the migration plan

Checkpoint 0174. This document classifies every use of the Academy's legacy
`stableHash` (`server/_core/trainingAcademy.ts`) and states what replaces it for
new work. **The `stableHash` implementation is unchanged and pinned by tests**
(`server/integrityHash.test.ts`).

## Why `stableHash` is frozen

`stableHash` runs eight FNV-style lanes. It calls `toString(16)` on a value that
`h ^= h >>> 13` can leave negative, so a lane can print as `-7ec38a5a…`. The output
can therefore contain `-` and can be shorter or longer than 64 characters before
the final `slice(0, 64)`. That is not a defined hex format.

Values made with it are persisted, and some are **recomputed and compared**. The
installed `REG-TDG-ROAD-V1` profile hash is
`-7ec38a5a39c754d558518ce62d80fd4428051062-3c2ee1e9046fb74c4996cb`, and
`certificateIssue` refuses a TDG certificate when a fresh computation differs.
"Fixing" the function in place would make every existing database refuse TDG
issuance, mark every module completion stale, and break the Academy audit chain.

## New integrity values: `sha256HexV1`

`server/_core/integrityHash.ts`:

- `canonicalJsonV1(value)`: JSON with object keys sorted at every depth; a `Date` is written as ISO-8601.
- `sha256HexV1(value)`: SHA-256 of that encoding (or of a string as-is). The result is always 64 lowercase hex characters.
- `isSha256HexV1(s)`: format check. It is false for every legacy `stableHash` value that contains `-`.

The `V1` names the encoding. A different encoding would be a new function, never an edit to this one.

Used by (0174): the inspector package hash (`academy.inspectorRequestAssemble`) and the snapshot hash of a proposed new source version (`academy.sourceProposeVersion`).

## Classes

| Class | Meaning | Change allowed? |
|---|---|---|
| **A** | Persisted **and recomputed/compared** later | No. Changing it breaks verification of existing rows |
| **B** | Persisted link in a hash **chain** | No. Changing it breaks chain verification from that point on |
| **C** | Persisted **record-only** fingerprint (stored, never recomputed for a decision) | Not in place. New rows may use a versioned algorithm only with a recorded algorithm tag |
| **D** | Deterministic, **not persisted** (derived at run time) | Technically yes, but it changes behaviour (e.g. question order), so treat as frozen |
| **E** | **Separate local function** that happens to be named `stableHash` | Out of scope; not the Academy function |

## Call sites

| # | Site | What | Class |
|---|---|---|---|
| 1 | `_core/trainingAcademyRegulatory.ts` `regulatoryProfileHash` | Regulatory profile version hash, stored in `academyRegulatoryProfiles.profileHash` and compared at issuance (`trainingAcademyRouter` certificateIssue) | **A** |
| 2 | `_core/credentialLifecycle.ts` `policyHash` | Renewal policy hash, stored in `credentialRenewalPolicies.policyHash` and compared by `syncCredentialPolicies` (mismatch reported) | **A** |
| 3 | `trainingAcademyRouter.ts` install: `moduleHash = stableHash(m)` | Stored in `academyModules.moduleHash` and compared against `academyModuleCompletions.contentVersionHash` (`moduleGate`, staleness) | **A** |
| 4 | `trainingAcademyRouter.ts` install: `courseHash` / `_core/trainingAcademyCatalog.ts` `courseSeedHash` | Course version content hash; decides whether an install creates a new version | **A** |
| 5 | `trainingAcademyRouter.ts` `audit()` `eventHash` | Academy audit chain (`academyAuditEvents.previousHash → eventHash`) | **B** |
| 6 | `trainingWalletService.ts` `academyAudit()` `eventHash` | Same chain, written by wallet, handoff, source and sweep events | **B** |
| 7 | `trainingAcademyRouter.ts` seeded source `snapshotHash` | `academySourceRecords.snapshotHash` for installed seed sources (immutable once decided, 0175 trigger) | **C** |
| 8 | `trainingAcademyRouter.ts` block `contentHash`, question `questionHash` | Content fingerprints on installed blocks and questions | **C** |
| 9 | `trainingAcademyRouter.ts` certificate `policySnapshotHash`, `provisionalHash`, employer/employee signature hashes, `finalHash` | Certificate and signature payload hashes stored on certificates and signatures | **C** (printed on certificates; treat as frozen) |
| 10 | `trainingAcademyRouter.ts` statement-of-experience `payloadHash` | Stored on the statement | **C** |
| 11 | `_core/tdgCertificateContents.ts` `contentHash` | TDG certificate contents fingerprint | **C** |
| 12 | `_core/trainingAcademy.ts` `buildAssessment`: `presentedPromptHash`, `questionSetHash` | Stored on attempts; identifies the presented set | **C** |
| 13 | `_core/trainingAcademy.ts` `seedNumber` | Shuffle seed for question and answer order | **D** |
| 14 | `_core/routingCompiler.ts` local `stableHash(value: string)` | Route profile id | **E** |
| 15 | `_core/dispatchAward.ts` local `stableHash(value: string)` | Evaluation and award ids | **E** |

No **new** 0174 integrity code imports `stableHash`: `integrityHash.ts`,
`complianceOperations.ts`, `renewalOperations.ts` and the new source-version
path. This is enforced by a source scan in `server/integrityHash.test.ts`.
`academyAudit` (site 6) still writes the chain with `stableHash`, because it
extends the existing chain (class B).

## Migration plan (not executed; no destructive conversion)

1. **Now (0174).** New integrity values use `sha256HexV1`. Every legacy value stays byte-for-byte as stored. Readers tell the two apart by format (`isSha256HexV1`); the Source Review screen labels a fingerprint `sha256` or `legacy-stableHash`.
2. **Tag before switching.** Before any class A, B or C site moves to SHA-256, add a nullable `hashAlgorithm` column (`'stableHash-legacy' | 'sha256-v1'`) to that table. Existing rows are backfilled to `'stableHash-legacy'` in an additive migration; values are not rewritten.
3. **Class A.** Compute both for a release: compare with the algorithm the row is tagged with, and write new rows with `sha256-v1`. A profile, policy or module whose content changes gets a new version (the existing rule), so no old row ever needs re-hashing.
4. **Class B (audit chain).** Start a new chain segment. The first `sha256-v1` event's `previousHash` is the last legacy `eventHash`, verbatim, and the verifier switches algorithm at the tagged boundary. The legacy segment is verified with `stableHash` forever.
5. **Class C.** New rows only. Historical certificates keep the hash printed on them.
6. **Class D/E.** No change planned. Changing D reorders historical attempts; E is unrelated.
7. **Rollback.** Every step is additive (a column plus new rows). Rolling back means reading the tag and ignoring `sha256-v1` rows. Nothing legacy is ever lost, because nothing legacy is ever overwritten.

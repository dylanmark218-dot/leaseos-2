# Verification of `COVERAGE_AUDIT.md`

`COVERAGE_AUDIT.md` and `INDEX.md` are filed here as received, unedited. This note records what was
checked against the code before filing, at `cd071c957` (the v23.24 merge). Their author's document is
not rewritten; the corrections live here instead, so both the claim and its check stay readable.

## Confirmed

- **No permits table.** 408 tables, none matching `permit`.
- **The permit gate is three-valued and correct.** `server/_core/dispatchReadiness.ts:385-396` —
  `permitOnFile === false` → `permit_missing`, `=== null` → `permit_unknown`, exactly as quoted.
- **No contacts, emergency contacts, next-of-kin or muster-point tables.** None of the 408 match.
- **Nothing medical.** No `medical`, `fitness` or `health` table.
- **No environmental/spill tables** (Book 10), **no scenario tables**, **no language or translation
  tables**.
- **Placards, SDS and ERAP appear only as training content.** Every non-test occurrence is a quiz
  prompt in `server/_core/trainingAcademyCatalog.ts` (lines 33-35). There is no engine deriving a
  placard, no SDS record and no ERAP registration, which is what the audit says.
- **The 15 mounted documents are present and greppable.** Every `.pdf` has a `.txt` beside it
  carrying extracted text with a provenance header.

## Corrected

### 1. `docs/` holds 18 files, not nine

Seven at the top level and eleven under `b28/`, `facility-map/` and `legal/`. The audit's §0 argument
does not depend on the number — none of the 18 is a policy book — but the number is wrong.

### 2. The permits finding is understated, and in the unsafe direction

§2.1 says "A correct gate fed by nothing returns `UNKNOWN` forever." It does not, because nothing
feeds it `null`. The only production caller hardcodes the question away:

```ts
// server/readinessComposer.ts:401
permitRequired: false,
permitOnFile: null,
```

`permitRequired: false` short-circuits the entire block at `dispatchReadiness.ts:385`. The gate never
returns `permit_unknown`; it never runs. That is fail-open, not a gate waiting on data — dispatch
reads eligible with permits never considered, and no review flag says so.

`requiredDocumentsPresent: job ? true : false` on the line above has the same shape: it asserts the
documents are present whenever a job exists rather than reading whether they are.

Both sit two lines from the pattern done correctly in the same object —
`tdgDocumentPrepared: dangerousGoods ? null : true` and `emergencyPlanOnFile: dangerousGoods ? null : true`
resolve to `null`, and therefore to review, exactly where the answer is unknown. So the fix is not a
new convention; it is applying the one already written beside it, and it is worth doing before the
permits table exists, because `permitRequired: null` reviews while `false` passes.

### 3. `unNumber` exists three times, at two different lengths

| Table | Column |
|---|---|
| `loadProfiles` | `varchar(40)` |
| `manifests` | `varchar(40)` |
| `incidentReports` | `varchar(20)` |

The audit cites only the `varchar(20)`. Three unconstrained free-text fields strengthen its point:
with no reference set, nothing checks any of them against each other, and a UN number recorded on a
load profile can be truncated on its way into an incident report.

### 4. The document count disagrees with itself

`INDEX.md` and `README.md` say roughly 190 documents, 15 mounted and ~175 not. `COVERAGE_AUDIT.md`
says roughly 180, 15 mounted and ~165 not. Both cannot be right, and which is correct can only be
settled where the documents are.

## Standing

The ~165-175 unmounted bodies are still not here — `source/` holds the 15 that were available. The
index is the contract for the rest: anything it marks `SPEC` needs its document fetched before it is
built, not inferred from the index entry.

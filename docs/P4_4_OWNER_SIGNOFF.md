# Owner sign-off — P4.4 AI Secretary Corpus

Recorded 2026-09-18. Reproduced verbatim; the verification beneath it is mine.

---

## The sign-off, as given

> **Owner sign-off — P4.4 AI Secretary Corpus**
>
> I approve and sign off on the P4.4 code architecture and implementation represented by migrations
> 0150 and 0151, gate-green at commit `4626eb6` and carried forward into the current v22.63 branch.
>
> Mark P4.4 CODE COMPLETE / DONE for the software implementation.
>
> I specifically approve the following rules:
>
> - `own_document` requires an accountable `loadedByUserId` and records the person's rights
>   assertion as an assertion, not as proof of legal ownership.
> - `licensed_source` must identify the source and must pass both `rag_ingestion` and
>   `commercial_redisplay` authorization.
> - The authorizing licence assessment must come from the licence gate's stored record and must not
>   be supplied or overridden by the caller.
> - Legacy or `unstated` passages must remain fail-closed and excluded from retrieval, direct
>   passage reads, corpus fingerprints, and library listings until properly classified.
> - Unknown, missing, revoked, or insufficient licensing must never default to permission.
> - The existing write-path tripwire must remain in place so another ungoverned knowledge-ingestion
>   path cannot be introduced silently.
>
> This owner sign-off approves the LeaseOS software design and implementation only.
>
> It **DOES NOT** constitute a legal determination or grant of permission for Alberta 511, AER
> material, standards, regulations, commercial publications, or any other third-party source.
>
> Any real third-party source must remain blocked from ingestion and/or redisplay unless the
> required rights have been independently established and recorded in LeaseOS through the
> source/licence assessment process.
>
> P4.4 may now be closed as code-complete. Third-party licensing decisions remain separate
> human/legal checkpoints.

---

## What was verified before this was recorded

The sign-off names `4626eb6` and says the work is carried forward. That was checked rather than
assumed: every file the approval covers is **byte-identical** between `4626eb6` and `0f29ab40fd78521025ea244606028b8a5681e16b`.

    git diff 4626eb6 0f29ab40fd78521025ea244606028b8a5681e16b -- \
      drizzle/0150_passage_reproduction_basis.sql \
      drizzle/0151_passage_basis_correction.sql \
      server/_core/knowledge/sourceGate.ts \
      server/assistantAskRouter.ts \
      server/knowledgeWritePaths.test.ts \
      server/assistantAskApi.test.ts
    # no output: what was signed is what is on the branch

An approval that named a commit and silently covered different code would be worse than no approval
at all, because it would look like diligence.

## Where each approved rule is enforced, and what fails if it is weakened

| Approved rule | Enforced at | The test that fails |
|---|---|---|
| `own_document` needs an accountable person, recorded as an assertion | `assistant.addPassage`; `rightsAssertion` min 20 chars + `loadedByUserId` | "records the assertion, the person, and no licence"; "refuses an own document with no assertion" |
| `licensed_source` needs the source **and both rights** | `checkAssistantPassageUse` | the two synthetic-licence cases (one right each) and the positive case |
| the assessment comes from the gate's record, never the caller | `stampedAssessment = use.assessmentId` | "permits a source whose assessment authorizes both, and stamps that assessment" |
| `unstated` fails closed on all four read paths | `quotable()` in retrieval, direct read, corpus fingerprint, library listing | "present but unquotable" — re-verified by disabling the filter |
| unknown / missing licensing never defaults to permission | the gate refuses an unassessed source | "refuses a source nobody has assessed"; 511 Alberta still refused |
| the write-path tripwire stays | `server/knowledgeWritePaths.test.ts` | its own four cases — verified by adding a raw-SQL import script under `scripts/` |

## What remains open, by the owner's own terms

No third-party source is licensed by this. 511 Alberta, AER material, standards, regulations and
commercial publications stay refused until rights are independently established and recorded through
the assessment process. The code's default for anything it has not been told about is refusal, and
that is the only default it can safely have.

# Integration Notes

## Current LeaseOS engine fit

The repository's `server/_core/aiProposal.ts` currently uses:

- `FormDefinition = { key, version, title, fields }`
- scalar field types: `time`, `duration`, `quantity`, `text`, `enum`, `boolean`, `number`, `date`
- `precisionSensitive` for quantities/times/dates where approximate values need human confirmation
- schema-constrained extraction: undeclared fields are dropped
- read-back + acknowledgement before commit

This package uses exactly those fields in `compliance_forms.ts`.

## Suggested placement

Copy:

- `form-definitions/compliance_forms.ts` → near `server/_core/aiProposal.ts`
- `form-definitions/compliance_forms.json` → `data/forms/` or your future `formDefinitions` seed source
- `templates/*.md` → your document-rendering template directory
- `reference/regulatory_sources.json` → verified-source registry / compliance source seed

## Suggested next engine step

When `formDefinitions`, `proposals`, and `proposedFields` persistence is added, keep the JSON definition as the source of truth and compile its scalar `fields` subsection to the current `FormDefinition` interface. Preserve the richer `sections`, evidence groups, and repeatable objects for the document renderer.

## Do not hard-code universal legal rules

Use `jurisdiction`, `appliesWhen`, `sourceAuthority`, `sourceUrl`, `effectiveFrom`, and `verificationStatus` around these templates. The existing LeaseOS compliance design explicitly treats regulatory requirements as sourced, versioned rules and keeps unverified requirements from producing a positive compliance result.

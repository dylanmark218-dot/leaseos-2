# LeaseOS Compliance & Permits Document Templates

These templates are designed for the LeaseOS typed-proposal/document workflow visible in the current repository.

## Included documents

1. `dot_fmcsa_registration_authority` — DOT / FMCSA registration and operating-authority record for a commercial motor carrier.
2. `oilfield_waste_tracking_generator` — oilfield waste generator / transporter tracking and chain-of-custody form.
3. `norm_survey_handling` — NORM survey, handling, packaging, transfer, and disposal record.
4. `environmental_spill_report` — environmental release / spill report for oilfield trucking, construction, and well-site activity.

## Engine fit

The TypeScript file in `drop-in/server/_core/compliance_forms.ts` mirrors the repository current `FormDefinition` shape (`key`, `version`, `title`, `fields`) and the field types supported by `server/_core/aiProposal.ts`.

The JSON definitions add document metadata and section groupings for a richer document renderer. The Markdown files are render-ready templates using `{{fieldName}}` placeholders.

## Compliance design

- Jurisdiction is explicit. Oilfield waste, NORM, environmental reporting, and some carrier permissions vary by jurisdiction and operation.
- Regulatory-source records default to `verificationStatus: "unverified"`, consistent with the repository compliance engine.
- The forms record facts, evidence, source documents, reviewer decisions, and signatures; they do not make legal conclusions automatically.
- Quantities, dates, times, readings, weights, and identifiers that can materially affect a record are marked `precisionSensitive` in the engine-compatible definitions.

## Drop-in integration

Copy `drop-in/server/_core/compliance_forms.ts` into the repository at `server/_core/compliance_forms.ts`, then import it beside the existing `FORMS` map:

```ts
import { LEASEOS_COMPLIANCE_FORMS } from "./compliance_forms";

export const FORMS: Record<string, FormDefinition> = {
  ...EXISTING_FORMS,
  ...LEASEOS_COMPLIANCE_FORMS,
};
```

When the future `formDefinitions` persistence layer is added, the JSON definition can be used as the richer source for sections/repeatable groups while compiling its scalar `fields` layer to the current proposal engine.

> This package is a software/document-engine template set, not legal advice and not a substitute for a regulator's prescribed filing or form.

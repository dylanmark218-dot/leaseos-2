/**
 * Builders shared by every content category. A builder takes the section bodies for one document kind
 * and emits them under that kind's skeleton headings, in order, so a pack cannot drift from the catalog.
 */
import type { ContentTemplate } from "../safetyProgramContentTypes";

export const REVISION = "| Version | Date | Change | Prepared by | Approved by |\n|---|---|---|---|---|\n| {{policy.version}} | {{policy.effectiveFrom}} | Initial issue from the LeaseOS Alberta Commercial / Oilfield pack, adapted by {{company.name}} | | |";
export const records = (what: string) => `${what} are controlled records of {{company.name}}: retained under the Document-control and revision policy, available to workers on request, and produced for a regulator, client or auditor when asked. LeaseOS records who acknowledged which version and when.`;
export const NON_COMPLIANCE = "A breach is dealt with under the Policy enforcement and disciplinary process. The response is proportionate and considers whether the person was trained, equipped and supervised to comply. Reporting a hazard, an incident or a near miss in good faith, refusing dangerous work, or stopping unsafe work is never a breach.";

const T = (templateKey: string, summary: string, sections: [string, string][]): ContentTemplate => ({ templateKey, summary, sections: sections.map(([heading, body]) => ({ heading, body })) });

export function policy(key: string, summary: string, b: { purpose: string; scope: string; statement: string; responsibilities: string; requirements: string; records: string; references: string; nonCompliance?: string }) {
  return T(key, summary, [["Purpose", b.purpose], ["Scope", b.scope], ["Policy statement", b.statement], ["Responsibilities", b.responsibilities], ["Requirements", b.requirements], ["Non-compliance", b.nonCompliance ?? NON_COMPLIANCE], ["Records", records(b.records)], ["References", b.references], ["Revision history", REVISION]]);
}

export function procedure(key: string, summary: string, b: { purpose: string; scope: string; definitions: string; responsibilities: string; equipment: string; hazards: string; steps: string; emergency: string; training: string; records: string; references: string }) {
  return T(key, summary, [["Purpose", b.purpose], ["Scope", b.scope], ["Definitions", b.definitions], ["Responsibilities", b.responsibilities], ["Required equipment and PPE", b.equipment], ["Hazards and controls", b.hazards], ["Procedure", b.steps], ["Emergency provisions", b.emergency], ["Training and competency", b.training], ["Records", records(b.records)], ["References", b.references], ["Revision history", REVISION]]);
}

export function form(key: string, summary: string, b: { header: string; fields: string; signoff: string; retention: string }) {
  return T(key, summary, [["Header and identification", `{{company.name}} — {{policy.code}} v{{policy.version}}. ${b.header}`], ["Fields", b.fields], ["Sign-off", b.signoff], ["Retention", `${b.retention} Completed forms are controlled records of {{company.name}} and are kept in LeaseOS against the job, unit or worker they concern.`]]);
}

export function program(key: string, summary: string, b: { purpose: string; scope: string; elements: string; responsibilities: string; implementation: string; evaluation: string; records: string; references: string }) {
  return T(key, summary, [["Purpose", b.purpose], ["Scope", b.scope], ["Program elements", b.elements], ["Responsibilities", b.responsibilities], ["Implementation", b.implementation], ["Evaluation and review", b.evaluation], ["Records", records(b.records)], ["References", b.references], ["Revision history", REVISION]]);
}

export function swp(key: string, summary: string, b: { purpose: string; scope: string; hazards: string; controls: string; practice: string; ppe: string; training: string; references: string }) {
  return T(key, summary, [["Purpose", b.purpose], ["Scope", b.scope], ["Hazards", b.hazards], ["Controls", b.controls], ["Practice", b.practice], ["PPE", b.ppe], ["Training", b.training], ["References", b.references], ["Revision history", REVISION]]);
}

export const ALL_WORKERS = "Every worker, supervisor, manager and contractor of {{company.name}}, at every work site, yard, shop and vehicle.";
export const OHS_REFS = "Alberta Occupational Health and Safety Act, Regulation and Code, as cited by the reference keys linked to this document in LeaseOS.";

/**
 * Document Control — the supplied structured compliance forms, reconciled to
 * the proposal engine's `FormDefinition` (DC-E).
 *
 * The package shipped a JSON definition layer (sections and scalar fields)
 * and a TypeScript drop-in of the same forms. Neither is copied into the
 * engine. The JSON is the source, kept under `data/document-control/reference`
 * with its SHA-256 in `documentSourceArtifacts`; this module compiles its
 * scalar `fields` to the engine's shape at load, refusing any field type the
 * engine does not have, and a test holds the compiled forms against the
 * drop-in's keys and field counts so the two cannot silently drift.
 *
 * These forms are consumed exactly as the existing five are: a form is a
 * typed proposal's slot list. Regulator-derived facts default to unverified
 * in the JSON itself; quantities, dates, readings and identifiers are
 * `precisionSensitive` and the engine forces a precision question for them.
 */
import { readFileSync } from "node:fs";
import { FORMS, type FieldType, type FormDefinition, type FormFieldDef } from "./aiProposal";

export const COMPLIANCE_FORMS_JSON = "data/document-control/reference/leaseos_compliance_templates/leaseos_compliance_templates/data/forms/compliance_forms.json";

const FIELD_TYPES: readonly FieldType[] = ["time", "duration", "quantity", "text", "enum", "boolean", "number", "date"];

type JsonField = { key: string; label: string; type: string; required: boolean; options?: string[]; precisionSensitive?: boolean; unit?: string };
type JsonDefinition = { key: string; version: number; title: string; family: string; packKey: string; ownerType: string; documentType: string; verificationStatus: string; sections: { key: string; title: string; fields: string[] }[]; fields: JsonField[] };
type JsonFile = { schemaVersion: number; engineCompatibility: string; definitions: JsonDefinition[] };

export type CompiledForm = { form: FormDefinition; sections: { key: string; title: string; fields: string[] }[]; family: string; packKey: string; ownerType: string; documentType: string };

export function compileFormDefinition(d: JsonDefinition): CompiledForm {
  const fields: FormFieldDef[] = d.fields.map(fld => {
    if (!FIELD_TYPES.includes(fld.type as FieldType)) throw new Error(`Form ${d.key}: field ${fld.key} has type "${fld.type}", which the proposal engine does not have`);
    const out: FormFieldDef = { key: fld.key, label: fld.label, type: fld.type as FieldType, required: !!fld.required };
    if (fld.options) out.options = fld.options;
    if (fld.precisionSensitive) out.precisionSensitive = true;
    if (fld.unit) out.unit = fld.unit;
    return out;
  });
  const keys = new Set(fields.map(x => x.key));
  for (const s of d.sections) for (const k of s.fields) if (!keys.has(k)) throw new Error(`Form ${d.key}: section ${s.key} names field ${k}, which the form does not define`);
  return { form: { key: d.key, version: d.version, title: d.title, fields }, sections: d.sections, family: d.family, packKey: d.packKey, ownerType: d.ownerType, documentType: d.documentType };
}

let cache: Record<string, CompiledForm> | null = null;
/** The compiled forms, read once from the reference JSON. */
export function documentControlForms(): Record<string, CompiledForm> {
  if (cache) return cache;
  const file = JSON.parse(readFileSync(COMPLIANCE_FORMS_JSON, "utf8")) as JsonFile;
  const out: Record<string, CompiledForm> = {};
  for (const d of file.definitions) {
    if (FORMS[d.key]) throw new Error(`Form ${d.key} collides with an engine form of the same key`);
    out[d.key] = compileFormDefinition(d);
  }
  cache = out;
  return out;
}

/** A form by key: the engine's own first, then the compiled compliance forms. Unknown is unknown — nothing generic. */
export function formFor(key: string): FormDefinition | null {
  return FORMS[key] ?? documentControlForms()[key]?.form ?? null;
}

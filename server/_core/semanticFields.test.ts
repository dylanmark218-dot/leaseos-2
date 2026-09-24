/**
 * Document Control, Checkpoint E — the semantic registry, the standard mappings and the reconciled forms, without a database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { FORMS } from "./aiProposal";
import { COMPLIANCE_FORMS_JSON, documentControlForms, formFor } from "./documentControlForms";
import { STANDARD_MAPPINGS } from "./documentStandardMappings";
import { mappingHash } from "./documentTemplates";
import { authorityOf, autoFillSources, mappingRefusals, SEMANTIC_FIELDS, SEMANTIC_KEY_PATTERN, semanticField } from "./semanticFields";

describe("the semantic registry", () => {
  it("has unique, well-formed keys; every auto_fill key names a real table and column; human_only keys name no source", () => {
    const keys = SEMANTIC_FIELDS.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SEMANTIC_FIELDS) {
      expect(s.key, s.key).toMatch(SEMANTIC_KEY_PATTERN);
      if (s.authority === "auto_fill" || s.authority === "server_only") {
        expect(s.source, s.key).toBeTruthy();
        const [table, column] = s.source!.split(".");
        const t = (schema as Record<string, unknown>)[table!];
        expect(t, `${s.key}: table ${table}`).toBeDefined();
        expect(getTableColumns(t as never)[column!], `${s.key}: column ${table}.${column}`).toBeDefined();
      } else {
        expect(s.source).toBeNull();
      }
    }
    expect(autoFillSources().jobs).toContain("job.jobCode");
    expect(semanticField("operator.name")!.source).toBe("operators.name");
  });

  it("keeps weights, readings, signatures, acceptance and another issuer's number human-only, and the control number server-only", () => {
    for (const k of ["scale.netKg", "reading.value", "signature.customerRepresentative", "acceptance.facility", "external.facilityTicketNumber", "hazard.description"]) expect(authorityOf(k), k).toBe("human_only");
    for (const k of ["document.controlNumber", "document.documentRef", "document.issuedAt"]) expect(authorityOf(k), k).toBe("server_only");
    expect(authorityOf("operator.name")).toBe("auto_fill");
    expect(authorityOf(null)).toBe("human_only");
    expect(authorityOf("driver.fullName")).toBe("human_only");   // not a registry key: a person types it
  });

  it("refuses a mapping that names a key outside the registry or maps a printed field twice", () => {
    expect(mappingRefusals({ version: 1, fields: [{ printedField: "Driver", semanticKey: "driver.fullName" }] })).toEqual([expect.stringMatching(/not in the semantic registry/)]);
    expect(mappingRefusals({ version: 1, fields: [{ printedField: "Driver", semanticKey: "Driver Name" }] })).toEqual([expect.stringMatching(/not a semantic key/)]);
    expect(mappingRefusals({ version: 1, fields: [{ printedField: "Driver", semanticKey: "operator.name" }, { printedField: "Driver", semanticKey: null }] })).toEqual([expect.stringMatching(/mapped twice/)]);
    expect(mappingRefusals({ version: 1, fields: [{ printedField: "Driver", semanticKey: "operator.name" }, { printedField: "Notes", semanticKey: null }] })).toEqual([]);
  });
});

describe("the standard mappings", () => {
  it("cover the representative families, are all valid, and each mixes record-filled and person-supplied fields", () => {
    const keys = Object.keys(STANDARD_MAPPINGS);
    for (const k of ["bill_of_lading", "proof_of_delivery", "job_safety_analysis", "tailgate_meeting_log", "oilfield_load_ticket_load_record", "disposal_ticket_waste_disposal_receipt", "norm_survey_and_handling_record", "environmental_compliance_spill_reporting_form", "oilfield_waste_tracking_generator_compliance_form", "dot_fmcsa_registration_and_authority_record"]) expect(keys).toContain(k);
    for (const [k, m] of Object.entries(STANDARD_MAPPINGS)) {
      expect(mappingRefusals(m), k).toEqual([]);
      const authorities = m.fields.map(f => authorityOf(f.semanticKey));
      expect(authorities, k).toContain("auto_fill");
      expect(authorities.some(a => a === "human_only"), k).toBe(true);
      expect(mappingHash(m)).toMatch(/^[a-f0-9]{64}$/);
    }
    // The same semantic value feeds several forms.
    const usersOfOperator = Object.entries(STANDARD_MAPPINGS).filter(([, m]) => m.fields.some(f => f.semanticKey === "operator.name")).map(([k]) => k);
    expect(usersOfOperator.length).toBeGreaterThanOrEqual(6);
  });

  it("the disposal mapping keeps the facility's number, the weights and the acceptance out of any auto-fill", () => {
    const d = STANDARD_MAPPINGS.disposal_ticket_waste_disposal_receipt!;
    for (const printed of ["Facility ticket no.", "Gross (kg)", "Tare (kg)", "Net (kg)", "Facility acceptance"]) expect(authorityOf(d.fields.find(f => f.printedField === printed)!.semanticKey), printed).toBe("human_only");
    expect(authorityOf(d.fields.find(f => f.printedField === "Disposal facility")!.semanticKey)).toBe("auto_fill");
  });
});

describe("the supplied compliance forms, reconciled", () => {
  it("compile to four engine-shaped forms that match the drop-in's keys and field counts and collide with nothing", () => {
    const forms = documentControlForms();
    expect(Object.keys(forms).sort()).toEqual(["dot_fmcsa_registration_authority", "environmental_spill_report", "norm_survey_handling", "oilfield_waste_tracking_generator"]);
    const dropIn = readFileSync("data/document-control/reference/leaseos_compliance_templates/leaseos_compliance_templates/drop-in/server/_core/compliance_forms.ts.txt", "utf8");
    for (const [key, c] of Object.entries(forms)) {
      expect(dropIn).toContain(`  ${key}: {`);
      const block = dropIn.slice(dropIn.indexOf(`  ${key}: {`), dropIn.indexOf("\n  },", dropIn.indexOf(`  ${key}: {`)));
      expect(c.form.fields.length, key).toBe((block.match(/\{ key: "/g) ?? []).length);
      expect(c.form.version).toBe(1);
      expect(c.form.fields.filter(f => f.precisionSensitive).length, key).toBeGreaterThan(0);
      const vs = c.form.fields.find(f => f.key === "verificationStatus");
      if (vs) expect(vs.options).toContain("unverified");
      expect(FORMS[key]).toBeUndefined();
    }
    expect(JSON.parse(readFileSync(COMPLIANCE_FORMS_JSON, "utf8")).engineCompatibility).toMatch(/FormDefinition/);
    expect(formFor("disposal_ticket")).toBe(FORMS.disposal_ticket);
    expect(formFor("norm_survey_handling")!.title).toMatch(/NORM/);
    expect(formFor("nothing_of_the_kind")).toBeNull();
  });
});

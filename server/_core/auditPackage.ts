/**
 * Audit packages — the engines.
 *
 * A package is a manifest over items the chain already holds. Each item is
 * a canonical row (or a stored document's hash) named with its source; the
 * kind's redaction policy removes fields and LISTS each removal; the kind's
 * completeness rule names what should be present and is not. The manifest
 * is canonical JSON and its hash is the package. Release is by a second
 * person, and an incomplete package is released only with its gaps
 * acknowledged, gap by gap in the release note.
 */
import { createHash } from "node:crypto";

export type PackageKind = "vehicle" | "driver" | "job" | "customer" | "incident" | "tax" | "cor" | "insurance";

export type RawItem = { itemKind: string; sourceTable: string; sourceId: number; sourceRef: string | null; title: string; row: Record<string, unknown>; storageKey?: string | null; storedHash?: string | null };
export type ManifestItem = { seq: number; itemKind: string; sourceTable: string; sourceId: number; sourceRef: string | null; title: string; contentHash: string; storageKey: string | null; redactions: string[] };

/** What each kind withholds, by field name pattern and by item kind. Listed on every item it touches. */
export const REDACTION_POLICIES: Readonly<Record<PackageKind, { policy: string; fields: RegExp; itemKinds: RegExp | null; reason: string }>> = {
  vehicle: { policy: "vehicle_v1", fields: /^(technicianUserId|reportedBy|byUserId|acknowledgedByUserId|preparedByUserId)$/, itemKinds: null, reason: "internal user ids withheld; identities appear by role and identifier" },
  driver: { policy: "driver_v1", fields: /^(privateDetail|contactJson|note|recommendationNote|decisionNote)$/, itemKinds: /^(medical|hr_)/, reason: "medical and HR detail withheld — released separately by HR" },
  job: { policy: "job_v1", fields: /^(payrollProposalId|internalNote)$/, itemKinds: null, reason: "payroll linkage withheld" },
  customer: { policy: "customer_v1", fields: /^(byUserId|operatorId|sourceTripStopId|clock|payrollProposalId|technician|detail)$/, itemKinds: /^(internal_|company_activity)/, reason: "contractor-private activity, identities and clocks withheld" },
  incident: { policy: "incident_v1", fields: /^(contactJson|privateDetail)$/, itemKinds: /^(medical|hr_)/, reason: "medical and HR detail withheld" },
  tax: { policy: "tax_v1", fields: /^(preparedByUserId|reviewedByUserId|finalizedByUserId)$/, itemKinds: null, reason: "preparer identities withheld; roles appear" },
  cor: { policy: "cor_v1", fields: /^(userId|approvedByUserId|acknowledgedBy|voiceTranscript|contactJson|privateDetail)$/, itemKinds: /^(medical|hr_)/, reason: "worker identities appear by employee number where the audit requires; voice transcripts and medical detail withheld" },
  insurance: { policy: "insurance_v1", fields: /^(openedByUserId|coverageVerifiedByUserId|annualPremium|contactJson)$/, itemKinds: /^(medical|hr_|customer_rate)/, reason: "premium, identities and medical detail withheld" },
};

/** What each kind should contain. A required kind with no items is a named gap. */
export const COMPLETENESS: Readonly<Record<PackageKind, { itemKind: string; label: string }[]>> = {
  vehicle: [{ itemKind: "inspection_credential", label: "Current inspection credential" }, { itemKind: "work_order", label: "Work orders in period" }, { itemKind: "mechanic_release", label: "Mechanic releases for closed work" }],
  driver: [{ itemKind: "licence_credential", label: "Licence credential" }, { itemKind: "training", label: "Verified training" }, { itemKind: "duty_record", label: "Duty records in period" }],
  job: [{ itemKind: "field_ticket", label: "Field ticket" }, { itemKind: "ticket_revision", label: "Signed revision (R1)" }, { itemKind: "signature", label: "Site signature" }, { itemKind: "disposal_ticket", label: "Disposal ticket for every load" }],
  customer: [{ itemKind: "field_ticket", label: "Field ticket" }, { itemKind: "ticket_revision", label: "Signed revision (R1)" }, { itemKind: "ticket_document", label: "Rendered ticket document" }],
  incident: [{ itemKind: "incident", label: "Incident record" }],
  tax: [{ itemKind: "gst_return", label: "GST/HST return (finalized or filed)" }, { itemKind: "ifta_return", label: "IFTA return (finalized or filed)" }],
  cor: [{ itemKind: "written_program", label: "Approved written program versions" }, { itemKind: "program_acknowledgement", label: "Program acknowledgements" }, { itemKind: "tailgate", label: "Tailgate meetings in period" }, { itemKind: "inspection", label: "Inspections in period" }, { itemKind: "training", label: "Verified training in period" }, { itemKind: "incident", label: "Incidents in period (or a statement that there were none)" }],
  insurance: [{ itemKind: "policy", label: "Policies in force with coverage verification" }, { itemKind: "claim", label: "Claims in period" }, { itemKind: "incident", label: "Incidents in period" }],
};

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v instanceof Date ? v.toISOString() : v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function redact(kind: PackageKind, item: RawItem): { row: Record<string, unknown>; redactions: string[]; withheld: boolean } {
  const p = REDACTION_POLICIES[kind];
  if (p.itemKinds && p.itemKinds.test(item.itemKind)) return { row: {}, redactions: [`item withheld (${item.itemKind}): ${p.reason}`], withheld: true };
  const row: Record<string, unknown> = {}; const redactions: string[] = [];
  for (const [k, v] of Object.entries(item.row)) { if (p.fields.test(k)) redactions.push(`${k}: withheld — ${p.reason}`); else row[k] = v; }
  return { row, redactions, withheld: false };
}

export function assemble(kind: PackageKind, items: readonly RawItem[]): { manifest: { kind: PackageKind; policy: string; items: ManifestItem[]; withheld: { itemKind: string; sourceRef: string | null; reason: string }[]; missing: { itemKind: string; label: string }[]; itemCount: number; redactionCount: number }; manifestJson: string; manifestHash: string } {
  const out: ManifestItem[] = []; const withheld: { itemKind: string; sourceRef: string | null; reason: string }[] = [];
  let seq = 0, redactionCount = 0;
  for (const it of items) {
    const r = redact(kind, it);
    if (r.withheld) { withheld.push({ itemKind: it.itemKind, sourceRef: it.sourceRef, reason: r.redactions[0]! }); redactionCount++; continue; }
    redactionCount += r.redactions.length;
    out.push({ seq: ++seq, itemKind: it.itemKind, sourceTable: it.sourceTable, sourceId: it.sourceId, sourceRef: it.sourceRef, title: it.title, contentHash: it.storedHash ?? sha256(canonicalJson(r.row)), storageKey: it.storageKey ?? null, redactions: r.redactions });
  }
  const present = new Set(out.map(i => i.itemKind));
  const missing = COMPLETENESS[kind].filter(c => !present.has(c.itemKind));
  const manifest = { kind, policy: REDACTION_POLICIES[kind].policy, items: out, withheld, missing, itemCount: out.length, redactionCount };
  const manifestJson = canonicalJson(manifest);
  return { manifest, manifestJson, manifestHash: sha256(manifestJson) };
}

export function releaseDecision(args: { status: string; preparedByUserId: number; releaserUserId: number; missing: readonly { label: string }[]; acknowledgeGaps: boolean; note: string }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.status !== "prepared") r.push(`Package is ${args.status} — only a prepared package is released`);
  if (args.preparedByUserId === args.releaserUserId) r.push("The preparer may not release their own package");
  if (args.missing.length && !args.acknowledgeGaps) r.push(`Package is incomplete — ${args.missing.map(m => m.label).join("; ")} — release only with the gaps acknowledged`);
  if (args.missing.length && args.acknowledgeGaps && !args.missing.every(m => args.note.toLowerCase().includes(m.label.toLowerCase().slice(0, 12)))) r.push("Acknowledging gaps means naming each in the release note");
  if (args.note.trim().length < 10) r.push("A release needs a note: who it goes to and why");
  return { permitted: r.length === 0, refusals: r };
}

/**
 * v23.31 — the pure rules of the Customer / Contract / Rate domain, without a row.
 */
import { describe, expect, it } from "vitest";
import {
  billableContextOf, canonicalJson, chooseVersionAt, commercialReadiness, contractTransition, contractUsable, fieldSubsetOf, requiredReferenceKinds, rowVersionCheck, snapshotHash,
  supersessionWindow, versionContentHash, versionTransition, type SnapshotPayload,
} from "./_core/commercialLifecycle";
import { CONFIDENTIAL_COMMERCIAL_FIELDS } from "../shared/commercialVocabulary";

const d = (s: string) => new Date(s);

describe("contract lifecycle", () => {
  it("walks draft → pending_approval → active → suspended → active → terminated, and refuses every other step", () => {
    expect(contractTransition("draft", "submit")).toEqual({ ok: true, to: "pending_approval" });
    expect(contractTransition("pending_approval", "approve")).toEqual({ ok: true, to: "active" });
    expect(contractTransition("pending_approval", "reject")).toEqual({ ok: true, to: "draft" });
    expect(contractTransition("active", "suspend")).toEqual({ ok: true, to: "suspended" });
    expect(contractTransition("suspended", "resume")).toEqual({ ok: true, to: "active" });
    expect(contractTransition("active", "terminate")).toEqual({ ok: true, to: "terminated" });
    expect(contractTransition("active", "expire")).toEqual({ ok: true, to: "expired" });
    for (const [from, ev] of [["draft", "approve"], ["draft", "activate"], ["terminated", "resume"], ["superseded", "suspend"], ["expired", "resume"], ["active", "submit"]] as const) {
      const t = contractTransition(from, ev); expect(t.ok, `${from} ${ev}`).toBe(false); if (!t.ok) expect(t.reason).toMatch(new RegExp(`${from} contract cannot ${ev}`));
    }
  });
  it("a contract governs only while active and inside its window", () => {
    const c = { status: "active" as const, effectiveFrom: d("2026-01-01"), effectiveTo: d("2026-12-31") };
    expect(contractUsable(c, d("2026-06-15")).usable).toBe(true);
    expect(contractUsable(c, d("2027-01-15")).usable).toBe(false);
    expect(contractUsable({ ...c, status: "suspended" }, d("2026-06-15"))).toMatchObject({ usable: false, reason: "contract is suspended" });
    expect(contractUsable({ ...c, effectiveTo: null }, d("2031-01-01")).usable).toBe(true);
  });
});

describe("rate sheet version lifecycle", () => {
  it("draft → pending → approved → superseded; rejected reopens to draft; approved may retire", () => {
    expect(versionTransition("draft", "submit")).toEqual({ ok: true, to: "pending_approval" });
    expect(versionTransition("pending_approval", "approve")).toEqual({ ok: true, to: "approved" });
    expect(versionTransition("pending_approval", "reject")).toEqual({ ok: true, to: "rejected" });
    expect(versionTransition("rejected", "reopen")).toEqual({ ok: true, to: "draft" });
    expect(versionTransition("approved", "supersede")).toEqual({ ok: true, to: "superseded" });
    expect(versionTransition("approved", "retire")).toEqual({ ok: true, to: "retired" });
    expect(versionTransition("superseded", "approve").ok).toBe(false);
    expect(versionTransition("draft", "approve").ok).toBe(false);
  });
  const v = (version: number, status: "draft" | "pending_approval" | "approved" | "rejected" | "superseded" | "retired", from: string, to: string | null) => ({ id: version, versionRef: `RSV-${version}`, version, status, effectiveFrom: d(from), effectiveTo: to ? d(to) : null });
  it("chooses the version whose window covers the date — a superseded version still prices its own window", () => {
    const versions = [v(1, "superseded", "2026-01-01", "2026-07-01"), v(2, "approved", "2026-07-01", null)];
    const june = chooseVersionAt(versions, d("2026-06-15"));
    expect(june.outcome).toBe("resolved"); if (june.outcome === "resolved") expect(june.version.version).toBe(1);
    const august = chooseVersionAt(versions, d("2026-08-15"));
    expect(august.outcome).toBe("resolved"); if (august.outcome === "resolved") expect(august.version.version).toBe(2);
  });
  it("a future version is not today's rate, an expired one is not tomorrow's, and a draft prices nothing", () => {
    const none = chooseVersionAt([v(1, "approved", "2027-01-01", null), v(2, "draft", "2026-01-01", null)], d("2026-06-15"));
    expect(none.outcome).toBe("none");
    expect(none.reasons.join(" ")).toMatch(/take effect after/); expect(none.reasons.join(" ")).toMatch(/not yet approved/); expect(none.reasons.join(" ")).toMatch(/NO RATE SHEET VERSION GOVERNS/);
    const expired = chooseVersionAt([v(1, "approved", "2025-01-01", "2025-12-31")], d("2026-06-15"));
    expect(expired.outcome).toBe("none"); expect(expired.reasons.join(" ")).toMatch(/expired before/);
  });
  it("two approved versions over one date is a CONFLICT a person resolves — never 'the newest'", () => {
    const c = chooseVersionAt([v(1, "approved", "2026-01-01", null), v(2, "approved", "2026-03-01", null)], d("2026-06-15"));
    expect(c.outcome).toBe("conflict"); if (c.outcome === "conflict") expect(c.candidates.map(x => x.version)).toEqual([1, 2]);
  });
  it("a new version starts after the one it supersedes, and closes the prior window where it opens", () => {
    expect(supersessionWindow({ effectiveFrom: d("2026-01-01"), effectiveTo: null }, { effectiveFrom: d("2026-01-01") }).ok).toBe(false);
    const w = supersessionWindow({ effectiveFrom: d("2026-01-01"), effectiveTo: null }, { effectiveFrom: d("2026-07-01") });
    expect(w).toEqual({ ok: true, priorEffectiveTo: d("2026-07-01") });
    const early = supersessionWindow({ effectiveFrom: d("2026-01-01"), effectiveTo: d("2026-03-31") }, { effectiveFrom: d("2026-07-01") });
    expect(early).toEqual({ ok: true, priorEffectiveTo: d("2026-03-31") });
  });
  it("the content hash is order-independent and changes when a rate changes", () => {
    const line = (lineNo: number, rateMillis: number) => ({ lineNo, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour", rateMillis, flatCents: null, basisPoints: null, multiplierMillis: null, minimumQuantityMillis: 4000, minimumChargeCents: null, billingIncrementMillis: 250, roundingMode: "nearest", measurementBasis: "any", conditionKey: null, applicabilityJson: null, resourceClass: null, unitId: null, effectiveFrom: d("2026-01-01"), effectiveTo: null });
    const a = versionContentHash([line(1, 185_000), line(2, 95_000)]);
    expect(versionContentHash([line(2, 95_000), line(1, 185_000)])).toBe(a);
    expect(versionContentHash([line(1, 215_000), line(2, 95_000)])).not.toBe(a);
  });
});

describe("required references and the commercial gate", () => {
  const account = { status: "active" as const, holdReason: null, requiresPurchaseOrder: true, requiresAfe: false, requiredReferenceKindsJson: JSON.stringify(["cost_centre"]), archivedAt: null };
  it("unions the account's booleans, its list and the contract's list; the contract may switch the PO off", () => {
    expect(requiredReferenceKinds(account, null)).toEqual(["cost_centre", "po"]);
    expect(requiredReferenceKinds(account, { status: "active", effectiveFrom: d("2026-01-01"), effectiveTo: null, poRequirement: "inherit", requiredReferenceKindsJson: JSON.stringify(["afe"]) })).toEqual(["afe", "cost_centre", "po"]);
    expect(requiredReferenceKinds(account, { status: "active", effectiveFrom: d("2026-01-01"), effectiveTo: null, poRequirement: "not_required", requiredReferenceKindsJson: null })).toEqual(["cost_centre"]);
    expect(requiredReferenceKinds({ ...account, requiresPurchaseOrder: false }, { status: "active", effectiveFrom: d("2026-01-01"), effectiveTo: null, poRequirement: "required", requiredReferenceKindsJson: null })).toEqual(["cost_centre", "po"]);
    expect(requiredReferenceKinds({ ...account, requiredReferenceKindsJson: "not json" }, null)).toEqual(["po"]);
  });
  const base = { account, contract: null, references: [{ referenceKind: "cost_centre", referenceValue: "CC-9" }], waiver: null, emergency: false, snapshot: { status: "current" as const }, sheetChoice: "resolved" as const, at: d("2026-06-15") };
  it("a missing required reference blocks dispatch; a recorded waiver or an emergency posting makes it a review item", () => {
    const b = commercialReadiness(base);
    expect(b).toEqual([expect.objectContaining({ code: "commercial_reference_missing", severity: "blocking", subject: "job", overridable: true, overrideAuthority: "manager" })]);
    expect(b[0]!.label).toMatch(/missing: po/);
    expect(commercialReadiness({ ...base, waiver: { reason: "call-out at 02:00, PO to follow" } })[0]).toMatchObject({ code: "commercial_reference_missing", severity: "review" });
    expect(commercialReadiness({ ...base, emergency: true })[0]).toMatchObject({ code: "commercial_reference_missing", severity: "review" });
    expect(commercialReadiness({ ...base, references: [...base.references, { referenceKind: "po", referenceValue: "PO-1" }] })).toEqual([]);
    expect(commercialReadiness({ ...base, references: [...base.references, { referenceKind: "po", referenceValue: "   " }] })[0]?.code).toBe("commercial_reference_missing");
  });
  it("no customer is a review item, never a stop; a hold or an archived account is a stop only management lifts", () => {
    expect(commercialReadiness({ ...base, account: null })).toEqual([expect.objectContaining({ code: "commercial_context_missing", severity: "review" })]);
    expect(commercialReadiness({ ...base, account: { ...account, status: "on_hold", holdReason: "90 days overdue" }, references: [{ referenceKind: "po", referenceValue: "P" }, { referenceKind: "cost_centre", referenceValue: "C" }] })).toEqual([expect.objectContaining({ code: "commercial_account_on_hold", severity: "blocking", overrideAuthority: "manager", label: expect.stringMatching(/90 days overdue/) })]);
    expect(commercialReadiness({ ...base, account: { ...account, archivedAt: d("2026-01-01") }, references: [{ referenceKind: "po", referenceValue: "P" }, { referenceKind: "cost_centre", referenceValue: "C" }] })[0]?.code).toBe("commercial_account_inactive");
  });
  it("an unusable contract, an unresolved sheet and a missing snapshot each say so", () => {
    const refs = [{ referenceKind: "po", referenceValue: "P" }, { referenceKind: "cost_centre", referenceValue: "C" }];
    expect(commercialReadiness({ ...base, references: refs, contract: { status: "suspended", effectiveFrom: d("2026-01-01"), effectiveTo: null, poRequirement: "inherit", requiredReferenceKindsJson: null } })[0]).toMatchObject({ code: "commercial_contract_not_usable", severity: "blocking" });
    expect(commercialReadiness({ ...base, references: refs, sheetChoice: "conflict" })[0]).toMatchObject({ code: "commercial_rate_sheet_unresolved", severity: "review", overrideAuthority: "manager" });
    expect(commercialReadiness({ ...base, references: refs, sheetChoice: "none" })[0]).toMatchObject({ code: "commercial_rate_sheet_unresolved", severity: "review" });
    expect(commercialReadiness({ ...base, references: refs, snapshot: null })[0]).toMatchObject({ code: "commercial_snapshot_missing", severity: "review" });
    expect(commercialReadiness({ ...base, references: refs, sheetChoice: "not_selected" })).toEqual([]);
  });
});

const payload = (): SnapshotPayload => ({
  schema: "job-commercial-snapshot/1",
  job: { id: 42, jobCode: "JOB-2026-000042" },
  customer: { accountRef: "CUST-A", customerNumber: "CN-2026-000007", name: "Bighorn Energy", legalName: "Bighorn Energy Ltd.", tradeName: null, customerType: "producer_operator", status: "active", taxStatus: "taxable", gstNumber: "123456789RT0001", billingAddress: { line1: "1 Main" }, physicalAddress: null, defaultCurrency: "CAD", paymentTermsDays: 45, requiresPurchaseOrder: true, requiresAfe: false, requiredReferenceKinds: [] },
  billTo: { accountRef: "CUST-A", name: "Bighorn Energy", billingAddress: { line1: "1 Main" }, paymentTermsDays: 45 },
  contract: { contractRef: "CTR-1", contractNumber: "MSA-2026-014", title: "MSA", contractType: "msa", version: 1, status: "active", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, poRequirement: "inherit", paymentTermsDays: 30, billingInstructions: "Attach signed ticket", customerReferences: null },
  terms: null,
  rateSheet: { rateSheetRef: "RSH-1", name: "2026 rates", sheetNumber: "RSHT-2026-000001", currency: "CAD", versionRef: "RSV-1", version: 1, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, contentHash: "abc", definitions: [
    { definitionRef: "CHG-1", version: 1, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", lineNo: 1, label: "Hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 185_000, flatCents: null, basisPoints: null, multiplierMillis: null, minimumQuantityMillis: 4000, minimumChargeCents: null, billingIncrementMillis: 250, roundingMode: "nearest", measurementBasis: "any", conditionKey: null, applicabilityJson: null, scopeLevel: "customer_contract", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, sourceClause: "§4.1" },
    { definitionRef: "CHG-2", version: 1, serviceCode: "disposal", lineKind: "disposal_pass_through", lineNo: 2, label: "Disposal", pricingMethod: "percentage_markup", unit: "m3", rateMillis: null, flatCents: null, basisPoints: 1500, multiplierMillis: null, minimumQuantityMillis: null, minimumChargeCents: null, billingIncrementMillis: null, roundingMode: "nearest", measurementBasis: "facility_ticket", conditionKey: null, applicabilityJson: null, scopeLevel: "customer_contract", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, sourceClause: null },
  ] },
  purchaseOrder: null,
  references: [{ referenceKind: "afe", referenceValue: "AFE-8841-22" }],
  parties: [{ partyRole: "consultant_company", customerAccountRef: "CUST-C", customerName: "Consultants Inc", contactRef: null, contactName: null, orgRef: null, freeText: null, linked: true }, { partyRole: "site_contact", customerAccountRef: null, customerName: null, contactRef: "CT-1", contactName: "Kyle", orgRef: null, freeText: null, linked: true }],
  contacts: [{ contactRef: "CT-1", displayName: "Kyle", company: "Consultants Inc", title: "Company man", phone: "403-555-0100", mobile: null, email: "kyle@example.test", roles: ["field_consultant"], partyRole: "site_contact" }],
  requiredReferenceKinds: ["po"], missingReferenceKinds: ["po"], waiver: null,
  effective: { paymentTermsDays: 30, currency: "CAD", poRequired: true, billingInstructions: "Attach signed ticket" },
  capturedAt: "2026-06-15T12:00:00.000Z",
});

describe("the snapshot and what is read from it", () => {
  it("hashes canonically: key order does not matter, a rate does", () => {
    const a = payload(); const b = payload();
    (b as unknown as Record<string, unknown>).job = { jobCode: "JOB-2026-000042", id: 42 };
    expect(snapshotHash(a)).toBe(snapshotHash(b));
    const c = payload(); c.rateSheet!.definitions[0]!.rateMillis = 215_000;
    expect(snapshotHash(c)).not.toBe(snapshotHash(a));
    expect(canonicalJson({ b: 1, a: [new Date("2026-01-01T00:00:00Z"), undefined, null] })).toBe('{"a":["2026-01-01T00:00:00.000Z",null,null],"b":1}');
  });
  it("the field subset carries the customer, the references and the people on site — and not one price term", () => {
    const f = fieldSubsetOf({ snapshotRef: "JCS-1", payloadHash: "h", payload: payload() });
    expect(f).toMatchObject({ jobCode: "JOB-2026-000042", customer: { name: "Bighorn Energy", customerNumber: "CN-2026-000007" }, contractNumber: "MSA-2026-014", missingReferenceKinds: ["po"] });
    expect(f.contacts).toEqual([expect.objectContaining({ displayName: "Kyle", phone: "403-555-0100", partyRole: "site_contact" })]);
    expect(f.parties).toEqual([{ partyRole: "consultant_company", name: "Consultants Inc" }]);
    const text = JSON.stringify(f);
    for (const k of CONFIDENTIAL_COMMERCIAL_FIELDS) expect(text, k).not.toContain(`"${k}"`);
    expect(text).not.toContain("185"); expect(text).not.toContain("billingAddress"); expect(text).not.toContain("gstNumber");
  });
  it("the billable context reads the snapshot and names its blockers and the paper it needs", () => {
    const b = billableContextOf({ jobId: 42, snapshotRef: "JCS-1", sequenceNo: 1, payloadHash: "h", capturedAt: new Date("2026-06-15T12:00:00Z"), payload: payload() }, ["signed_field_ticket", "purchase_order_on_file", "disposal_ticket", "time_record"]);
    expect(b.applicableRates.map(r => r.rateMillis)).toEqual([185_000, null]);
    expect(b.paymentTermsDays).toBe(30); expect(b.poRequired).toBe(true); expect(b.billTo.accountRef).toBe("CUST-A");
    expect(b.blockers).toEqual([{ code: "reference_missing", detail: "Required before billing: po" }]);
    expect(b.supportingDocumentRequirements).toContain("disposal_ticket");
    const noSheet = billableContextOf({ jobId: 42, snapshotRef: "JCS-1", sequenceNo: 1, payloadHash: "h", capturedAt: new Date(), payload: { ...payload(), rateSheet: null, missingReferenceKinds: [] } }, []);
    expect(noSheet.blockers.map(x => x.code)).toEqual(["no_rate_sheet_version"]); expect(noSheet.applicableRates).toEqual([]);
  });
  it("optimistic concurrency: the version the caller read must be the version that is there", () => {
    expect(rowVersionCheck(undefined, 3)).toEqual({ ok: true });
    expect(rowVersionCheck(3, 3)).toEqual({ ok: true });
    const stale = rowVersionCheck(2, 3); expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.reason).toMatch(/version 3, you had 2/);
  });
});

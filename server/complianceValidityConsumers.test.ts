/**
 * SPINE item 2 — one answer to "is this compliance document in force", read by every consumer.
 *
 * `complianceRequirementValidity` (over `documentValidity.validityOf`) is the only place that
 * decides. Dispatch, the documentExpiry tile, the insurance proof and medical fitness each MAP its
 * verdict. These cases pin three things:
 *
 *   1. the verdict itself, on the record shapes that separate a real evaluator from a date check;
 *   2. each consumer's mapping, fed nothing but that verdict;
 *   3. equivalence: the same rows, asked through each consumer's own entry point, reach the same
 *      verdict — presentation differs, the underlying state does not.
 *
 * The "mutation" cases are the record sets on which each retired inline copy answered differently
 * (latest date wins, first row wins, no expiry means current, needs_review is merely a flag). A
 * consumer that quietly re-derived validity would fail at least one of them.
 */
import { describe, expect, it } from "vitest";
import {
  complianceRequirementValidity, documentExpiry, type ComplianceDocumentRow, type ComplianceVerdict,
} from "./_core/complianceDocumentValidity";
import type { ValidityState } from "./_core/documentValidity";
import { assessCoverage, INSURANCE_PROOF_DOC_TYPES, proofFromDocuments, type PolicyRecord } from "./_core/insuranceRisk";
import { candidateVerdict, evaluateRequirement, MEDICAL_FITNESS_DOC_TYPES, medicalFitnessForDispatch, type Credential, type Requirement } from "./_core/compliancePassport";
import { evaluateWorkContext, type WorkContext } from "./_core/requirementEngine";
import { operatorIdFromRecord } from "./_core/operatorIdentity";
import { OWNER_DOCUMENT_LIST_CAP } from "./db";
import { widgetReaderFor } from "./widgetSources";

// Clock-relative: the tile cases below read the real clock, so no fixed fixture date is allowed to age.
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

type Spec = { status: ComplianceDocumentRow["verificationStatus"]; expires: number | null; issued?: number | null; captured: number; id?: number };
const rows = (docType: string, specs: readonly Spec[]): ComplianceDocumentRow[] =>
  specs.map((s, i) => ({
    id: s.id ?? i + 1, docType, title: `${docType} ${i + 1}`,
    issuedAt: s.issued == null ? null : days(s.issued), expiresAt: s.expires == null ? null : days(s.expires),
    verificationStatus: s.status, capturedAt: days(s.captured),
  }));

/**
 * The record sets. `expect` is the canonical state; `naive` is what a latest-expiry / newest-row
 * reading would have concluded, kept so the table says why each case is here.
 */
const CASES: { name: string; specs: Spec[]; expect: ValidityState; lapsed?: boolean; naive: string }[] = [
  { name: "verified and in force", specs: [{ status: "verified", expires: 200, captured: -30 }], expect: "in_force", naive: "valid" },
  { name: "verified, expiring inside the notice window", specs: [{ status: "verified", expires: 10, captured: -30 }], expect: "expiring", naive: "valid" },
  { name: "verified and expired", specs: [{ status: "verified", expires: -3, captured: -300 }], expect: "expired", naive: "expired" },
  { name: "verified, effective date not reached", specs: [{ status: "verified", expires: 400, issued: 5, captured: -1 }], expect: "not_yet_effective", naive: "valid (date in future)" },
  { name: "verified, no expiry recorded", specs: [{ status: "verified", expires: null, captured: -30 }], expect: "incomplete", naive: "current (no date means never expires)" },
  { name: "only uploaded, date in future", specs: [{ status: "needs_review", expires: 400, captured: -1 }], expect: "unverified", naive: "valid (date in future)" },
  { name: "only uploaded, its own date already past", specs: [{ status: "needs_review", expires: -2, captured: -1 }], expect: "unverified", lapsed: true, naive: "expired" },
  { name: "only rejected", specs: [{ status: "rejected", expires: 400, captured: -1 }], expect: "rejected", naive: "valid (date in future)" },
  {
    name: "superseded: an older verified row with a later date, then a newer verified correction that has expired",
    specs: [{ status: "verified", expires: 400, captured: -30 }, { status: "verified", expires: -5, captured: -1 }],
    expect: "expired", naive: "valid (latest date wins)",
  },
  {
    name: "a verified row in force beside a newer upload with a later date",
    specs: [{ status: "verified", expires: 100, captured: -30 }, { status: "needs_review", expires: 800, captured: -1 }],
    expect: "in_force", naive: "the upload (latest date wins)",
  },
  {
    name: "a verified row in force beside a newer rejected row",
    specs: [{ status: "verified", expires: 100, captured: -30 }, { status: "rejected", expires: 800, captured: -1 }],
    expect: "in_force", naive: "the rejected row (first by date)",
  },
  {
    name: "renewal verified but not yet effective, the current one still in force",
    specs: [{ status: "verified", expires: 20, captured: -300 }, { status: "verified", expires: 385, issued: 20, captured: -1 }],
    expect: "expiring", naive: "the renewal",
  },
];

describe("the canonical verdict on the record shapes that matter", () => {
  it.each(CASES)("$name → $expect", ({ specs, expect: state, lapsed }) => {
    const v = complianceRequirementValidity(rows("driver_licence", specs), ["driver_licence"], NOW);
    expect(v.state).toBe(state);
    expect(v.claimLapsed).toBe(lapsed ?? false);
  });

  it("nothing on file is none, and names no document", () => {
    expect(complianceRequirementValidity([], ["driver_licence"], NOW)).toMatchObject({ state: "none", documentId: null, claimLapsed: false });
  });

  it("names the row the verdict stands on — the older verified row, not the newer upload", () => {
    const v = complianceRequirementValidity(rows("driver_licence", [
      { status: "verified", expires: 100, captured: -30, id: 41 },
      { status: "needs_review", expires: 800, captured: -1, id: 42 },
    ]), ["driver_licence"], NOW);
    expect(v).toMatchObject({ state: "in_force", documentId: 41 });
  });

  it("an unverified verdict carries the date its row claims — for blocking only", () => {
    const v = complianceRequirementValidity(rows("driver_licence", [{ status: "needs_review", expires: 400, captured: -1 }]), ["driver_licence"], NOW);
    expect(v).toMatchObject({ state: "unverified", expiresAt: null, claimLapsed: false });
    expect(v.claimedExpiresAt).toEqual(days(400));
  });

  it("is deterministic: rows captured in the same instant give the same verdict in any input order", () => {
    const tied = rows("driver_licence", [
      { status: "verified", expires: 300, captured: -5, id: 7 },
      { status: "verified", expires: -1, captured: -5, id: 9 },
    ]);
    const a = complianceRequirementValidity(tied, ["driver_licence"], NOW);
    const b = complianceRequirementValidity([...tied].reverse(), ["driver_licence"], NOW);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ state: "expired", documentId: 9 }); // the higher id is the later version
  });

  it("several accepted types: the most favourable verdict stands, ties keep the order asked", () => {
    const card = rows("insurance_card", [{ status: "verified", expires: 200, captured: -10, id: 5 }]);
    const proof = rows("insurance_proof", [{ status: "verified", expires: -1, captured: -10, id: 6 }]);
    expect(complianceRequirementValidity([...proof, ...card], INSURANCE_PROOF_DOC_TYPES, NOW)).toMatchObject({ state: "in_force", docType: "insurance_card", documentId: 5 });
    const both = [...rows("insurance_proof", [{ status: "verified", expires: 200, captured: -10, id: 1 }]), ...rows("insurance_card", [{ status: "verified", expires: 200, captured: -10, id: 2 }])];
    expect(complianceRequirementValidity(both, INSURANCE_PROOF_DOC_TYPES, NOW)).toMatchObject({ docType: "insurance_proof", documentId: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* Each consumer maps the verdict                                        */
/* ------------------------------------------------------------------ */

const verdict = (state: ValidityState, over: Partial<ComplianceVerdict> = {}): ComplianceVerdict => ({
  state, version: 1, expiresAt: state === "in_force" || state === "expiring" || state === "expired" ? days(state === "expired" ? -3 : 60) : null,
  daysRemaining: null, reason: `because ${state}`, docType: "x", documentId: 1, claimedExpiresAt: null, claimLapsed: false, ...over,
});

describe("medical fitness is a projection of the verdict", () => {
  it.each([
    ["in_force", "yes"], ["expiring", "yes"],
    ["expired", "no"], ["rejected", "no"], ["not_yet_effective", "no"],
    ["unverified", "unknown"], ["incomplete", "unknown"], ["none", "unknown"],
  ] as const)("%s → %s", (state, eligible) => {
    expect(medicalFitnessForDispatch(verdict(state)).eligible).toBe(eligible);
  });

  it("an unverified medical whose own date has passed is no, never unknown", () => {
    expect(medicalFitnessForDispatch(verdict("unverified", { claimLapsed: true, claimedExpiresAt: days(-1) }))).toEqual({ eligible: "no", reviewDue: days(-1) });
  });
});

const policy = (document: PolicyRecord["document"], over: Partial<PolicyRecord> = {}): PolicyRecord => ({
  policyRef: "POL-1", policyType: "commercial_auto", effectiveAt: days(-200), expiresAt: days(165), status: "active",
  coverageVerificationStatus: "coverage_verified",
  coverages: [{ coverageType: "commercial_auto", limitAmount: 5_000_000, additionalInsuredEndorsement: true }],
  document, ...over,
});
const coverage = (document: PolicyRecord["document"], over: Partial<PolicyRecord> = {}) =>
  assessCoverage({ coverageType: "commercial_auto", policies: [policy(document, over)], now: NOW });
const proofOf = (v: ComplianceVerdict): PolicyRecord["document"] => ({ source: "compliance_document", verdict: v });

describe("the insurance proof is the verdict, mapped", () => {
  it.each([
    ["in_force", "coverage_verified", "none"],
    ["expiring", "coverage_verified", "none"],
    ["expired", "document_expired", "review"],
    ["rejected", "document_missing", "review"],
    ["unverified", "coverage_reported", "review"],
    ["incomplete", "coverage_reported", "review"],
    ["not_yet_effective", "coverage_reported", "review"],
  ] as const)("%s → %s", (state, status, effect) => {
    const a = coverage(proofOf(verdict(state)));
    expect(a).toMatchObject({ status, effect });
    expect(a.proof).toEqual({ source: "compliance_document", state, documentId: 1 });
  });

  it("an unverified proof whose own date has passed reads document_expired", () => {
    expect(coverage(proofOf(verdict("unverified", { claimLapsed: true }))).status).toBe("document_expired");
  });

  it("no proof on file stays document_missing — nothing is chosen in its place", () => {
    expect(proofFromDocuments([], NOW)).toBeNull();
    expect(coverage(null)).toMatchObject({ status: "document_missing", effect: "review", proof: null });
  });

  it("a company-level policy's own record stands as its proof, and is named as that", () => {
    expect(coverage({ source: "policy_record" })).toMatchObject({ status: "coverage_verified", proof: { source: "policy_record" } });
  });

  it("the policy still decides first: an expired policy blocks whatever the proof says", () => {
    expect(coverage(proofOf(verdict("in_force")), { expiresAt: days(-1) })).toMatchObject({ status: "coverage_expired", effect: "blocked" });
  });

  it("coverage the insurer has not confirmed stays reported, even with a proof in force", () => {
    expect(coverage(proofOf(verdict("in_force")), { coverageVerificationStatus: "coverage_reported" }).status).toBe("coverage_reported");
  });
});

describe("insurance proof selection", () => {
  const select = (specs: { type?: string; spec: Spec }[]) =>
    proofFromDocuments(specs.flatMap((s, i) => rows(s.type ?? "insurance_proof", [{ ...s.spec, id: s.spec.id ?? i + 1 }])), NOW);

  it("selects the only valid candidate among several, not the one with the latest date", () => {
    const p = select([
      { spec: { status: "verified", expires: 100, captured: -60, id: 10 } },
      { spec: { status: "needs_review", expires: 900, captured: -1, id: 11 } },
      { spec: { status: "rejected", expires: 950, captured: -2, id: 12 } },
    ]);
    // The rejected row is the newest-captured but one; the upload is newest. Neither displaces the verified row.
    expect(p).toMatchObject({ source: "compliance_document", verdict: { state: "in_force", documentId: 10 } });
  });

  it("with several valid candidates, the newest verified version is the proof — every time", () => {
    const specs = [
      { spec: { status: "verified" as const, expires: 300, captured: -60, id: 20 } },
      { spec: { status: "verified" as const, expires: 200, captured: -5, id: 21 } },
    ];
    const a = select(specs);
    const b = select([...specs].reverse());
    expect(a).toMatchObject({ verdict: { state: "in_force", documentId: 21 } });
    expect(b).toEqual(a);
  });

  it("with no valid candidate, the proof is what is on file, never the closest-looking row", () => {
    expect(select([{ spec: { status: "needs_review", expires: 900, captured: -1 } }])).toMatchObject({ verdict: { state: "unverified" } });
    expect(select([{ spec: { status: "verified", expires: -1, captured: -300 } }])).toMatchObject({ verdict: { state: "expired" } });
    expect(select([{ spec: { status: "verified", expires: null, captured: -30 } }])).toMatchObject({ verdict: { state: "incomplete" } });
    expect(select([{ spec: { status: "verified", expires: 400, issued: 10, captured: -1 } }])).toMatchObject({ verdict: { state: "not_yet_effective" } });
    expect(select([{ spec: { status: "rejected", expires: 400, captured: -1 } }])).toMatchObject({ verdict: { state: "rejected" } });
  });

  it("reads only proof types: a valid document of another type is not a proof", () => {
    expect(select([{ type: "driver_licence", spec: { status: "verified", expires: 400, captured: -1 } }])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Equivalence                                                           */
/* ------------------------------------------------------------------ */

describe("same records, every consumer, one verdict", () => {
  /**
   * Each consumer is asked through its own entry point: the tile through `documentExpiry` (what
   * `widgetSources` calls), the insurance office through `proofFromDocuments` (what both
   * `readinessComposer.policiesCovering` and `insuranceRouter.policiesFor` call), medical fitness
   * through the verdict it projects, and dispatch through `complianceRequirementValidity` (what
   * `readinessComposer.credentialState` calls). The underlying state must be identical.
   */
  it.each(CASES)("$name", ({ specs, expect: state }) => {
    const asType = (docType: string) => rows(docType, specs);

    const dispatch = complianceRequirementValidity(asType("driver_licence"), ["driver_licence"], NOW);
    const tile = documentExpiry(asType("driver_licence"), NOW).find(d => d.docType === "driver_licence")!;
    const insurance = proofFromDocuments(asType("insurance_proof"), NOW);
    const medicalVerdict = complianceRequirementValidity(asType("medical_fitness"), MEDICAL_FITNESS_DOC_TYPES, NOW);

    expect(dispatch.state).toBe(state);
    expect(tile.state).toBe(state);
    expect(insurance?.source === "compliance_document" && insurance.verdict.state).toBe(state);
    expect(medicalVerdict.state).toBe(state);

    // The same row, the same dates, the same reason — not merely the same word.
    for (const other of [tile, insurance?.source === "compliance_document" ? insurance.verdict : null, medicalVerdict]) {
      expect(other).toMatchObject({ expiresAt: dispatch.expiresAt, daysRemaining: dispatch.daysRemaining, reason: dispatch.reason });
    }
    expect(tile.documentId).toBe(dispatch.documentId ?? tile.documentId);
    expect(medicalFitnessForDispatch(medicalVerdict)).toEqual(medicalFitnessForDispatch(dispatch));
  });
});

/* ------------------------------------------------------------------ */
/* The documentExpiry tile, through the real reader                      */
/* ------------------------------------------------------------------ */

describe("the documentExpiry tile presents the verdict and decides nothing", () => {
  const OPERATOR = 77;
  type ListInput = { ownerType: "operator"; ownerId: number } | undefined;
  const tileFor = async (docs: ComplianceDocumentRow[], extra: { ownerType: string; ownerId: number; row: ComplianceDocumentRow }[] = []) => {
    const asked: ListInput[] = [];
    const listed = [
      ...docs.map(d => ({ ...d, ownerType: "operator", ownerId: OPERATOR })),
      ...extra.map(e => ({ ...e.row, ownerType: e.ownerType, ownerId: e.ownerId })),
    ];
    const caller = {
      fieldRoute: { identity: { documents: { list: async (input?: ListInput) => { asked.push(input); return listed; } } } },
    };
    const read = widgetReaderFor(
      { userId: 1, tenantId: "t", roleKey: "driver", permissions: [] } as never,
      () => caller as never,
      async () => ({ kind: "resolved", operatorId: operatorIdFromRecord(OPERATOR) }),
    );
    const payload = await read({ widgetKey: "documentExpiry", options: { warnDays: 30, limit: 30 }, subjectRef: null, deviceLocal: false } as never);
    return { payload, asked };
  };
  const tileRows = (p: Awaited<ReturnType<typeof tileFor>>["payload"]) => {
    expect(p.state).toBe("ok");
    if (p.state !== "ok") throw new Error("unreachable");
    return (p.value as { documents: { docType: string; state: ValidityState; label: string; group: string; documentId: number }[] }).documents;
  };

  it.each(CASES)("$name: the tile's state is the canonical state", async ({ specs }) => {
    // The tile judges at the real clock, so the canonical verdict is computed at the same instant's scale.
    const now = new Date();
    const shifted: ComplianceDocumentRow[] = rows("driver_licence", specs).map(r => ({
      ...r,
      issuedAt: r.issuedAt && new Date(now.getTime() + (r.issuedAt.getTime() - NOW.getTime())),
      expiresAt: r.expiresAt && new Date(now.getTime() + (r.expiresAt.getTime() - NOW.getTime())),
      capturedAt: new Date(now.getTime() + (r.capturedAt.getTime() - NOW.getTime())),
    }));
    const [row] = tileRows((await tileFor(shifted)).payload);
    const canonical = complianceRequirementValidity(shifted, ["driver_licence"], now);
    expect(row!.state).toBe(canonical.state);
    expect(row!.documentId).toBe(canonical.documentId ?? row!.documentId);
  });

  it("shows unknown as not established — never as expired or current", async () => {
    const now = new Date();
    const docs = [
      ...rows("driver_licence", [{ status: "verified", expires: null, captured: -1 }]),
      ...rows("h2s", [{ status: "needs_review", expires: 300, captured: -1, id: 50 }]),
    ].map(r => ({ ...r, expiresAt: r.expiresAt && new Date(now.getTime() + 300 * 86_400_000), capturedAt: new Date(now.getTime() - 86_400_000) }));
    const out = tileRows((await tileFor(docs)).payload);
    for (const r of out) {
      expect(r.group).toBe("not_established");
      expect(r.label).toMatch(/^Not established/);
      expect(r.label).not.toMatch(/expired|in force|current/i);
    }
  });

  it("one row per document type: an upload beside the verified licence does not become a second licence", async () => {
    const now = new Date();
    const docs: ComplianceDocumentRow[] = [
      { id: 1, docType: "driver_licence", title: "old", issuedAt: null, expiresAt: new Date(now.getTime() + 100 * 86_400_000), verificationStatus: "verified", capturedAt: new Date(now.getTime() - 30 * 86_400_000) },
      { id: 2, docType: "driver_licence", title: "new", issuedAt: null, expiresAt: new Date(now.getTime() + 800 * 86_400_000), verificationStatus: "needs_review", capturedAt: new Date(now.getTime() - 86_400_000) },
    ];
    const out = tileRows((await tileFor(docs)).payload);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ docType: "driver_licence", state: "in_force", documentId: 1, group: "in_force" });
  });

  it("asks for this operator's own documents, and ignores anyone else's the list might return", async () => {
    const now = new Date();
    const mine: ComplianceDocumentRow = { id: 1, docType: "driver_licence", title: "mine", issuedAt: null, expiresAt: new Date(now.getTime() - 86_400_000), verificationStatus: "verified", capturedAt: new Date(now.getTime() - 400 * 86_400_000) };
    const theirs: ComplianceDocumentRow = { ...mine, id: 2, expiresAt: new Date(now.getTime() + 400 * 86_400_000), capturedAt: new Date(now.getTime() - 86_400_000) };
    const { payload, asked } = await tileFor([mine], [
      { ownerType: "operator", ownerId: OPERATOR + 1, row: theirs },
      { ownerType: "unit", ownerId: OPERATOR, row: { ...theirs, id: 3 } },
    ]);
    expect(asked).toEqual([{ ownerType: "operator", ownerId: OPERATOR }]);
    expect(tileRows(payload)).toEqual([expect.objectContaining({ documentId: 1, state: "expired" })]);
  });

  it("refuses to judge from a history it cannot see whole", async () => {
    const now = new Date();
    const many: ComplianceDocumentRow[] = Array.from({ length: OWNER_DOCUMENT_LIST_CAP }, (_, i) => ({
      id: i + 1, docType: "driver_licence", title: "x", issuedAt: null, expiresAt: new Date(now.getTime() + 400 * 86_400_000), verificationStatus: "verified", capturedAt: new Date(now.getTime() - (i + 1) * 60_000),
    }));
    const { payload } = await tileFor(many);
    expect(payload.state).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* The passport and the work combination                                 */
/* ------------------------------------------------------------------ */

describe("the passport maps the verdict", () => {
  const requirement = (over: Partial<Requirement> = {}): Requirement => ({
    requirementKey: "driver.licence", version: 1, family: "driver", title: "Driver licence", subjectType: "operator", jurisdiction: "CA-AB",
    satisfiedByDocTypes: ["driver_licence"], warnDaysBeforeExpiry: 30, missingSeverity: "blocked", verificationStatus: "verified",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"), ...over,
  });
  const asCredentials = (docRows: readonly ComplianceDocumentRow[], ownerKey = "operator:9"): Credential[] =>
    docRows.map(r => ({ id: r.id, capturedAt: r.capturedAt, ownerKey, docType: r.docType, issuedAt: r.issuedAt, expiresAt: r.expiresAt, verificationStatus: r.verificationStatus, privateDetail: false }));
  const PASSPORT: Record<ValidityState, { status: string; effect: string }> = {
    in_force: { status: "satisfied", effect: "none" }, expiring: { status: "expiring", effect: "review" },
    expired: { status: "expired", effect: "blocked" }, rejected: { status: "evidence_rejected", effect: "blocked" },
    unverified: { status: "evidence_unverified", effect: "review" }, not_yet_effective: { status: "not_yet_effective", effect: "blocked" },
    incomplete: { status: "evidence_incomplete", effect: "unknown" }, none: { status: "missing", effect: "blocked" },
  };

  it.each(CASES)("$name", ({ specs, expect: state, lapsed }) => {
    const item = evaluateRequirement({ requirement: requirement(), credentials: asCredentials(rows("driver_licence", specs)), now: NOW });
    expect(item).toMatchObject(lapsed ? { status: "expired", effect: "blocked" } : PASSPORT[state]);
  });

  it("a combination judges each subject's rows as its own history, then the most favourable", () => {
    // The worker's licence expired; the same type on the equipment's record is in force. Neither
    // subject's rows are read as versions of the other's.
    const worker = asCredentials(rows("site_orientation", [{ status: "verified", expires: -5, captured: -1, id: 1 }]), "operator:9");
    const equipment = asCredentials(rows("site_orientation", [{ status: "verified", expires: 200, captured: -30, id: 2 }]), "equipment:42");
    const v = candidateVerdict([...worker, ...equipment], NOW, 30);
    expect(v.verdict).toMatchObject({ state: "in_force", documentId: 2 });
  });

  it("a customer-required document counts only when it is in force, not merely verified", () => {
    const base: WorkContext = {
      jurisdiction: "CA-AB", at: NOW, worker: { id: 9, attributes: {}, credentials: [] }, equipment: null, attachments: [],
      work: { workType: "excavation" }, site: null, cargo: null, customer: { ref: "ACME", requiredDocTypes: ["acme_site_orientation"] },
    };
    const withDoc = (specs: Spec[]) => evaluateWorkContext({
      ctx: { ...base, worker: { id: 9, attributes: {}, credentials: asCredentials(rows("acme_site_orientation", specs)) } },
      requirements: [], activePacks: new Set(),
    });
    expect(withDoc([{ status: "verified", expires: 100, captured: -5 }]).reasons.join(" ")).not.toContain("customer:");
    for (const lapsedOrUnset of [
      [{ status: "verified" as const, expires: -1, captured: -300 }],
      [{ status: "verified" as const, expires: null, captured: -5 }],
      [{ status: "needs_review" as const, expires: 100, captured: -5 }],
    ]) {
      expect(withDoc(lapsedOrUnset).reasons.join(" ")).toContain("customer: requires acme_site_orientation");
    }
  });
});

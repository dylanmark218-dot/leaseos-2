/**
 * Records & File Manager — the projection's rules, pinned.
 *
 * The file manager opens behind `evidence.browse`, and that permission reads
 * nothing on its own: every record is decided on its type's category read, or
 * on `evidence.read_own` for the caller's own. These tests hold that line, and
 * the fail-closed treatment of a record type nobody has classified.
 */
import { describe, expect, it } from "vitest";
import {
  FORWARD_TYPE_READ_CATEGORY,
  READ_CATEGORY_BY_RECORD_TYPE,
  SEALED_TYPE_READ_CATEGORY,
  fileVisibility,
  folderCounts,
  inFolder,
  lifecycleStage,
  matchRecord,
  readCategoryFor,
  typeFolderFor,
  type FolderFacts,
} from "./recordFiles";
import {
  EVIDENCE_READ_CATEGORIES,
  RECORDS_PROCEDURE_PERMISSIONS,
  authorize,
  permissionsForDomainRole,
  type DomainRole,
  type Permission,
} from "./_core/recordsAuthorization";

const ROLES: DomainRole[] = [
  "driver", "dispatcher", "mechanic", "shop_lead", "safety", "office", "management", "hr", "legal",
  "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller", "external_accountant",
];
const heldBy = (role: DomainRole) => new Set(permissionsForDomainRole(role));

/**
 * The policy, written out a second time on purpose. The map in recordFiles.ts
 * is the implementation; this table is the decision. They are compared both
 * ways, so a type cannot move category, appear or disappear in one place only.
 */
const POLICY: Record<string, string | null> = {
  // The work and its paperwork — job-operational
  field_ticket: "evidence.read_job_operational",
  daily_log: "evidence.read_job_operational",
  permit: "evidence.read_job_operational",
  photo: "evidence.read_job_operational",
  // disposal chain and manifests — job-operational
  manifest: "evidence.read_job_operational",
  load_ticket: "evidence.read_job_operational",
  disposal_ticket: "evidence.read_job_operational",
  scale_ticket: "evidence.read_job_operational",
  // legacy default — exactly what evidence.list already shows
  other: "evidence.read_job_operational",
  // vehicle / equipment and inspections — maintenance
  pre_trip: "evidence.read_maintenance",
  post_trip_dvir: "evidence.read_maintenance",
  inspection: "evidence.read_maintenance",
  defect_report: "evidence.read_maintenance",
  work_order: "evidence.read_maintenance",
  // safety
  safety_meeting: "evidence.read_safety_summary",
  incident: "evidence.read_safety_summary",
  near_miss: "evidence.read_safety_summary",
  // receipts and billing — commercial
  bill_receipt: "evidence.read_commercial",
  invoice: "evidence.read_commercial",
  // credentials and people — personnel
  credential: "evidence.read_personnel",
  training_record: "evidence.read_personnel",
  employment_record: "evidence.read_personnel",
  // legal
  legal_correspondence: "evidence.read_legal",
  // Sign & Attest — classified, deliberately in no category: owner-only until SA decides
  signature_strokes: null,
  signature_render: null,
  signed_artifact: null,
  attest_receipt: null,
};

/** The seal's own vocabulary, as `EvidenceRecordType` declares it. */
const SEAL_TYPES = [
  "daily_log", "pre_trip", "post_trip_dvir", "manifest", "load_ticket", "disposal_ticket", "scale_ticket",
  "field_ticket", "bill_receipt", "safety_meeting", "incident", "near_miss", "defect_report", "work_order",
  "inspection", "permit", "photo", "other",
  "signature_strokes", "signature_render", "signed_artifact", "attest_receipt",
];

describe("classification policy", () => {
  for (const [type, category] of Object.entries(POLICY)) {
    it(`${type} → ${category}`, () => expect(readCategoryFor(type)).toBe(category));
  }

  it("the implementation classifies exactly the types the policy names, no more", () => {
    expect(Object.keys(READ_CATEGORY_BY_RECORD_TYPE).sort()).toEqual(Object.keys(POLICY).sort());
  });

  it("covers every type the seal can produce", () => {
    expect(Object.keys(SEALED_TYPE_READ_CATEGORY).sort()).toEqual([...SEAL_TYPES].sort());
  });

  it("only ever names a real read category", () => {
    for (const c of Object.values(READ_CATEGORY_BY_RECORD_TYPE)) if (c !== null) expect(EVIDENCE_READ_CATEGORIES).toContain(c);
  });

  it("classifies every type the seal does not know yet into a narrow category, never job-operational", () => {
    for (const [type, c] of Object.entries(FORWARD_TYPE_READ_CATEGORY)) {
      expect(SEAL_TYPES, type).not.toContain(type);
      expect(c, type).not.toBe("evidence.read_job_operational");
    }
  });
});

describe("unknown and malformed types inherit nothing", () => {
  const unknown = [
    "brand_new_type", "", " ", "Photo", "PHOTO", " photo", "photo ", "load-ticket", "loadTicket", "Other", "OTHER",
    "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "credential\u0000", "evidence.read_legal",
  ];
  for (const t of unknown) {
    it(`${JSON.stringify(t)} has no category`, () => expect(readCategoryFor(t)).toBeNull());
  }

  it("is invisible to every role by category, including the broadest readers", () => {
    for (const role of ROLES) {
      expect(fileVisibility({ held: heldBy(role), recordType: "brand_new_type", isOwner: false }).visible, role).toBe(false);
    }
  });

  it("reaches its owner only through evidence.read_own — the existing listForOperator contract", () => {
    // records.evidence.listForOperator returns every record related to the caller's operator, of any type,
    // under evidence.read_own. The file manager keeps that, and adds nothing to it.
    expect(fileVisibility({ held: heldBy("driver"), recordType: "brand_new_type", isOwner: true })).toMatchObject({ visible: true, basis: "own", category: null });
    for (const role of ROLES.filter(r => !heldBy(r).has("evidence.read_own"))) {
      expect(fileVisibility({ held: heldBy(role), recordType: "brand_new_type", isOwner: true }).visible, role).toBe(false);
    }
  });
});

describe("who each policy group reaches", () => {
  const reaches = (type: string) =>
    ROLES.filter(role => fileVisibility({ held: heldBy(role), recordType: type, isOwner: false }).visible).sort();
  const holders = (perm: Permission) => ROLES.filter(r => heldBy(r).has(perm)).sort();

  it("reaches exactly the holders of the mapped category — the file manager widens no grant", () => {
    for (const [type, category] of Object.entries(POLICY)) {
      expect(reaches(type), type).toEqual(category === null ? [] : holders(category as Permission));
    }
  });

  it("keeps credentials with HR and payroll only", () => {
    expect(reaches("credential")).toEqual(["hr", "payroll_admin"]);
  });

  it("keeps receipts away from the field and the shop", () => {
    for (const r of ["driver", "dispatcher", "mechanic", "shop_lead", "safety"] as DomainRole[]) {
      expect(reaches("bill_receipt"), r).not.toContain(r);
    }
  });

  it("keeps signatures and signed artifacts out of every category", () => {
    for (const t of ["signature_strokes", "signature_render", "signed_artifact", "attest_receipt"]) {
      expect(readCategoryFor(t), t).toBeNull();
      expect(reaches(t), t).toEqual([]);
      // ...and the signer keeps their own, as listForOperator already gives them.
      expect(fileVisibility({ held: heldBy("driver"), recordType: t, isOwner: true }).visible, t).toBe(true);
    }
  });

  it("keeps legal correspondence with legal", () => {
    expect(reaches("legal_correspondence")).toEqual(["legal"]);
  });

  it("gives a driver no category at all", () => {
    for (const type of Object.keys(POLICY)) expect(reaches(type), type).not.toContain("driver");
  });
});

describe("visibility", () => {
  it("browse alone reads nothing", () => {
    const v = fileVisibility({ held: new Set<Permission>(["evidence.browse"]), recordType: "photo", isOwner: false });
    expect(v.visible).toBe(false);
  });

  it("a mechanic sees maintenance, not billing or personnel", () => {
    const held = heldBy("mechanic");
    expect(fileVisibility({ held, recordType: "work_order", isOwner: false }).visible).toBe(true);
    expect(fileVisibility({ held, recordType: "bill_receipt", isOwner: false }).visible).toBe(false);
    expect(fileVisibility({ held, recordType: "credential", isOwner: false }).visible).toBe(false);
  });

  it("a driver sees their own records and nobody else's", () => {
    const held = heldBy("driver");
    expect(fileVisibility({ held, recordType: "load_ticket", isOwner: true })).toMatchObject({ visible: true, basis: "own" });
    expect(fileVisibility({ held, recordType: "load_ticket", isOwner: false }).visible).toBe(false);
  });

  it("an unclassified type reaches its owner and no category holder", () => {
    expect(fileVisibility({ held: heldBy("management"), recordType: "brand_new_type", isOwner: false }).visible).toBe(false);
    expect(fileVisibility({ held: heldBy("driver"), recordType: "brand_new_type", isOwner: true }).visible).toBe(true);
  });

  it("owning a record does not help someone without evidence.read_own", () => {
    // HR has no read_own; owning a maintenance record does not open it to them.
    expect(fileVisibility({ held: heldBy("hr"), recordType: "work_order", isOwner: true }).visible).toBe(false);
  });

  it("personnel records reach HR and payroll, and not the office", () => {
    expect(fileVisibility({ held: heldBy("hr"), recordType: "credential", isOwner: false }).visible).toBe(true);
    expect(fileVisibility({ held: heldBy("payroll_admin"), recordType: "credential", isOwner: false }).visible).toBe(true);
    expect(fileVisibility({ held: heldBy("office"), recordType: "credential", isOwner: false }).visible).toBe(false);
  });
});

describe("the browse gate", () => {
  it("is held by exactly the roles that can read some evidence", () => {
    const reads: Permission[] = [...EVIDENCE_READ_CATEGORIES, "evidence.read_own"];
    for (const role of ROLES) {
      const readsSomething = reads.some(p => authorize({ userId: 1, roles: [role], permission: p }).allowed);
      const browses = authorize({ userId: 1, roles: [role], permission: "evidence.browse" }).allowed;
      expect(browses, role).toBe(readsSomething);
    }
  });

  it("gates all three file procedures", () => {
    expect(RECORDS_PROCEDURE_PERMISSIONS["records.files.list"]).toBe("evidence.browse");
    expect(RECORDS_PROCEDURE_PERMISSIONS["records.files.get"]).toBe("evidence.browse");
    expect(RECORDS_PROCEDURE_PERMISSIONS["records.files.download"]).toBe("evidence.browse");
  });

  it("does not open to a branch-confined grant it cannot place", () => {
    const r = authorize({ userId: 1, grants: [{ role: "office", scopeRef: "north" }], permission: "evidence.browse" });
    expect(r.allowed).toBe(false);
  });
});

describe("lifecycle", () => {
  const base = { sealState: "sealed" as const, syncState: null, sealVerification: null, officeReviewedAt: null };

  it("walks draft → sealed → queued → received → verified → accepted", () => {
    expect(lifecycleStage({ ...base, sealState: "draft" })).toBe("draft");
    expect(lifecycleStage(base)).toBe("sealed");
    expect(lifecycleStage({ ...base, syncState: "pending" })).toBe("queued");
    expect(lifecycleStage({ ...base, syncState: "received" })).toBe("server_received");
    expect(lifecycleStage({ ...base, syncState: "verified" })).toBe("hash_verified");
    expect(lifecycleStage({ ...base, syncState: "verified", officeReviewedAt: new Date() })).toBe("office_accepted");
  });

  it("names an integrity failure instead of showing it as progress", () => {
    expect(lifecycleStage({ ...base, syncState: "mismatch" })).toBe("integrity_failed");
    expect(lifecycleStage({ ...base, sealVerification: "hash_mismatch", officeReviewedAt: new Date() })).toBe("integrity_failed");
  });

  it("does not accept a record the office reviewed but never verified", () => {
    expect(lifecycleStage({ ...base, syncState: "received", officeReviewedAt: new Date() })).toBe("server_received");
  });

  it("a draft is a draft whatever else is recorded", () => {
    expect(lifecycleStage({ ...base, sealState: "draft", syncState: "verified" })).toBe("draft");
  });
});

describe("folders are views", () => {
  const rec = (over: Partial<FolderFacts> = {}): FolderFacts => ({
    recordType: "load_ticket", status: "verified", sealState: "sealed", legalHold: false,
    entityRelationshipCount: 1, jobId: 5, ...over,
  });

  it("puts each type in exactly one type folder", () => {
    expect(typeFolderFor("load_ticket")).toBe("loads_disposal");
    expect(typeFolderFor("photo")).toBe("photos");
    expect(typeFolderFor("brand_new_type")).toBe("other");
  });

  it("lets one record sit in several work queues at once", () => {
    const r = rec({ status: "needs_review", sealState: "draft", legalHold: true, jobId: null, entityRelationshipCount: 0 });
    for (const q of ["needs_filing", "needs_review", "drafts", "legal_hold", "loads_disposal", "all"] as const) {
      expect(inFolder(q, r), q).toBe(true);
    }
  });

  it("files a record with a job or any relationship", () => {
    expect(inFolder("needs_filing", rec({ jobId: null }))).toBe(false);
    expect(inFolder("needs_filing", rec({ entityRelationshipCount: 0 }))).toBe(false);
  });

  it("counts every folder", () => {
    const counts = folderCounts([rec(), rec({ recordType: "photo", status: "needs_review" })]);
    expect(counts.all).toBe(2);
    expect(counts.loads_disposal).toBe(1);
    expect(counts.photos).toBe(1);
    expect(counts.needs_review).toBe(1);
    expect(counts.legal_hold).toBe(0);
  });
});

describe("search says why", () => {
  const r = {
    title: "Fox Creek disposal", trackingNumber: "DT-8842", recordType: "disposal_ticket", category: "ticket", notes: null,
    relationships: [{ entityType: "unit", entityRef: "TRK-27", entityId: 27 }, { entityType: "job", entityRef: "JOB-10483", entityId: 10483 }],
  };

  it("matches every term and names the field", () => {
    const m = matchRecord("trk-27 fox", r);
    expect(m.matched).toBe(true);
    expect(m.reasons).toEqual(['related unit matches "trk-27"', 'title matches "fox"']);
  });

  it("refuses a partial match", () => {
    expect(matchRecord("JOB-10483 invoice", r).matched).toBe(false);
  });

  it("matches everything, and explains nothing, on an empty query", () => {
    expect(matchRecord("   ", r)).toEqual({ matched: true, reasons: [] });
  });

  it("reads record types as words", () => {
    expect(matchRecord("disposal ticket", r).matched).toBe(true);
  });
});

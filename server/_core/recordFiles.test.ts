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
  READ_CATEGORY_BY_RECORD_TYPE,
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
} from "./recordsAuthorization";

const ROLES: DomainRole[] = [
  "driver", "dispatcher", "mechanic", "shop_lead", "safety", "office", "management", "hr", "legal",
  "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller", "external_accountant",
];
const heldBy = (role: DomainRole) => new Set(permissionsForDomainRole(role));

describe("classification", () => {
  it("maps every evidence record type the seal knows to a category", () => {
    const sealTypes = [
      "daily_log", "pre_trip", "post_trip_dvir", "manifest", "load_ticket", "disposal_ticket", "scale_ticket",
      "field_ticket", "bill_receipt", "safety_meeting", "incident", "near_miss", "defect_report", "work_order",
      "inspection", "permit", "photo", "other",
    ];
    for (const t of sealTypes) expect(readCategoryFor(t), t).not.toBeNull();
  });

  it("only ever names a real read category", () => {
    for (const c of Object.values(READ_CATEGORY_BY_RECORD_TYPE)) expect(EVIDENCE_READ_CATEGORIES).toContain(c);
  });

  it("leaves an unknown type in no category", () => {
    expect(readCategoryFor("brand_new_type")).toBeNull();
    // A prototype key is not a record type.
    expect(readCategoryFor("constructor")).toBeNull();
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

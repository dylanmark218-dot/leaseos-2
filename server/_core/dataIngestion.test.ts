import { describe, expect, it } from "vitest";
import {
  assessCoverage,
  assessDispatchTrust,
  computeChecksum,
  confirmDataset,
  markOperatorSupplied,
  planSupersession,
  validateImportBatch,
  type ImportBatch,
} from "./dataIngestion";

const IMPORTED = new Date(Date.UTC(2026, 7, 20));

const BATCH: ImportBatch = {
  batchId: "IB-2026-0001",
  resourceType: "bridge",
  jurisdiction: "AB",
  source: "Alberta Transportation",
  sourceReference: "https://example.invalid/bridge-restrictions",
  licenceNotes: "Open Government Licence — Alberta",
  datasetVersion: "AB-BRIDGE-2026.3",
  effectiveDate: new Date(Date.UTC(2026, 6, 1)),
  importedAt: IMPORTED,
  recordCount: 4182,
  checksum: "fnv1a:deadbeef:4182",
  confidence: "unverified",
};

const rejects = (b: Partial<ImportBatch>) =>
  validateImportBatch(b)
    .problems.filter(p => p.severity === "reject")
    .map(p => p.field);

describe("validateImportBatch — provenance is mandatory", () => {
  it("accepts a fully attributed batch as provisional, not validated", () => {
    const r = validateImportBatch(BATCH);
    expect(r.status).toBe("provisional");
    expect(r.problems.filter(p => p.severity === "reject")).toEqual([]);
  });

  it("rejects a batch with no source authority", () => {
    expect(rejects({ ...BATCH, source: "" })).toContain("source");
  });

  it("rejects a batch with no jurisdiction, version or checksum", () => {
    expect(rejects({ ...BATCH, jurisdiction: "" })).toContain("jurisdiction");
    expect(rejects({ ...BATCH, datasetVersion: "" })).toContain(
      "datasetVersion"
    );
    expect(rejects({ ...BATCH, checksum: "" })).toContain("checksum");
  });

  it("rejects an empty batch rather than importing zero records silently", () => {
    expect(rejects({ ...BATCH, recordCount: 0 })).toContain("recordCount");
  });

  it("refuses to let an import declare its own authority", () => {
    const r = validateImportBatch({
      ...BATCH,
      confidence: "authority_confirmed",
    });
    expect(r.status).toBe("rejected");
    expect(r.problems.find(p => p.field === "confidence")?.message).toContain(
      "cannot self-declare"
    );
  });

  it("warns but does not reject when licence terms are missing", () => {
    const r = validateImportBatch({ ...BATCH, licenceNotes: null });
    expect(r.status).toBe("provisional");
    expect(r.problems.find(p => p.field === "licenceNotes")?.severity).toBe(
      "warn"
    );
  });

  it("warns when there is no effective date or traceable reference", () => {
    const r = validateImportBatch({
      ...BATCH,
      effectiveDate: null,
      sourceReference: null,
    });
    const warns = r.problems
      .filter(p => p.severity === "warn")
      .map(p => p.field);
    expect(warns).toEqual(
      expect.arrayContaining(["effectiveDate", "sourceReference"])
    );
  });
});

describe("computeChecksum", () => {
  it("is stable across property order", () => {
    expect(computeChecksum([{ a: 1, b: 2 }])).toBe(
      computeChecksum([{ b: 2, a: 1 }])
    );
  });

  it("changes when a value changes", () => {
    expect(computeChecksum([{ limit: 55000 }])).not.toBe(
      computeChecksum([{ limit: 55001 }])
    );
  });

  it("carries the record count so a truncated import is visible", () => {
    expect(computeChecksum([{ a: 1 }, { a: 2 }]).endsWith(":2")).toBe(true);
  });
});

describe("assessCoverage — measured, never claimed", () => {
  it("reports unknown when the expected extent is not known", () => {
    const c = assessCoverage(4182, null, "bridges");
    expect(c.state).toBe("unknown");
    expect(c.percent).toBeNull();
    expect(c.message).toContain(
      "coverage cannot be measured, so it is not claimed"
    );
  });

  it("reports partial coverage with the gap stated", () => {
    const c = assessCoverage(4182, 5000, "bridges");
    expect(c.state).toBe("partial");
    expect(c.percent).toBe(83.6);
    expect(c.message).toContain("unmapped segments evaluate as unknown");
  });

  it("only reports complete against a published extent", () => {
    expect(assessCoverage(5000, 5000, "bridges").state).toBe("complete");
  });
});

describe("confirmDataset — confidence is promoted by evidence", () => {
  const confirmation = {
    confirmedByUserId: 12,
    confirmedByName: "S. Bell",
    authority: "Alberta Transportation permit office",
    authorityReference: "Call ref 88214",
    confirmedAt: new Date(Date.UTC(2026, 7, 21)),
  };

  it("promotes to authority_confirmed and records who and against what", () => {
    const r = confirmDataset(BATCH, confirmation);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.confidence).toBe("authority_confirmed");
      expect(r.record.confirmedByName).toBe("S. Bell");
      expect(r.record.authority).toContain("permit office");
      expect(r.record.batchId).toBe("IB-2026-0001");
    }
  });

  it("refuses an anonymous confirmation", () => {
    const r = confirmDataset(BATCH, { ...confirmation, confirmedByName: "  " });
    expect(r.ok).toBe(false);
  });

  it("refuses a confirmation that names no authority", () => {
    const r = confirmDataset(BATCH, { ...confirmation, authority: "" });
    expect(r.ok).toBe(false);
  });

  it("refuses a confirmation dated before the import it confirms", () => {
    const r = confirmDataset(BATCH, {
      ...confirmation,
      confirmedAt: new Date(Date.UTC(2026, 7, 1)),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("predate");
  });

  it("supports operator_supplied as a real middle state", () => {
    expect(markOperatorSupplied(BATCH).confidence).toBe("operator_supplied");
  });
});

describe("planSupersession — old data is retained, never deleted", () => {
  const older: ImportBatch = {
    ...BATCH,
    batchId: "IB-2025-0009",
    datasetVersion: "AB-BRIDGE-2025.1",
    importedAt: new Date(Date.UTC(2025, 10, 2)),
  };

  it("supersedes earlier batches for the same resource and jurisdiction", () => {
    const p = planSupersession(BATCH, [older]);
    expect(p.supersedeBatchIds).toEqual(["IB-2025-0009"]);
    expect(p.retainForReproducibility).toBe(true);
    expect(p.message).toContain("retained for reproducibility");
  });

  it("leaves other jurisdictions and resource types alone", () => {
    const otherJur = { ...older, batchId: "IB-BC-1", jurisdiction: "BC" };
    const otherType = {
      ...older,
      batchId: "IB-RR-1",
      resourceType: "road_restriction" as const,
    };
    expect(
      planSupersession(BATCH, [otherJur, otherType]).supersedeBatchIds
    ).toEqual([]);
  });

  it("reports the first batch for a jurisdiction plainly", () => {
    expect(planSupersession(BATCH, []).message).toContain(
      "First bridge batch for AB"
    );
  });
});

describe("assessDispatchTrust — engine works vs data may be relied on", () => {
  const confirmed = (b: ImportBatch): ImportBatch => ({
    ...b,
    confidence: "authority_confirmed",
  });

  it("blocks dispatch trust when nothing is loaded", () => {
    const t = assessDispatchTrust("AB", []);
    expect(t.trustworthy).toBe(false);
    expect(t.blockers.length).toBe(3);
    expect(t.message).toContain(
      "The engine works; the data does not yet support a clear decision"
    );
  });

  it("still blocks when data exists but is unverified", () => {
    const t = assessDispatchTrust("AB", [
      BATCH,
      { ...BATCH, batchId: "b2", resourceType: "road_restriction" },
      { ...BATCH, batchId: "b3", resourceType: "regulatory_threshold" },
    ]);
    expect(t.trustworthy).toBe(false);
    expect(t.blockers.every(b => b.includes("not authority-confirmed"))).toBe(
      true
    );
  });

  it("clears only when every required type is authority-confirmed", () => {
    const t = assessDispatchTrust("AB", [
      confirmed(BATCH),
      confirmed({ ...BATCH, batchId: "b2", resourceType: "road_restriction" }),
      confirmed({
        ...BATCH,
        batchId: "b3",
        resourceType: "regulatory_threshold",
      }),
    ]);
    expect(t.trustworthy).toBe(true);
    expect(t.message).toContain("may be used for dispatch decisions");
  });

  it("does not let one jurisdiction's confirmation vouch for another", () => {
    const t = assessDispatchTrust("SK", [
      confirmed(BATCH),
      confirmed({ ...BATCH, batchId: "b2", resourceType: "road_restriction" }),
      confirmed({
        ...BATCH,
        batchId: "b3",
        resourceType: "regulatory_threshold",
      }),
    ]);
    expect(t.trustworthy).toBe(false);
  });
});

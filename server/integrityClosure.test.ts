import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { executeAssistantCommit, isDocumentForm } from "./_core/assistantCommitService";
import { grantUserRole } from "./db";
import {
  buildRemoteWorkEvidence,
  geodesicKm,
  summarizeRemoteWork,
  type RemoteWorkEvidence,
} from "./_core/remoteWorkEvidence";

/* ------------------------------------------------------------------ */
/* Remote-work evidence — pure                                          */
/* ------------------------------------------------------------------ */

describe("home-base distance is evidence, never a determination", () => {
  const home = { latitude: 53.5461, longitude: -113.4938 }; // Edmonton
  const work = { latitude: 56.7267, longitude: -111.3790 }; // Fort McMurray

  it("computes a geodesic distance and labels its source", () => {
    const e = buildRemoteWorkEvidence({
      userId: 1, homeBaseRef: "HB-EDM", workLocationRef: "LSD-12-08-054-17-W5",
      occurredOn: "2026-09-09", home, work,
    });
    expect(e.conclusion).toBe("evidence_available");
    expect(e.distanceSource).toBe("geodesic");
    // Straight-line Edmonton → Fort McMurray is roughly 380 km.
    expect(e.distanceKm).toBeGreaterThan(360);
    expect(e.distanceKm).toBeLessThan(400);
  });

  it("carries not_determined as a literal, on every record and every summary", () => {
    const e = buildRemoteWorkEvidence({ userId: 1, homeBaseRef: "H", workLocationRef: "W", occurredOn: "2026-09-09", home, work });
    // The type cannot express a conclusion; this pins the runtime value too.
    const conclusion: "not_determined" = e.taxConclusion;
    expect(conclusion).toBe("not_determined");
    expect(summarizeRemoteWork([e]).taxConclusion).toBe("not_determined");
  });

  it("prefers an operator-confirmed distance, then a routed one, then geodesic", () => {
    const base = { userId: 1, homeBaseRef: "H", workLocationRef: "W", occurredOn: "2026-09-09", home, work };
    expect(buildRemoteWorkEvidence({ ...base, routedDistanceKm: 441.2 }).distanceSource).toBe("route_engine");
    expect(buildRemoteWorkEvidence({ ...base, routedDistanceKm: 441.2, operatorConfirmedKm: 448 }).distanceSource).toBe("operator_confirmed");
    expect(buildRemoteWorkEvidence(base).distanceSource).toBe("geodesic");
  });

  it("reports insufficient evidence rather than a zero distance", () => {
    const e = buildRemoteWorkEvidence({ userId: 1, homeBaseRef: "H", workLocationRef: "W", occurredOn: "2026-09-09", home, work: null });
    expect(e.conclusion).toBe("insufficient_evidence");
    expect(e.distanceKm).toBeNull();
    expect(e.insufficiencyReason).toContain("work location coordinates");
  });

  it("treats (0,0) as a failed fix, not a location", () => {
    const e = buildRemoteWorkEvidence({
      userId: 1, homeBaseRef: "H", workLocationRef: "W", occurredOn: "2026-09-09",
      home, work: { latitude: 0, longitude: 0 },
    });
    expect(e.conclusion).toBe("insufficient_evidence");
  });

  it("refuses a malformed date and a negative nights-away", () => {
    expect(buildRemoteWorkEvidence({ userId: 1, homeBaseRef: "H", workLocationRef: "W", occurredOn: "09/09/2026", home, work }).conclusion).toBe("insufficient_evidence");
    expect(buildRemoteWorkEvidence({ userId: 1, homeBaseRef: "H", workLocationRef: "W", occurredOn: "2026-09-09", home, work, nightsAway: -1 }).conclusion).toBe("insufficient_evidence");
  });

  it("summarizes counts and distances without judging a threshold", () => {
    const recs: RemoteWorkEvidence[] = [
      buildRemoteWorkEvidence({ userId: 1, homeBaseRef: "H", workLocationRef: "A", occurredOn: "2026-09-01", home, work, nightsAway: 6 }),
      buildRemoteWorkEvidence({ userId: 1, homeBaseRef: "H", workLocationRef: "B", occurredOn: "2026-09-08", home, work: null, nightsAway: 2 }),
    ];
    const s = summarizeRemoteWork(recs);
    expect(s.days).toBe(2);
    expect(s.daysWithDistance).toBe(1);
    expect(s.daysInsufficient).toBe(1);
    expect(s.totalNightsAway).toBe(8);
    expect(s.distinctWorkLocations).toBe(2);
    expect(Object.keys(s)).not.toContain("eligible");
  });

  it("geodesic is symmetric and zero for the same point", () => {
    expect(geodesicKm(home, work)).toBeCloseTo(geodesicKm(work, home), 6);
    expect(geodesicKm(home, home)).toBe(0);
  });
});

describe("only document forms carry a fingerprint", () => {
  it("fingerprints receipts and disposal tickets, not events", () => {
    expect(isDocumentForm("expense_receipt")).toBe(true);
    expect(isDocumentForm("disposal_ticket")).toBe(true);
    expect(isDocumentForm("unload_stop")).toBe(false);
    expect(isDocumentForm("defect_report")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* DB-backed: the gate, the override, the auto-filer, concurrency       */
/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 0;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
let userSeq = 720000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 8 });
});

async function office(): Promise<number> {
  const id = nextUser();
  await grantUserRole({ userId: id, role: "office", scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}

async function entity(owner: number): Promise<number> {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId) VALUES (?, 'Gate Co', 'corporation', 'CA-AB', ?)",
    [key("ENT").slice(0, 40), owner]
  );
  return Number(r.insertId);
}

async function receiptProposal(args: {
  actor: number; entityId: number; vendor: string; date: string; total: number;
  contentSha256?: string | null; evidenceRecordId?: number | null; override?: { by: number; reason: string } | null;
  jobId?: number | null; unitId?: number | null;
}): Promise<string> {
  const proposalId = key("PROP-GATE");
  await pool.execute(
    `INSERT INTO assistantProposals
     (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, targetRecordId, jobId, unitId, createdByUserId, readBack, readBackAcknowledged, commitState,
      duplicateOverride, duplicateOverrideByUserId, duplicateOverrideReason)
     VALUES ('default', 'single_tenant_fallback', ?, 'expense_receipt', 1, 'Receipt', ?, ?, ?, ?, ?, 'ok', 1, 'awaiting_readback', ?, ?, ?)`,
    [proposalId, `ENT-${args.entityId}`, args.entityId, args.jobId ?? null, args.unitId ?? null, args.actor,
     args.override ? 1 : 0, args.override?.by ?? null, args.override?.reason ?? null]
  );
  const fields: Array<[string, string, string | number]> = [
    ["vendorName", "Vendor", args.vendor], ["transactionDate", "Date", args.date],
    ["total", "Total", args.total], ["currency", "Currency", "CAD"],
  ];
  for (const [k, label, v] of fields) {
    await pool.execute(
      `INSERT INTO proposalFields (proposalId, fieldKey, label, fieldValue, \`precision\`, source, confidence, status)
       VALUES (?, ?, ?, ?, 'exact', 'human_corrected', 'high', 'confirmed')`,
      [proposalId, k, label, JSON.stringify(v)]
    );
  }
  if (args.contentSha256 !== undefined || args.evidenceRecordId !== undefined) {
    await pool.execute(
      `INSERT INTO documentExtractions (extractionRef, evidenceRecordId, proposalId, ocrEngine, documentType, contentSha256, extractedAt)
       VALUES (?, ?, ?, 'test', 'expense_receipt', ?, NOW())`,
      [key("EXT").slice(0, 60), args.evidenceRecordId ?? null, proposalId, args.contentSha256 ?? null]
    );
  }
  return proposalId;
}

d("the fingerprint gate is the service's act, not the caller's", () => {
  it("refuses a second photo of the same receipt as a possible duplicate", async () => {
    const actor = await office();
    const entityId = await entity(actor);
    const vendor = key("Petro");
    const first = await receiptProposal({ actor, entityId, vendor, date: "2026-09-09", total: 184.2, contentSha256: key("bytes-a") });
    const r1 = await executeAssistantCommit({ proposalId: first, actorUserId: actor });
    expect(r1.committed, JSON.stringify(r1)).toBe(true);

    // Different bytes, same document. Nobody asked for a duplicate check.
    const second = await receiptProposal({ actor, entityId, vendor: vendor.toUpperCase(), date: "2026-09-09", total: 184.2, contentSha256: key("bytes-b") });
    const r2 = await executeAssistantCommit({ proposalId: second, actorUserId: actor });
    expect(r2.committed).toBe(false);
    if (!r2.committed) {
      expect(r2.duplicate).toBe("possible_duplicate");
      expect(r2.refusals.join(" ")).toContain("a person must confirm");
    }
  });

  it("refuses identical bytes outright, even with an override on file", async () => {
    const actor = await office();
    const entityId = await entity(actor);
    const sha = key("same-bytes");
    const first = await receiptProposal({ actor, entityId, vendor: key("Shell"), date: "2026-09-09", total: 50, contentSha256: sha });
    expect((await executeAssistantCommit({ proposalId: first, actorUserId: actor })).committed).toBe(true);

    const again = await receiptProposal({
      actor, entityId, vendor: key("Shell"), date: "2026-09-10", total: 51, contentSha256: sha,
      override: { by: actor, reason: "I am sure" },
    });
    const r = await executeAssistantCommit({ proposalId: again, actorUserId: actor });
    expect(r.committed).toBe(false);
    if (!r.committed) {
      expect(r.duplicate).toBe("exact_duplicate");
      expect(r.refusals.join(" ")).toContain("identical file, nothing to review");
    }
  });

  it("lets a recorded human override pass a possible duplicate", async () => {
    const actor = await office();
    const entityId = await entity(actor);
    const vendor = key("Husky");
    const first = await receiptProposal({ actor, entityId, vendor, date: "2026-09-09", total: 99, contentSha256: key("x") });
    expect((await executeAssistantCommit({ proposalId: first, actorUserId: actor })).committed).toBe(true);

    const withOverride = await receiptProposal({
      actor, entityId, vendor, date: "2026-09-09", total: 99, contentSha256: key("y"),
      override: { by: actor, reason: "Two fills at the same cardlock, same total" },
    });
    const r = await executeAssistantCommit({ proposalId: withOverride, actorUserId: actor });
    expect(r.committed, JSON.stringify(r)).toBe(true);
  });

  it("ignores an override flag with nobody's name on it", async () => {
    const actor = await office();
    const entityId = await entity(actor);
    const vendor = key("Esso");
    const first = await receiptProposal({ actor, entityId, vendor, date: "2026-09-09", total: 77, contentSha256: key("p") });
    expect((await executeAssistantCommit({ proposalId: first, actorUserId: actor })).committed).toBe(true);

    // duplicateOverride = 1 but no duplicateOverrideByUserId: a flag, not an act.
    const proposalId = await receiptProposal({ actor, entityId, vendor, date: "2026-09-09", total: 77, contentSha256: key("q") });
    await pool.execute("UPDATE assistantProposals SET duplicateOverride = 1, duplicateOverrideByUserId = NULL WHERE proposalId = ?", [proposalId]);
    const r = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(r.committed).toBe(false);
  });

  it("does not fingerprint an event form at all", async () => {
    // A defect report has no document. The gate must not refuse two defect
    // reports about the same unit as "duplicates". Proven by the absence of a
    // fingerprint row for event commits elsewhere in the suite; here, by type.
    expect(isDocumentForm("defect_report")).toBe(false);
  });
});

d("the auto-filer attaches one record to everything it belongs to", () => {
  it("files a receipt under the expense, the books, the worker, the tax year, the job and the unit", async () => {
    const actor = await office();
    const entityId = await entity(actor);
    const [ev] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO evidenceRecords (title, category, storageKey, capturedAt, capturedBy, status) VALUES ('receipt photo', 'receipt', ?, NOW(), ?, 'needs_review')",
      [key("s3").slice(0, 60), actor]
    );
    const evidenceId = Number(ev.insertId);
    // AIL-1A: the job and unit a proposal names are checked against its organization at commit, so
    // they have to exist; ids that name nothing are refused as "not found".
    const [job] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO jobs (jobCode, type, customer, location, status) VALUES (?, 'Hydrovac', 'Fixture Energy', 'Somewhere', 'dispatched')", [key("JOB").slice(0, 32)]
    );
    const [unit] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [key("U").slice(0, 30)]
    );
    const jobId = Number(job.insertId), unitId = Number(unit.insertId);
    const proposalId = await receiptProposal({
      actor, entityId, vendor: key("Vendor"), date: "2026-03-14", total: 120,
      contentSha256: key("c"), evidenceRecordId: evidenceId, jobId, unitId,
    });
    const r = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(r.committed, JSON.stringify(r)).toBe(true);
    if (!r.committed) return;

    const [rels] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT entityType, entityId, entityRef, role FROM evidenceRelationships WHERE evidenceRecordId = ? ORDER BY entityType",
      [evidenceId]
    );
    const byType = new Map(rels.map(x => [x.entityType, x]));
    expect(byType.get("expenseRecord")?.entityId).toBe(r.targetRecordId);
    expect(byType.get("financialEntity")?.entityId).toBe(entityId);
    expect(byType.get("user")?.entityId).toBe(actor);
    expect(byType.get("taxYear")?.entityRef).toBe("2026");
    expect(byType.get("job")?.entityId).toBe(jobId);
    expect(byType.get("unit")?.entityId).toBe(unitId);

    // One evidence record. Zero copies.
    const [count] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRecords WHERE id = ?", [evidenceId]);
    expect(Number(count[0].n)).toBe(1);

    // And the fingerprint now points at the committed target.
    const [fps] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT targetType, targetRecordId FROM documentFingerprints WHERE proposalId = ?", [proposalId]
    );
    expect(fps[0].targetType).toBe("expense_record");
    expect(Number(fps[0].targetRecordId)).toBe(r.targetRecordId);
  });
});

d("two concurrent commits of one proposal produce one write", () => {
  it("commits once, replays once, and leaves one expense and one receipt", async () => {
    const actor = await office();
    const entityId = await entity(actor);
    const proposalId = await receiptProposal({ actor, entityId, vendor: key("Race"), date: "2026-09-09", total: 33, contentSha256: key("r") });

    const [a, b] = await Promise.all([
      executeAssistantCommit({ proposalId, actorUserId: actor }),
      executeAssistantCommit({ proposalId, actorUserId: actor }),
    ]);
    const results = [a, b];
    const committed = results.filter(x => x.committed);
    expect(committed).toHaveLength(2);
    // Exactly one performed the write; the other observed it.
    const replayed = committed.filter(x => x.committed && x.replayed);
    expect(replayed).toHaveLength(1);

    const [exp] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM expenseRecords WHERE expenseRef = ?", [`EXP-AI-${proposalId.slice(0, 40)}`]
    );
    expect(Number(exp[0].n)).toBe(1);
    const [rc] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM assistantCommitReceipts WHERE proposalId = ?", [proposalId]
    );
    expect(Number(rc[0].n)).toBe(1);
    const [fp] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM documentFingerprints WHERE proposalId = ?", [proposalId]
    );
    expect(Number(fp[0].n)).toBe(1);
  });
});

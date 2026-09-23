/**
 * 0169 — the driver portfolio reaches dispatch through the one gate.
 *
 * These go through `composeReadiness` against the migrated database, so what
 * they prove is that a requirement bound to a customer, a unit type or a job
 * becomes a blocker in the same eligibility every award already reads, and
 * that nothing in the portfolio is a second verdict beside it.
 *
 * Every binding here names a customer, a vehicle type or a job created for the
 * test. None is a company (`*`) binding: suites run concurrently against one
 * database, and a company binding would apply to every other suite's operator.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { composeReadiness } from "./readinessComposer";
import { dispatchView } from "./_core/driverPortfolio";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const NOW = new Date("2026-09-23T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4, timezone: "Z" }); });

async function world(opts: { userId?: number | null; orgRef?: string | null } = {}) {
  const customer = key("Client ABC");
  const vehicleType = key("tri-drive vac");
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, ?, 'current', 'clear', NOW())", [key("VAC").slice(0, 40), vehicleType]);
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId, licenseClass, createdAt) VALUES (?, ?, '1', NOW())", [key("Op").slice(0, 60), opts.userId ?? null]);
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, orgRef, type, mode, customer, location, createdAt) VALUES (?, ?, 'vac service', 'hydrovac', ?, 'Christina Lake', NOW())", [key("26").slice(0, 32), opts.orgRef ?? null, customer]);
  return { customer, vehicleType, unitId: Number(u.insertId), operatorId: Number(o.insertId), jobId: Number(j.insertId) };
}

async function bind(subjectType: string, subjectCode: string, kind: string, code: string, enforcement: "mandatory" | "informational" = "mandatory", label: string | null = null, orgRef: string | null = null) {
  await pool.execute(
    "INSERT INTO driverRequirementBindings (bindingRef, orgRef, subjectType, subjectCode, requirementKind, requirementCode, label, enforcement, active, createdByUserId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, true, 1, NOW())",
    [key("DRB"), orgRef, subjectType, subjectCode, kind, code, label, enforcement],
  );
}

async function credential(operatorId: number, docType: string, expiresAt: Date | null, status: "verified" | "needs_review" = "verified") {
  await pool.execute(
    "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus, verifiedByUserId, verifiedAt, createdAt) VALUES ('operator', ?, ?, ?, ?, ?, ?, ?, ?, NOW())",
    [operatorId, docType, docType, days(-30), expiresAt, status, status === "verified" ? 2 : null, status === "verified" ? days(-29) : null],
  );
}

d("a customer's mandatory ticket is a blocker in the one eligibility", () => {
  it("blocks with no override while the ticket is missing, clears once it is verified, and the fingerprint moves", async () => {
    const w = await world();
    await bind("customer", w.customer, "credential", "h2s_alive");
    const subject = { operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: w.jobId };

    const before = await composeReadiness(subject, NOW);
    const b = before.eligibility.blockers.find(x => x.code === "driver_credential_h2s_alive_missing");
    expect(b).toMatchObject({ severity: "blocking", overridable: false, subject: "operator" });
    expect(b!.label).toContain(`customer ${w.customer}`);
    expect(before.eligibility.verdict).toBe("blocked");
    expect(before.driverReadiness.items.map(i => i.code)).toEqual(["h2s_alive"]);
    expect(before.contributions.some(c => c.engine === "portfolio")).toBe(true);

    await credential(w.operatorId, "h2s_alive", days(400));
    const after = await composeReadiness(subject, NOW);
    expect(after.eligibility.blockers.some(x => x.code.startsWith("driver_credential_h2s_alive"))).toBe(false);
    expect(after.driverReadiness.items[0]).toMatchObject({ satisfied: true });
    // The award refuses a fingerprint computed before the ticket was on file.
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("an informational requirement is shown and never blocks", async () => {
    const w = await world();
    await bind("customer", w.customer, "credential", "confined_space", "informational");
    const r = await composeReadiness({ operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: w.jobId }, NOW);
    expect(r.eligibility.blockers.some(x => x.code.startsWith("driver_"))).toBe(false);
    expect(r.driverReadiness.notices.map(n => [n.code, n.state])).toEqual([["confined_space", "missing"]]);
  });

  it("another organization's binding for the same customer does not reach this job", async () => {
    const w = await world({ orgRef: key("ORG-A").slice(0, 60) });
    await bind("customer", w.customer, "credential", "whmis", "mandatory", null, key("ORG-B").slice(0, 60));
    await bind("customer", w.customer, "credential", "csts"); // the single tenant's, not ORG-A's
    const r = await composeReadiness({ operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: w.jobId }, NOW);
    expect(r.driverReadiness.items).toEqual([]);
  });

  it("a binding for another customer does not reach this job", async () => {
    const w = await world();
    await bind("customer", key("Someone Else"), "credential", "fall_protection");
    const r = await composeReadiness({ operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: w.jobId }, NOW);
    expect(r.driverReadiness.items).toEqual([]);
  });

  it("a ticket lapsing before the work ends blocks when the caller says when it ends", async () => {
    const w = await world();
    await bind("customer", w.customer, "credential", "first_aid_cpr");
    await credential(w.operatorId, "first_aid_cpr", days(2));
    const subject = { operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: w.jobId };
    const plain = await composeReadiness(subject, NOW);
    expect(plain.eligibility.blockers.some(x => x.code.startsWith("driver_credential_first_aid"))).toBe(false);
    const long = await composeReadiness({ ...subject, workEndsAt: days(5) }, NOW);
    expect(long.eligibility.blockers.find(x => x.code === "driver_credential_first_aid_cpr_expires_during_job")).toMatchObject({ severity: "blocking", overridable: false });
  });

  it("the dispatch view of the same answer carries no certificate detail", async () => {
    const w = await world();
    await bind("job", String(w.jobId), "credential", "h2s_alive", "mandatory", "Client ABC H2S Orientation");
    await pool.execute(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, identifier, capturedAt, expiresAt, verificationStatus, createdAt) VALUES ('operator', ?, 'h2s_alive', 'H2S', 'H2S-SECRET-4411', ?, ?, 'verified', NOW())",
      [w.operatorId, days(-10), days(300)],
    );
    const r = await composeReadiness({ operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: w.jobId }, NOW);
    const v = dispatchView(r.driverReadiness);
    expect(v.lines).toEqual([expect.objectContaining({ label: "Client ABC H2S Orientation", ok: true, mandatory: true })]);
    expect(JSON.stringify(v)).not.toContain("H2S-SECRET-4411");
  });
});

d("equipment qualifications come from the authorizations already on record", () => {
  it("training required blocks; an unlinked operator is unknown rather than 'not authorized'", async () => {
    const userId = 900_000 + Math.floor(Math.random() * 90_000);
    const w = await world({ userId });
    await bind("equipment", w.vehicleType, "equipment", "tri_drive_vac_truck");
    await pool.execute(
      "INSERT INTO operatorEquipmentAuthorizations (authorizationRef, userId, financialEntityId, equipmentType, status, createdAt) VALUES (?, ?, 1, 'tri_drive_vac_truck', 'pending', NOW())",
      [key("OEA").slice(0, 64), userId],
    );
    const r = await composeReadiness({ operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: w.jobId }, NOW);
    expect(r.eligibility.blockers.find(x => x.code === "driver_equipment_tri_drive_vac_truck_training_required")).toMatchObject({ severity: "blocking", overridable: false });

    const unlinked = await world({ userId: null });
    await bind("equipment", unlinked.vehicleType, "equipment", "tri_drive_vac_truck");
    const u = await composeReadiness({ operatorId: unlinked.operatorId, unitId: unlinked.unitId, trailerId: null, jobId: unlinked.jobId }, NOW);
    expect(u.eligibility.blockers.find(x => x.code === "portfolio_operator_unlinked")).toMatchObject({ severity: "unknown" });
    expect(u.eligibility.blockers.some(x => x.code.startsWith("driver_equipment_"))).toBe(false);
  });
});

d("the portfolio's history is append-only in the database", () => {
  it("refuses an update or a delete that arrives around the router", async () => {
    const ref = key("DPE");
    await pool.execute("INSERT INTO driverPortfolioEvents (eventRef, operatorId, eventType, detail, occurredAt, createdAt) VALUES (?, 1, 'credential_verified', 'Verified by Safety Admin', NOW(), NOW())", [ref]);
    await expect(pool.execute("UPDATE driverPortfolioEvents SET detail = 'nothing happened' WHERE eventRef = ?", [ref])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM driverPortfolioEvents WHERE eventRef = ?", [ref])).rejects.toThrow(/append-only/);
  });
});

/**
 * P8.3 — the paper-log fallback, and the line it must not cross.
 *
 * A carrier running paper has no live hours figure. The owner decision says dispatch's HOS check
 * degrades to a manual attestation recording who attested and when, with provenance `attested`,
 * not `computed`. Everything here defends that last clause: a person's word may satisfy the check,
 * and it may never become a number the system appears to have measured.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { composeReadiness } from "./readinessComposer";
import { evaluateDispatchReadiness } from "./_core/dispatchReadiness";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let nextId = 940_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 8);
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = ++nextId;
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}

const TRUCK = {
  unitNumber: "VAC-27",
  inspection: { label: "Annual inspection", present: true, expiresAt: new Date("2030-01-01") },
  registration: { label: "Registration", present: true, expiresAt: new Date("2030-01-01") },
  insurance: { label: "Insurance", present: true, expiresAt: new Date("2030-01-01") },
  maintenanceOverdue: false, criticalDefectOpen: false,
  mechanicReleaseRequired: false, mechanicReleaseGiven: false,
};

const JOB = {
  classificationComplete: true, dangerousGoods: false, tdgDocumentPrepared: null,
  requiredDocumentsPresent: true, permitRequired: false, permitOnFile: null,
  destinationAcceptanceVerified: true, emergencyPlanOnFile: true,
};

const baseOperator = {
  operatorId: 1, name: "Test", licence: { label: "Driver licence", present: true, expiresAt: new Date("2030-01-01") },
  requiredCredentials: [], hoursAvailableMinutes: null, projectedJobMinutes: null, availabilityDeclared: true,
};

describe("an attestation is a statement, not a measurement", () => {
  const input = (attestation: unknown) => ({
    evaluatedAt: new Date("2026-09-18T12:00:00Z"),
    operator: { ...baseOperator, hoursAttestation: attestation as never },
    truck: TRUCK, trailer: null, job: JOB,
    route: { dispatchStatus: null, dataTrustworthy: null },
  } as never);

  it("answers unknown when nobody has said anything", () => {
    const r = evaluateDispatchReadiness(input(null));
    expect(r.blockers.some(b => b.code === "hos_unknown")).toBe(true);
    expect(r.blockers.some(b => b.code === "hos_attested")).toBe(false);
  });

  it("answers attested — as review, not clear — when a named person has", () => {
    const r = evaluateDispatchReadiness(input({
      attestedByUserId: 77, attestedAt: new Date("2026-09-18T06:00:00Z"), dutyDate: "2026-09-18",
      method: "paper_log_reviewed", statement: "Reviewed his book for today; two hours used.", minutesStated: 480,
    }));
    const att = r.blockers.find(b => b.code === "hos_attested")!;
    expect(att, "the attestation must be visible, not silently clear the check").toBeTruthy();
    // Review, not absent: the check was satisfied by a person's word and that stays on screen.
    expect(att.severity).toBe("review");
    expect(r.blockers.some(b => b.code === "hos_unknown")).toBe(false);
    // Who, when, how, and the words "stated, not computed" on the label itself.
    expect(att.label).toMatch(/attested by user 77 for 2026-09-18/);
    expect(att.label).toMatch(/paper log reviewed/);
    expect(att.label).toMatch(/stated 480 min/);
    expect(att.label).toMatch(/stated, not computed/);
  });

  it("accepts an attestation that gives no figure, because reviewing a book is not totalling it", () => {
    const r = evaluateDispatchReadiness(input({
      attestedByUserId: 5, attestedAt: new Date(), dutyDate: "2026-09-18",
      method: "driver_declaration", statement: "Driver states he is inside his hours for today.", minutesStated: null,
    }));
    const att = r.blockers.find(b => b.code === "hos_attested")!;
    expect(att.label).not.toMatch(/stated .* min/);
    expect(att.severity).toBe("review");
  });

  it("never lets a stated figure act as a computed one", () => {
    // The insufficient-hours rule compares a computed figure. A stated one must not reach it: an
    // attestation of 30 minutes against a 480-minute job is a conversation, not a hard block from
    // a number nobody measured.
    const r = evaluateDispatchReadiness({
      evaluatedAt: new Date(), truck: TRUCK, trailer: null, job: JOB,
      route: { dispatchStatus: null, dataTrustworthy: null },
      operator: {
        ...baseOperator, hoursAvailableMinutes: null, projectedJobMinutes: 480,
        hoursAttestation: { attestedByUserId: 9, attestedAt: new Date(), dutyDate: "2026-09-18", method: "paper_log_reviewed", statement: "Book reviewed, little left today.", minutesStated: 30 },
      },
    } as never);
    expect(r.blockers.some(b => b.code === "hos_insufficient"), "a stated figure must not drive the computed comparison").toBe(false);
    expect(r.blockers.some(b => b.code === "hos_attested")).toBe(true);
  });
});

d("recording an attestation, end to end", () => {
  it("records who, when and what was said, and reaches the readiness engine", async () => {
    const dispatcher = await withRole("dispatcher");
    const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [`Paper ${rnd()}`]);
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd().toUpperCase()}`]);
    const operatorId = Number(o.insertId);
    const today = new Date().toISOString().slice(0, 10);

    const before = await composeReadiness({ operatorId, unitId: Number(u.insertId), trailerId: null, jobId: null });
    expect(before.eligibility.blockers.some(b => b.code === "hos_unknown")).toBe(true);

    const r = await callerFor(dispatcher).hos.attestHours({
      operatorId, dutyDate: today, method: "paper_log_reviewed",
      statement: "Reviewed the paper log book for today before assigning the run.",
      hoursAvailableMinutesStated: 420,
    });
    expect(r.provenance).toBe("attested");
    expect(r.note).toMatch(/not a computed hours figure/);

    const after = await composeReadiness({ operatorId, unitId: Number(u.insertId), trailerId: null, jobId: null });
    expect(after.eligibility.blockers.some(b => b.code === "hos_unknown")).toBe(false);
    const att = after.eligibility.blockers.find(b => b.code === "hos_attested")!;
    expect(att.label).toMatch(new RegExp(`attested by user ${dispatcher}`));
    expect(after.contributions.some(c => c.engine === "hos" && /stated, not computed/.test(c.finding))).toBe(true);

    // The stated figure stays stated: nothing wrote it into the computed field.
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT hoursAvailableMinutesStated FROM hosAttestations WHERE id = ?", [r.attestationId]);
    expect(row[0]!.hoursAvailableMinutesStated).toBe(420);
    expect(JSON.stringify(after.eligibility.blockers)).not.toMatch(/hoursAvailableMinutes":420/);
  }, 90_000);

  it("scopes an attestation to its duty day, so yesterday's word does not cover today", async () => {
    const dispatcher = await withRole("dispatcher");
    const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [`Paper ${rnd()}`]);
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd().toUpperCase()}`]);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await callerFor(dispatcher).hos.attestHours({
      operatorId: Number(o.insertId), dutyDate: yesterday, method: "paper_log_reviewed",
      statement: "Reviewed the book for yesterday's shift, all in order.",
    });
    const r = await composeReadiness({ operatorId: Number(o.insertId), unitId: Number(u.insertId), trailerId: null, jobId: null });
    // Hours are a daily fact; a lookup ignoring the date would let one statement cover a week.
    expect(r.eligibility.blockers.some(b => b.code === "hos_unknown")).toBe(true);
    expect(r.eligibility.blockers.some(b => b.code === "hos_attested")).toBe(false);
  }, 90_000);

  it("supersedes rather than edits a correction, and refuses the future", async () => {
    const dispatcher = await withRole("dispatcher");
    const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [`Paper ${rnd()}`]);
    const operatorId = Number(o.insertId);
    const today = new Date().toISOString().slice(0, 10);
    const first = await callerFor(dispatcher).hos.attestHours({
      operatorId, dutyDate: today, method: "driver_declaration",
      statement: "Driver says he is well inside his hours today.", hoursAvailableMinutesStated: 600,
    });
    const second = await callerFor(dispatcher).hos.attestHours({
      operatorId, dutyDate: today, method: "paper_log_reviewed",
      statement: "Checked the book myself; less than he thought.", hoursAvailableMinutesStated: 300,
    });
    expect(second.supersededCount).toBe(1);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT id, supersededAt, supersededByAttestationId, hoursAvailableMinutesStated FROM hosAttestations WHERE operatorId = ? ORDER BY id", [operatorId]);
    expect(rows.length).toBe(2);                                  // both statements survive
    expect(rows[0]!.supersededAt).not.toBeNull();
    expect(rows[0]!.supersededByAttestationId).toBe(second.attestationId);
    expect(rows[0]!.hoursAvailableMinutesStated).toBe(600);       // the first is not rewritten

    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await expect(callerFor(dispatcher).hos.attestHours({
      operatorId, dutyDate: future, method: "paper_log_reviewed",
      statement: "Attesting a day that has not happened yet.",
    })).rejects.toThrow(/future cannot be attested/);
  }, 90_000);
});

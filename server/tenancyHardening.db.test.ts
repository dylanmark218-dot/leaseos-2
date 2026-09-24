/**
 * AIL-1A.1 — tenancy and context hardening, against a real database.
 *
 * Three separate properties, tested separately:
 *   1. USER A's question cannot become USER B's context (raw assistant history is the asker's).
 *   2. ORGANIZATION A's data cannot become ORGANIZATION B's search results, timeline, chain or
 *      duplicate match.
 *   3. Learned data cannot become SYSTEM instruction — pure, in `contextAuthority.test.ts`.
 *
 * Refusal, not filtering after the fact: each unscoped query now carries its tenant condition, so the
 * other organization's row is never returned. Evidence: docs/register/AIL_1A1_TENANCY_HARDENING.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { executeAssistantCommit } from "./_core/assistantCommitService";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 331_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function person(orgRef: string | null, roles = ["management", "office", "dispatcher", "safety", "bookkeeper"]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function jobOf(orgRef: string | null, jobCode = `JOB-${rnd()}`) { const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [jobCode, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]); return j.insertId; }
async function unitOf(orgRef: string | null, unitNumber = `U-${rnd()}`) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [unitNumber, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}
async function loadOf(jobId: number, loadNumber: string, unitId: number | null = null) {
  const [l] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, unitId, material) VALUES (?, ?, ?, 'drill cuttings')", [loadNumber, jobId, unitId]);
  return l.insertId;
}
async function facility() { const [f] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'unknown')", [`F ${rnd()}`]); return f.insertId; }
async function ticketOf(o: { loadId?: number | null; jobId?: number | null; unitId?: number | null; ticketNumber: string }) {
  const [t] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO disposalTickets (ticketNumber, loadId, jobId, unitId, facilityId, scaleInAt, quantity, quantityUnit, verificationStatus, source) VALUES (?,?,?,?,?,NOW(),1,'m3','verified','scale_ticket')",
    [o.ticketNumber, o.loadId ?? null, o.jobId ?? null, o.unitId ?? null, await facility()],
  );
  return t.insertId;
}
async function askOf(tenantId: string | null, askedByUserId: number, question: string) {
  const queryRef = `ASK-${rnd()}`;
  await pool.execute(
    "INSERT INTO assistantQueries (queryRef, tenantId, askedByUserId, question, verdict, passagesRetrieved, passagesSupporting, citedPassageRefsJson, askedAt) VALUES (?,?,?,?,'insufficient_evidence',0,0,'[]',NOW())",
    [queryRef, tenantId, askedByUserId, question],
  );
  return queryRef;
}
const refsOf = async (userId: number) => (await callerFor(userId).assistantAsk.history({ limit: 100 })).queries.map(q => q.queryRef);

d("1. a person's raw assistant history is theirs alone", () => {
  it("shows me my questions, and nobody else's — not a colleague's, not another company's", async () => {
    const A = await org(), B = await org();
    const a1 = await person(A), a2 = await person(A), b1 = await person(B);
    const mine = await askOf(A, a1, "what is the H2S limit at Bluebird?");
    const colleague = await askOf(A, a2, "can I skip the pre-trip today?");
    const otherCompany = await askOf(B, b1, "where does ClearWater take invert?");
    const a1Sees = await refsOf(a1);
    expect(a1Sees).toContain(mine);
    expect(a1Sees).not.toContain(colleague);
    expect(a1Sees).not.toContain(otherCompany);
    expect(await refsOf(a2)).toEqual(expect.arrayContaining([colleague]));
    expect(await refsOf(a2)).not.toContain(mine);
    expect(await refsOf(b1)).not.toContain(mine);
  });

  it("does not open to managers just because they are managers", async () => {
    const A = await org();
    const driver = await person(A, ["driver"]);
    const manager = await person(A, ["management", "safety", "office", "controller"]);
    const q = await askOf(A, driver, "my question");
    expect(await refsOf(manager)).not.toContain(q);
  });

  it("refuses a forged user or organization in the request instead of ignoring it", async () => {
    const A = await org(), B = await org();
    const a1 = await person(A), a2 = await person(A);
    await askOf(A, a1, "mine");
    for (const forged of [{ askedByUserId: a1 }, { userId: a1 }, { tenantId: B }, { organizationId: B }]) {
      await expect(callerFor(a2).assistantAsk.history({ limit: 10, ...forged } as never), JSON.stringify(forged)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("will not let a curator copy someone else's raw question into the organization's probe set", async () => {
    const A = await org();
    const driver = await person(A, ["driver"]);
    const curator = await person(A, ["management"]);
    const q = await askOf(A, driver, "a driver's own words");
    await expect(callerFor(curator).assistantAsk.addProbeFromAsk({ queryRef: q, expectedPassageRefs: ["P-1"] }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "No such recorded question" });
  });

  it("leaves a question with no recorded organization visible to nobody, its asker included", async () => {
    const legacy = await person(null);
    const orphan = await askOf(null, legacy, "asked before tenancy");
    expect(await refsOf(legacy)).not.toContain(orphan);
  });
});

d("2. search returns only the caller's organization's records", () => {
  it("finds A's job, unit and load for A and none of them for B or the single tenant", async () => {
    const A = await org(), B = await org();
    const a1 = await person(A), b1 = await person(B), legacy = await person(null);
    const marker = `HARD${rnd()}`;
    const jobA = await jobOf(A, `JOB-${marker}`);
    await unitOf(A, `U-${marker}`);
    await loadOf(jobA, `LD-${marker}`);
    const hits = async (who: number) => (await callerFor(who).surfaces.search({ q: marker })).hits.map(h => h.entityType).sort();
    expect(await hits(a1)).toEqual(["job", "load", "unit"]);
    expect(await hits(b1)).toEqual([]);
    expect(await hits(legacy)).toEqual([]);
  });

  it("keeps unowned legacy rows to the single tenant, never to an organization", async () => {
    const A = await org();
    const a1 = await person(A), legacy = await person(null);
    const marker = `LEG${rnd()}`;
    await jobOf(null, `JOB-${marker}`);
    expect((await callerFor(legacy).surfaces.search({ q: marker })).hits.map(h => h.entityType)).toEqual(["job"]);
    expect((await callerFor(a1).surfaces.search({ q: marker })).hits).toEqual([]);
  });

  it("does not show B a record that names A's job and B's unit", async () => {
    const A = await org(), B = await org();
    const b1 = await person(B);
    const marker = `MIX${rnd()}`;
    await loadOf(await jobOf(A), `LD-${marker}`, await unitOf(B));
    expect((await callerFor(b1).surfaces.search({ q: marker })).hits).toEqual([]);
  });
});

d("2. timeline and chain stay inside the caller's organization", () => {
  it("gives B no timeline for A's job, and keeps a ticket naming B's unit off A's job timeline", async () => {
    const A = await org(), B = await org();
    const a1 = await person(A), b1 = await person(B);
    const jobA = await jobOf(A);
    await loadOf(jobA, `LD-${rnd()}`);
    const foreignTicket = `DT-${rnd()}`;
    await ticketOf({ jobId: jobA, unitId: await unitOf(B), ticketNumber: foreignTicket });
    const aEvents = (await callerFor(a1).surfaces.timeline({ entityType: "job", entityId: jobA })).events;
    expect(aEvents.some(e => e.kind === "load")).toBe(true);
    expect(aEvents.some(e => e.ref === foreignTicket)).toBe(false);
    expect((await callerFor(b1).surfaces.timeline({ entityType: "job", entityId: jobA })).total).toBe(0);
    // B's own trip, mis-linked to A's job, does not let B use A's job as a timeline anchor: A's job has
    // no timeline for B at all, exactly like a job that does not exist.
    await pool.execute("INSERT INTO trips (tripNumber, tripType, status, orgRef, jobId) VALUES (?, 'one_way', 'planned', ?, ?)", [`TRP-${rnd()}`, B, jobA]);
    expect((await callerFor(b1).surfaces.timeline({ entityType: "job", entityId: jobA })).total).toBe(0);
  });

  it("walks A's chain for A, and gives B nothing for the same load or ticket", async () => {
    const A = await org(), B = await org();
    const a1 = await person(A), b1 = await person(B);
    const loadA = await loadOf(await jobOf(A), `LD-${rnd()}`);
    const ticketA = await ticketOf({ loadId: loadA, ticketNumber: `DT-${rnd()}` });
    const forA = await callerFor(a1).surfaces.chain({ entityType: "load", entityId: loadA });
    expect(forA.nodes.length).toBeGreaterThan(0);
    for (const anchor of [{ entityType: "load" as const, entityId: loadA }, { entityType: "disposal_ticket" as const, entityId: ticketA }]) {
      const forB = await callerFor(b1).surfaces.chain(anchor);
      expect(forB.nodes, JSON.stringify(anchor)).toEqual([]);
    }
  });
});

d("2. duplicate-document matching stays inside the organization", () => {
  async function receipt(tenantId: string, actor: number, vendor: string) {
    const [ent] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId, orgRef) VALUES (?, 'Receipt Co', 'corporation', 'CA-AB', ?, ?)",
      [`ENT-${rnd()}`, actor, tenantId],
    );
    const proposalId = `PROP-DUP-${rnd()}`;
    await pool.execute(
      "INSERT INTO assistantProposals (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, targetRecordId, createdByUserId, readBack, readBackAcknowledged, commitState) VALUES (?, 'membership', ?, 'expense_receipt', 1, 'Expense receipt', 'ENT', ?, ?, 'rb', 1, 'awaiting_readback')",
      [tenantId, proposalId, ent.insertId, actor],
    );
    for (const [k, v] of [["vendorName", vendor], ["transactionDate", "2026-09-08"], ["total", 546], ["subtotal", 520], ["salesTaxAmount", 26], ["currency", "CAD"]] as const) {
      await pool.execute("INSERT INTO proposalFields (proposalId, fieldKey, label, fieldValue, `precision`, source, confidence, status) VALUES (?, ?, ?, ?, 'exact', 'human_corrected', 'high', 'confirmed')", [proposalId, k, k, JSON.stringify(v)]);
    }
    return proposalId;
  }

  it("does not refuse B's receipt, or show B anything, because A filed the same one", async () => {
    const A = await org(), B = await org();
    const a1 = await person(A, ["bookkeeper"]), b1 = await person(B, ["bookkeeper"]);
    const vendor = `Fuel Stop ${rnd()}`;
    expect(await executeAssistantCommit({ proposalId: await receipt(A, a1, vendor), actorUserId: a1 })).toMatchObject({ committed: true });
    // Same vendor, date and total in another organization: its own document, not a duplicate of A's.
    const inB = await executeAssistantCommit({ proposalId: await receipt(B, b1, vendor), actorUserId: b1 });
    expect(inB, JSON.stringify(inB)).toMatchObject({ committed: true });
    // Control: the gate still works inside one organization.
    const againInA = await executeAssistantCommit({ proposalId: await receipt(A, a1, vendor), actorUserId: a1 });
    expect(againInA.committed).toBe(false);
    if (!againInA.committed) expect(againInA.refusals.join(" ")).toContain("Duplicate gate");
  });
});

d("GLOBAL reference data stays intentionally global", () => {
  it("shows a public facility's official aliases to every organization", async () => {
    const A = await org(), B = await org();
    const a1 = await person(A), b1 = await person(B);
    const facilityKey = `FAC-${rnd()}`;
    const [f] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (facilityKey, name, status) VALUES (?, ?, 'unknown')", [facilityKey, `Public ${facilityKey}`]);
    await pool.execute("INSERT INTO facilityAliases (facilityId, alias, relationship) VALUES (?, 'Former operator name', 'former_operator')", [f.insertId]);
    for (const who of [a1, b1]) {
      const got = await callerFor(who).facilityDirectory.get({ facilityKey });
      expect(got.aliases.map(x => x.alias)).toEqual(["Former operator name"]);
    }
  });
});

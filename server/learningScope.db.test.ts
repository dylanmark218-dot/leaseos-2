/**
 * AIL-1A — who owns learning, against a real database: two organizations, a person in each, two people
 * in one, a person with no membership (the single tenant), a person in two organizations, forged ids,
 * a legacy row nobody proved the owner of, and assistant proposals across the boundary.
 *
 * Refusal, not filtering after the fact: every cross-boundary case below either never reaches the row
 * (the query carries the tenant) or is answered "not found" before anything is read or written.
 *
 * The model is replaced with a fixed response, because what is under test is what the server does with
 * the model's output — and the fixed response carries identity keys of its own to prove they are ignored.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          // A model trying to place its output in another organization. parseExtraction reads only
          // `fields` and `notes`, and the owner is stamped from the session — so none of this lands.
          organizationId: "ORG-SOMEONE-ELSE", tenantId: "ORG-SOMEONE-ELSE", userId: 1, createdByUserId: 1,
          fields: {
            unitNumber: { value: "T-12", sourceUtterance: "unit twelve", confidence: "high" },
            system: { value: "Brakes", sourceUtterance: "brakes", confidence: "high" },
            observation: { value: "Air leak at the rear chamber", sourceUtterance: "hissing at the back", confidence: "high" },
            isNew: { value: true, sourceUtterance: "wasn't there yesterday", confidence: "high" },
          },
          notes: null,
        }),
      },
    }],
  })),
}));

import { appRouter } from "./routers";
import { getDb, listPendingProposals, sessionJobSubjectInScope } from "./db";
import { executeAssistantCommit } from "./_core/assistantCommitService";
import { loadExceptionSources } from "./surfacesService";
import { LearningScopeRefused, resolveLearningScope, type ScopeRefusalCode } from "./_core/learningScope";
import { routeLearning } from "./_core/knowledge/perimeter";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 318_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function person(orgRefs: (string | null)[], roles = ["management", "office", "driver"]) {
  const userId = seq++;
  for (const orgRef of orgRefs) {
    if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  }
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function jobOf(orgRef: string | null) { const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]); return j.insertId; }
async function tripOf(orgRef: string | null) { const [t] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, tripType, status, orgRef) VALUES (?,'one_way','planned',?)", [`TRP-${rnd()}`, orgRef]); return t.insertId; }
async function unitOf(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}
async function runOf(tenantId: string | null, userId: number) {
  const runRef = `AR-${rnd()}`;
  await pool.execute("INSERT INTO agentRuns (runRef, tenantId, agentKey, goal, status, initiatedByUserId) VALUES (?,?,?,?,'created',?)", [runRef, tenantId, "secretary", "fixture run", userId]);
  return runRef;
}
/** A proposal row as a draft would leave it, owned by `tenantId` — or a legacy row with none. */
async function proposalOf(tenantId: string | null, createdBy: number, o: { state?: string; tripId?: number | null } = {}) {
  const proposalId = `PRP-${rnd()}`;
  const derived = tenantId === null ? "legacy_unresolved" : tenantId === "default" ? "single_tenant_fallback" : "membership";
  await pool.execute(
    "INSERT INTO assistantProposals (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, tripId, createdByUserId, readBack, readBackAcknowledged, commitState) VALUES (?,?,?,'defect_report',1,'Defect report','UNIT',?,?,'rb',1,?)",
    [tenantId, derived, proposalId, o.tripId ?? null, createdBy, o.state ?? "awaiting_readback"],
  );
  return proposalId;
}
async function refusedWith(code: ScopeRefusalCode, run: () => Promise<unknown>) {
  await expect(run()).rejects.toSatisfy((e: unknown) => e instanceof LearningScopeRefused && e.code === code);
}
const scope = async (userId: number, request: Parameters<typeof resolveLearningScope>[0]["request"]) =>
  resolveLearningScope({ db: (await getDb())!, userId, request, verifySubject: sessionJobSubjectInScope });

d("the trusted scope resolver, against real memberships", () => {
  it("derives the organization from the membership, and the single tenant from its absence", async () => {
    const A = await org();
    const a1 = await person([A]);
    const legacy = await person([null]);
    expect(await scope(a1, { kind: "ORGANIZATION" })).toMatchObject({ kind: "ORGANIZATION", orgRef: A, derivedFrom: "membership" });
    expect(await scope(a1, { kind: "USER" })).toMatchObject({ kind: "USER", orgRef: A, userId: a1 });
    expect(await scope(legacy, { kind: "ORGANIZATION" })).toMatchObject({ orgRef: "default", derivedFrom: "single_tenant_fallback" });
  });

  it("refuses a person in two organizations rather than choosing one", async () => {
    const A = await org(), B = await org();
    const both = await person([A, B]);
    await refusedWith("AMBIGUOUS_ORGANIZATION", () => scope(both, { kind: "ORGANIZATION" }));
  });

  it("refuses a forged organization or user id in the request, even the caller's own (invariant 5)", async () => {
    const A = await org(), B = await org();
    const a1 = await person([A]);
    await refusedWith("SCOPE_IDENTITY_CLAIM_REFUSED", () => scope(a1, { kind: "ORGANIZATION", organizationId: B } as never));
    await refusedWith("SCOPE_IDENTITY_CLAIM_REFUSED", () => scope(a1, { kind: "USER", userId: a1 + 1 } as never));
    await refusedWith("SCOPE_IDENTITY_CLAIM_REFUSED", () => scope(a1, { kind: "ORGANIZATION", orgRef: A } as never));
  });

  it("refuses GLOBAL for every person, whatever roles they hold (invariants 8, 9)", async () => {
    const A = await org();
    const manager = await person([A], ["management", "controller", "safety"]);
    await refusedWith("GLOBAL_REQUIRES_PLATFORM_AUTHORITY", () => scope(manager, { kind: "GLOBAL" }));
  });

  it("anchors a session/job scope only to the organization's own job, trip or run (invariant 7)", async () => {
    const A = await org(), B = await org();
    const a1 = await person([A]), b1 = await person([B]);
    const jobA = await jobOf(A), tripA = await tripOf(A), runA = await runOf(A, a1);
    expect(await scope(a1, { kind: "SESSION_JOB", subject: { kind: "job", ref: String(jobA) } })).toMatchObject({ kind: "SESSION_JOB", orgRef: A, userId: a1 });
    expect(await scope(a1, { kind: "SESSION_JOB", subject: { kind: "trip", ref: String(tripA) } })).toMatchObject({ orgRef: A });
    expect(await scope(a1, { kind: "SESSION_JOB", subject: { kind: "agent_run", ref: runA } })).toMatchObject({ orgRef: A });
    // B asking about A's job, trip or run: not found, exactly as for one that does not exist.
    await refusedWith("SESSION_JOB_SUBJECT_NOT_FOUND", () => scope(b1, { kind: "SESSION_JOB", subject: { kind: "job", ref: String(jobA) } }));
    await refusedWith("SESSION_JOB_SUBJECT_NOT_FOUND", () => scope(b1, { kind: "SESSION_JOB", subject: { kind: "trip", ref: String(tripA) } }));
    await refusedWith("SESSION_JOB_SUBJECT_NOT_FOUND", () => scope(b1, { kind: "SESSION_JOB", subject: { kind: "agent_run", ref: runA } }));
    await refusedWith("SESSION_JOB_SUBJECT_NOT_FOUND", () => scope(a1, { kind: "SESSION_JOB", subject: { kind: "job", ref: "2147483646" } }));
    await refusedWith("SESSION_JOB_SUBJECT_NOT_FOUND", () => scope(a1, { kind: "SESSION_JOB", subject: { kind: "job", ref: `${jobA} OR 1=1` } }));
  });

  it("does not let an agent run with no tenant anchor anybody's session", async () => {
    const A = await org();
    const a1 = await person([A]), legacy = await person([null]);
    const orphan = await runOf(null, a1);
    await refusedWith("SESSION_JOB_SUBJECT_NOT_FOUND", () => scope(a1, { kind: "SESSION_JOB", subject: { kind: "agent_run", ref: orphan } }));
    await refusedWith("SESSION_JOB_SUBJECT_NOT_FOUND", () => scope(legacy, { kind: "SESSION_JOB", subject: { kind: "agent_run", ref: orphan } }));
  });

  it("gives learning intake the owner the server resolved, never the one the claim names (invariant 14)", async () => {
    const A = await org(), B = await org();
    const a1 = await person([A]);
    const owner = await scope(a1, { kind: "ORGANIZATION" });
    if (owner.kind !== "ORGANIZATION") throw new Error("expected an organization scope");
    const decision = routeLearning({ owner, origin: "field_observation", domain: "oilfield_operations", claim: `this belongs to ${B}`, observedAt: new Date(), reportedBy: `user:${a1}` });
    expect(decision.owner).toMatchObject({ kind: "ORGANIZATION", orgRef: A });
  });
});

d("assistant proposals are their organization's alone (invariants 1, 2, 13)", () => {
  it("hides one organization's proposal from another on every read and write path", async () => {
    const A = await org(), B = await org();
    const a1 = await person([A]), b1 = await person([B]);
    const p = await proposalOf(A, a1);
    const notFound = { code: "NOT_FOUND", message: `Proposal ${p} not found` };
    await expect(callerFor(a1).fieldRoute.assistant.get({ proposalId: p })).resolves.toBeTruthy();
    await expect(callerFor(b1).fieldRoute.assistant.get({ proposalId: p })).rejects.toMatchObject(notFound);
    await expect(callerFor(b1).fieldRoute.assistant.answer({ proposalId: p, fieldKey: "observation", value: "x" })).rejects.toMatchObject(notFound);
    await expect(callerFor(b1).fieldRoute.assistant.setStatus({ proposalId: p, fieldKey: "observation", status: "rejected" })).rejects.toMatchObject(notFound);
    await expect(callerFor(b1).fieldRoute.assistant.commit({ proposalId: p })).rejects.toMatchObject(notFound);
    // The service refuses on its own, for a caller that reaches past the procedure.
    expect(await executeAssistantCommit({ proposalId: p, actorUserId: b1 })).toEqual({ committed: false, refusals: ["Proposal not found"] });
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT commitState, tenantId FROM assistantProposals WHERE proposalId = ?", [p]);
    expect(row[0]).toMatchObject({ commitState: "awaiting_readback", tenantId: A });
  });

  it("keeps the review queue, with or without a trip, to the caller's organization", async () => {
    const A = await org(), B = await org();
    const a1 = await person([A]), b1 = await person([B]), legacy = await person([null]);
    const tripA = await tripOf(A);
    const onTrip = await proposalOf(A, a1, { state: "drafting", tripId: tripA });
    const unanchored = await proposalOf(A, a1, { state: "drafting" });
    const aPending = (await callerFor(a1).fieldRoute.assistant.pending()).map(r => r.proposalId);
    expect(aPending).toEqual(expect.arrayContaining([onTrip, unanchored]));
    for (const other of [b1, legacy]) {
      const seen = (await callerFor(other).fieldRoute.assistant.pending()).map(r => r.proposalId);
      expect(seen).not.toContain(onTrip);
      expect(seen).not.toContain(unanchored);
    }
    await expect(callerFor(b1).fieldRoute.assistant.pending({ tripId: tripA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The query itself carries the tenant: B's scope never returns the row, it is not filtered afterwards.
    expect((await listPendingProposals({ tenantId: B })).some(r => r.proposalId === unanchored)).toBe(false);
  });

  it("keeps the exception centre's AI proposals to the caller's organization, and shows none without a scope", async () => {
    const A = await org(), B = await org();
    const a1 = await person([A]);
    const p = await proposalOf(A, a1);
    expect((await loadExceptionSources(new Date(), { tenantId: A })).aiProposals.some(x => x.proposalId === p)).toBe(true);
    expect((await loadExceptionSources(new Date(), { tenantId: B })).aiProposals.some(x => x.proposalId === p)).toBe(false);
    expect((await loadExceptionSources(new Date())).aiProposals).toEqual([]);
  });

  it("leaves a legacy row whose owner was never proved visible to nobody and committable by nobody (invariant 11)", async () => {
    const A = await org();
    const a1 = await person([A]), legacy = await person([null]);
    const orphan = await proposalOf(null, a1);
    for (const who of [a1, legacy]) {
      await expect(callerFor(who).fieldRoute.assistant.get({ proposalId: orphan })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await executeAssistantCommit({ proposalId: orphan, actorUserId: who })).toEqual({ committed: false, refusals: ["Proposal not found"] });
    }
    // NULL is "unresolved", not "global" and not "the single tenant's".
    expect((await listPendingProposals({ tenantId: "default" })).some(r => r.proposalId === orphan)).toBe(false);
  });

  it("re-checks every anchor at commit, so a row never checked at draft cannot write into another organization", async () => {
    // A row stamped A but naming B's trip — what a pre-0185 backfilled row could look like. The owner check
    // passes (it is A's), so only the commit-side anchor re-check stands between it and B's trip.
    const A = await org(), B = await org();
    const a1 = await person([A]);
    const tripB = await tripOf(B);
    const p = await proposalOf(A, a1, { tripId: tripB });
    expect(await executeAssistantCommit({ proposalId: p, actorUserId: a1 })).toEqual({ committed: false, refusals: [`Trip ${tripB} not found`] });
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT commitState FROM assistantProposals WHERE proposalId = ?", [p]);
    expect(row[0].commitState).toBe("awaiting_readback");
    const [receipts] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM assistantCommitReceipts WHERE proposalId = ?", [p]);
    expect(Number(receipts[0].n)).toBe(0);
  });

  it("will not store a tenant without saying how it was established, or a derivation without a tenant", async () => {
    await expect(pool.execute("INSERT INTO assistantProposals (proposalId, formKey, title, targetRef, tenantId) VALUES (?, 'defect_report', 't', 'r', 'ORG-X')", [`PRP-${rnd()}`]))
      .rejects.toMatchObject({ message: expect.stringContaining("assistantProposals_tenant_shape") });
    await expect(pool.execute("INSERT INTO assistantProposals (proposalId, formKey, title, targetRef, tenantDerivedFrom) VALUES (?, 'defect_report', 't', 'r', 'membership')", [`PRP-${rnd()}`]))
      .rejects.toMatchObject({ message: expect.stringContaining("assistantProposals_tenant_shape") });
    // A writer that forgets both lands as the fail-closed marker, visible to nobody.
    const quiet = `PRP-${rnd()}`;
    await pool.execute("INSERT INTO assistantProposals (proposalId, formKey, title, targetRef) VALUES (?, 'defect_report', 't', 'r')", [quiet]);
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT tenantId, tenantDerivedFrom FROM assistantProposals WHERE proposalId = ?", [quiet]);
    expect(row[0]).toEqual({ tenantId: null, tenantDerivedFrom: "legacy_unresolved" });
  });
});

d("a draft is owned by the session's organization, and names only that organization's records (invariants 5, 6)", () => {
  const draft = (who: number, extra: Record<string, unknown> = {}) =>
    callerFor(who).fieldRoute.assistant.draft({ formKey: "defect_report", targetRef: "UNIT T-12", transcript: "unit twelve, brakes, hissing at the back, wasn't there yesterday", ...extra } as never);

  it("stamps the acting organization and how it was derived, whatever the model's output says", async () => {
    const A = await org();
    const a1 = await person([A]), legacy = await person([null]);
    const mine = await draft(a1);
    const [rowA] = await pool.query<mysql.RowDataPacket[]>("SELECT tenantId, tenantDerivedFrom, createdByUserId FROM assistantProposals WHERE proposalId = ?", [mine.proposal.proposalId]);
    expect(rowA[0]).toEqual({ tenantId: A, tenantDerivedFrom: "membership", createdByUserId: a1 });
    const theirs = await draft(legacy);
    const [rowL] = await pool.query<mysql.RowDataPacket[]>("SELECT tenantId, tenantDerivedFrom FROM assistantProposals WHERE proposalId = ?", [theirs.proposal.proposalId]);
    expect(rowL[0]).toEqual({ tenantId: "default", tenantDerivedFrom: "single_tenant_fallback" });
  });

  it("refuses a body that states an owner, rather than dropping it", async () => {
    const A = await org(), B = await org();
    const a1 = await person([A]);
    for (const claim of [{ tenantId: B }, { orgRef: B }, { organizationId: B }, { createdByUserId: a1 + 1 }, { tenantDerivedFrom: "membership" }]) {
      await expect(draft(a1, claim), JSON.stringify(claim)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("refuses another organization's job, trip, unit or trip stop before the model is called", async () => {
    const { invokeLLM } = await import("./_core/llm");
    const A = await org(), B = await org();
    const a1 = await person([A]);
    const jobB = await jobOf(B), tripB = await tripOf(B), unitB = await unitOf(B);
    const [stop] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO tripStops (tripId, stopType, sequence) VALUES (?, 'unload', 1)", [tripB]);
    const before = vi.mocked(invokeLLM).mock.calls.length;
    await expect(draft(a1, { jobId: jobB })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Job ${jobB} not found` });
    await expect(draft(a1, { tripId: tripB })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Trip ${tripB} not found` });
    await expect(draft(a1, { unitId: unitB })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Unit ${unitB} not found` });
    await expect(callerFor(a1).fieldRoute.assistant.draft({ formKey: "unload_stop", targetRef: "stop", transcript: "arrived ten", targetRecordId: stop.insertId } as never))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: `Trip stop ${stop.insertId} not found` });
    // A financial entity is the target of an expense or fuel receipt: B's is not found.
    const [entB] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId, orgRef) VALUES (?, 'B Ltd', 'corporation', 'CA-AB', 1, ?)", [`ENT-${rnd()}`, B],
    );
    await expect(callerFor(a1).fieldRoute.assistant.draft({ formKey: "expense_receipt", targetRef: "ENT", transcript: "receipt", targetRecordId: entB.insertId } as never))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: `Financial entity ${entB.insertId} not found` });
    // A's own trip stop, but on a different trip of A's than the one the draft names: not found either.
    const tripA1 = await tripOf(A), tripA2 = await tripOf(A);
    const [stopA1] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO tripStops (tripId, stopType, sequence) VALUES (?, 'unload', 1)", [tripA1]);
    await expect(callerFor(a1).fieldRoute.assistant.draft({ formKey: "unload_stop", targetRef: "stop", transcript: "arrived ten", tripId: tripA2, targetRecordId: stopA1.insertId } as never))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: `Trip stop ${stopA1.insertId} not found` });
    // Mixing an own anchor with a foreign one is refused too: every anchor is checked, not the first.
    const jobA = await jobOf(A);
    await expect(draft(a1, { jobId: jobA, tripId: tripB })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Trip ${tripB} not found` });
    expect(vi.mocked(invokeLLM).mock.calls.length).toBe(before);
  });
});

d("the 0185 backfill assigns nobody by guesswork", () => {
  it("stamps 'default' only when no membership has ever existed, and leaves everything else unresolved", () => {
    const sql = readFileSync("drizzle/0185_assistant_proposal_tenancy.sql", "utf8").replace(/^--.*$/gm, "");
    const updates = sql.match(/UPDATE[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("SET `tenantId` = 'default', `tenantDerivedFrom` = 'backfill_single_tenant_deployment'");
    expect(updates[0]).toContain("NOT EXISTS (SELECT 1 FROM `organizationMemberships`)");
    // Nothing is inferred from jobs, trips, units or the creator, and nothing becomes global.
    expect(sql).not.toMatch(/jobs|trips|units|createdByUserId|GLOBAL/);
  });
});

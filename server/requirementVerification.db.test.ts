/**
 * C1b-2b — requirement verification through the ledger (owner decision C1b-Q2 = B).
 *
 * Every requirement, instrument and citation below is a **test fixture**, not a verified reading of
 * any law. The numbered cases are the owner's required list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { COMPLIANCE_REQUIREMENT_SEEDS } from "./_core/complianceRequirementSeeds";
import { isSensitivePermission, type DomainRole } from "./_core/recordsAuthorization";
import { grantUserRole } from "./db";
import { governingRevisions, loadRequirementRegistry, supersededAt } from "./requirementRegistry";
import {
  approvalCheck, citationHashOf, levelAt, pendingApprovals, proposeRequirement, recordApproval, resolvePolicy,
  eventsByRequirement,
} from "./requirementVerification";
import { appRouter } from "./routers";

/**
 * F1.1 refuses to evaluate equipment credentials while any organization exists: equipment rows carry no
 * owner, so nothing proves whose they are (`requireProvableOwnership`). The pack cases below are about the
 * registry reaching work authorization, which only has a meaning where that ownership is provable — one
 * ownership domain. They switch it on for themselves alone, and each first asserts the refusal while an
 * organization exists, so the gate is pinned rather than bypassed.
 */
const ownership = vi.hoisted(() => ({ singleDomain: false }));
vi.mock("./ownershipDomain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ownershipDomain")>();
  return {
    ...actual,
    singleOwnershipDomain: async () => ownership.singleDomain || actual.singleOwnershipDomain(),
    requireProvableOwnership: async (what: string, until: string) => (ownership.singleDomain ? undefined : actual.requireProvableOwnership(what, until)),
  };
});
async function asOneOwnershipDomain<T>(body: () => Promise<T>): Promise<T> {
  ownership.singleDomain = true;
  try { return await body(); } finally { ownership.singleDomain = false; }
}

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 886_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
beforeAll(async () => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = userSeq++;
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}
async function member(role: DomainRole, orgRef: string) {
  const id = await withRole(role);
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, id]);
  return id;
}
async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
/**
 * F1.2 — a real operator: `compliance.passport` and `credentialRecord` prove the subject is in the
 * caller's scope, and a made-up id is "not found". Unowned (the single tenant's) unless an
 * organization is named, in which case only that organization sees it.
 */
async function operatorRow(orgRef?: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES ('Requirement fixture', NOW())");
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, r.insertId]);
  return Number(r.insertId);
}
/** F1.1 — a real book: a made-up financial entity is "not found". */
async function entityRow() {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${rnd()}${rnd()}`]);
  return Number(r.insertId);
}

/** A complete, fixture citation. The authority is unique per call so a policy row never leaks between tests. */
const cite = () => ({
  instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
  sourceAuthority: `FIXTURE AUTHORITY ${rnd()}`,
  sourceReference: "s. 1(1)",
  sourceUrl: "https://laws-lois.justice.gc.ca/eng/regulations/FIXTURE/",
  authorityType: "law" as const,
});

type Cast = { proposer: number; v1: number; v2: number; safety: number; dispatcher: number; office: number; subject: number };
let cast: Cast;
beforeAll(async () => {
  if (!DB_URL) return;
  cast = {
    proposer: await withRole("controller"), v1: await withRole("legal"), v2: await withRole("management"),
    safety: await withRole("safety"), dispatcher: await withRole("dispatcher"), office: await withRole("office"),
    subject: await operatorRow(),
  };
});

async function proposal(o: { blocked?: boolean; effectiveFrom?: Date; key?: string; packKey?: string; subjectType?: "operator" | "equipment"; citation?: Partial<ReturnType<typeof cite>>; jurisdiction?: string; by?: number } = {}) {
  const requirementKey = o.key ?? `test.c1b2b.${rnd()}`;
  const jurisdiction = o.jurisdiction ?? `CA-ZZ-${rnd()}`;
  const citation = { ...cite(), ...(o.citation ?? {}) };
  const r = await callerFor(o.by ?? cast.proposer).compliance.requirementLoad({
    requirementKey, family: "test", title: `Fixture ${requirementKey}`, subjectType: o.subjectType ?? "operator", jurisdiction,
    satisfiedByDocTypes: [`fixture_doc_${requirementKey}`], missingSeverity: o.blocked === false ? "review" : "blocked",
    packKey: o.packKey ?? null, effectiveFrom: o.effectiveFrom ?? new Date("2026-01-01T00:00:00Z"), ...citation,
  });
  return { requirementKey, jurisdiction, version: r.version, citation, doc: `fixture_doc_${requirementKey}` };
}
const approval = (p: { requirementKey: string; version: number }, target: "CITATION_VERIFIED" | "SOURCE_DOCUMENT_VERIFIED" = "CITATION_VERIFIED", sourceRevisionRef?: string) =>
  ({ requirementKey: p.requirementKey, version: p.version, target, decision: "approve" as const, reason: "Checked against the cited section", sourceRevisionRef });
const passportItem = async (p: { requirementKey: string; jurisdiction: string }, subjectId = cast.subject, as = cast.dispatcher) =>
  (await callerFor(as).compliance.passport({ subjectType: "operator", subjectId, jurisdiction: p.jurisdiction, attributes: {} }))
    .items.find((i) => i.requirementKey === p.requirementKey);

/* ------------------------------------------------------------------ */
/* Separation of duties                                                */
/* ------------------------------------------------------------------ */

d("who may verify", () => {
  it("1. the proposer cannot verify their own requirement, whatever role they hold", async () => {
    const p = await proposal();
    // The proposer is a controller, which holds verify and second_approve: the refusal is by person.
    await expect(callerFor(cast.proposer).compliance.requirementVerify(approval(p))).rejects.toThrow(/SELF_VERIFICATION/);
    await expect(callerFor(cast.proposer).compliance.requirementSecondApprove(approval(p))).rejects.toThrow(/SELF_VERIFICATION/);
  });

  it("2. one person cannot give both approvals, through either endpoint", async () => {
    const p = await proposal();
    await callerFor(cast.v1).compliance.requirementVerify(approval(p));
    await expect(callerFor(cast.v1).compliance.requirementSecondApprove(approval(p))).rejects.toThrow(/SAME_VERIFIER/);
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(p))).rejects.toThrow(/SAME_VERIFIER/);
  });

  it("3. a dispatch-blocking requirement needs two independent verifiers", async () => {
    const p = await proposal({ blocked: true });
    const first = await callerFor(cast.v1).compliance.requirementVerify(approval(p));
    expect(first).toMatchObject({ outcome: "awaiting_second_approval", level: "UNVERIFIED" });
    // 5. Unverified cannot become authoritative: one approval is not verification.
    expect((await passportItem(p))?.status).toBe("requirement_unverified");
    const [ledger] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM hosRuleLimitHistory WHERE ruleRef = ?", [`${p.requirementKey}@v${p.version}`]);
    expect(Number(ledger[0].n)).toBe(0);

    const second = await callerFor(cast.v2).compliance.requirementSecondApprove(approval(p));
    expect(second).toMatchObject({ outcome: "promoted", level: "CITATION_VERIFIED", verifierUserIds: [cast.v1, cast.v2] });
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM hosRuleLimitHistory WHERE ruleRef = ?", [`${p.requirementKey}@v${p.version}`]);
    expect(row[0]).toMatchObject({
      ruleFamily: "compliance_requirement", verificationMethod: "OFFICIAL_CITATION", verificationLevel: "CITATION_VERIFIED",
      proposedByUserId: cast.proposer, verifiedByUserId: cast.v1, secondVerifierUserId: cast.v2, sourceRevisionRef: null, sourceHash: null,
      dispatchEffect: "BLOCK",
    });
  });

  it("4. an informational requirement is verified by one independent verifier", async () => {
    const p = await proposal({ blocked: false });
    await expect(callerFor(cast.v2).compliance.requirementSecondApprove(approval(p))).rejects.toThrow(/SECOND_APPROVAL_NOT_REQUIRED/);
    const r = await callerFor(cast.safety).compliance.requirementVerify(approval(p));
    expect(r).toMatchObject({ outcome: "promoted", level: "CITATION_VERIFIED", verifierUserIds: [cast.safety] });
  });

  it("18. verifier permissions fail closed, and the privileged ones are sensitive", async () => {
    const p = await proposal();
    await expect(callerFor(cast.dispatcher).compliance.requirementVerify(approval(p))).rejects.toThrow();
    await callerFor(cast.v1).compliance.requirementVerify(approval(p));
    // safety may verify, not second-approve.
    await expect(callerFor(cast.safety).compliance.requirementSecondApprove(approval(p))).rejects.toThrow();
    await expect(callerFor(cast.dispatcher).compliance.requirementWithdraw({ requirementKey: p.requirementKey, version: p.version, reason: "not permitted to do this" })).rejects.toThrow();
    await expect(callerFor(cast.v1).compliance.verificationPolicySet({ mode: "SOURCE_DOCUMENT_REQUIRED", reason: "legal may govern this, dispatch may not", issuingAuthority: "X" })).resolves.toBeTruthy();
    await expect(callerFor(cast.dispatcher).compliance.verificationPolicySet({ mode: "CITATION_ALLOWED", reason: "dispatch may not change governance policy", issuingAuthority: "X" })).rejects.toThrow();
    for (const perm of ["compliance.requirement.verify", "compliance.requirement.second_approve", "compliance.requirement.retire", "compliance.verification.govern"] as const) {
      expect(isSensitivePermission(perm), perm).toBe(true);
    }
  });

  it("17. a verifier in another organization cannot see, let alone verify, the revision", async () => {
    const orgA = await org(); const orgB = await org();
    const proposerA = await member("controller", orgA);
    const verifierB = await member("legal", orgB);
    const verifierA = await member("legal", orgA);
    const dispatcherB = await member("dispatcher", orgB);
    const p = await proposal({ blocked: false, by: proposerA });
    await expect(callerFor(verifierB).compliance.requirementVerify(approval(p))).rejects.toThrow(/NOT_FOUND/);
    await expect(callerFor(dispatcherB).compliance.requirementProvenance({ requirementKey: p.requirementKey })).rejects.toThrow(/NOT_FOUND/);
    await callerFor(verifierA).compliance.requirementVerify(approval(p));
    // Organization B's registry does not contain organization A's requirement — asked about B's own operator.
    expect(await passportItem(p, await operatorRow(orgB), dispatcherB)).toBeUndefined();
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM complianceRequirements WHERE requirementKey = ?", [p.requirementKey]);
    expect(rows[0].orgRef).toBe(orgA);
  });
});

/* ------------------------------------------------------------------ */
/* Citation level                                                      */
/* ------------------------------------------------------------------ */

d("citation verification", () => {
  it("6. a citation-verified requirement is evaluated, and its finding carries its provenance", async () => {
    const p = await proposal({ blocked: true });
    await callerFor(cast.v1).compliance.requirementVerify(approval(p));
    await callerFor(cast.v2).compliance.requirementSecondApprove(approval(p));
    const operatorId = await operatorRow();
    expect((await passportItem(p, operatorId))?.status).toBe("missing");
    const rec = await callerFor(cast.office).compliance.credentialRecord({ ownerType: "operator", ownerId: operatorId, docType: p.doc, title: "Fixture credential", expiresAt: days(400) });
    await callerFor(cast.office).compliance.credentialVerify({ credentialId: rec.credentialId, outcome: "verified" });
    const item = await passportItem(p, operatorId);
    expect(item?.status).toBe("satisfied");
    expect(item?.requirementRef).toMatchObject({
      key: p.requirementKey, version: p.version, origin: "registry",
      provenance: {
        level: "CITATION_VERIFIED", verifierUserIds: [cast.v1, cast.v2], proposedByUserId: cast.proposer,
        sourceMonitoringAvailable: false, sourceRevisionRef: null,
        citation: { instrumentTitle: p.citation.instrumentTitle, issuingAuthority: p.citation.sourceAuthority, citation: "s. 1(1)", officialUrl: p.citation.sourceUrl, jurisdiction: p.jurisdiction },
      },
    });
    expect(item?.requirementRef.provenance?.promotionRef).toMatch(/^RULE-PROM-/);
  });

  it("7. a missing or unofficial URL prevents citation verification", async () => {
    const none = await proposal({ citation: { sourceUrl: undefined } });
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(none))).rejects.toThrow(/NO_OFFICIAL_URL/);
    const blog = await proposal({ citation: { sourceUrl: "https://example.com/summary-of-the-rule" } });
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(blog))).rejects.toThrow(/UNRECOGNIZED_AUTHORITY_DOMAIN/);
  });

  it("8. a missing citation, instrument or authority prevents citation verification", async () => {
    for (const [patch, code] of [
      [{ sourceReference: undefined }, "NO_CITATION"], [{ instrumentTitle: undefined }, "NO_INSTRUMENT"],
      [{ sourceAuthority: undefined }, "NO_ISSUING_AUTHORITY"], [{ authorityType: undefined }, "NO_AUTHORITY_TYPE"],
    ] as const) {
      const p = await proposal({ citation: patch as never });
      await expect(callerFor(cast.v1).compliance.requirementVerify(approval(p)), code).rejects.toThrow(new RegExp(code));
    }
  });

  it("records an unknown effective date explicitly, and opens one licensing task per publisher", async () => {
    const key = `test.c1b2b.${rnd()}`;
    const r = await callerFor(cast.proposer).compliance.requirementLoad({
      requirementKey: key, family: "test", title: "Fixture", subjectType: "operator", jurisdiction: `CA-ZZ-${rnd()}`,
      satisfiedByDocTypes: ["fixture_doc"], missingSeverity: "review", effectiveDateUnknown: true, ...cite(),
    });
    await callerFor(cast.v1).compliance.requirementVerify(approval({ requirementKey: key, version: r.version }));
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT effectiveDateUnknown FROM complianceRequirements WHERE requirementKey = ?", [key]);
    expect(Number(rows[0].effectiveDateUnknown)).toBe(1);
    await expect(callerFor(cast.proposer).compliance.requirementLoad({
      requirementKey: `test.c1b2b.${rnd()}`, family: "test", title: "Fixture", subjectType: "operator", jurisdiction: "CA-ZZ",
      satisfiedByDocTypes: ["fixture_doc"], ...cite(),
    })).rejects.toThrow(/effective date/);
    const [tasks] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM operationalTasks WHERE dedupeKey = 'source_licence_assessment|default|laws-lois.justice.gc.ca' AND status = 'open'");
    expect(Number(tasks[0].n)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Policy and source documents                                         */
/* ------------------------------------------------------------------ */

async function seedSource(o: { url?: string; state?: string; status?: string } = {}) {
  const documentRef = `DOC-${rnd()}`; const versionRef = `KV-${rnd()}`;
  const hash = `${versionRef}`.padEnd(64, "0");
  await pool.query(`INSERT INTO knowledgeDocuments (documentRef, sourceId, title, url, purpose, state, authorityLevel, fetchedAt, fetchedByUserId, contentHash)
    VALUES (?, 'FIXTURE', 'FIXTURE DOCUMENT', ?, 'link_only', ?, 'law', NOW(), 1, ?)`, [documentRef, o.url ?? "https://laws-lois.justice.gc.ca/eng/regulations/FIXTURE/", o.state ?? "VERIFIED", hash]);
  await pool.query("INSERT INTO knowledgeVersions (versionRef, documentRef, contentHash, status, section) VALUES (?, ?, ?, ?, 's. 1(1)')",
    [versionRef, documentRef, hash, o.status ?? "verified"]);
  return { versionRef, hash };
}

d("the source-document route", () => {
  it("9. a SOURCE_DOCUMENT_REQUIRED policy closes the citation route for that authority only", async () => {
    const p = await proposal({ blocked: false });
    const other = await proposal({ blocked: false });
    await callerFor(cast.v2).compliance.verificationPolicySet({
      issuingAuthority: p.citation.sourceAuthority, mode: "SOURCE_DOCUMENT_REQUIRED", reason: "This authority's instruments are admitted as source documents now",
    });
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(p))).rejects.toThrow(/SOURCE_DOCUMENT_REQUIRED/);
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(other))).resolves.toMatchObject({ level: "CITATION_VERIFIED" });

    // 10. The admitted-source route is still open for it.
    const src = await seedSource();
    const r = await callerFor(cast.v1).compliance.requirementVerify(approval(p, "SOURCE_DOCUMENT_VERIFIED", src.versionRef));
    expect(r).toMatchObject({ outcome: "promoted", level: "SOURCE_DOCUMENT_VERIFIED" });
    const item = await passportItem(p);
    expect(item?.requirementRef.provenance).toMatchObject({ level: "SOURCE_DOCUMENT_VERIFIED", sourceMonitoringAvailable: true, sourceRevisionRef: src.versionRef });
  });

  it("10. refuses a quarantined document, and one from a different publisher than the citation", async () => {
    const p = await proposal({ blocked: false });
    const quarantined = await seedSource({ state: "QUARANTINED" });
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(p, "SOURCE_DOCUMENT_VERIFIED", quarantined.versionRef))).rejects.toThrow(/SOURCE_NOT_ADMITTED/);
    const elsewhere = await seedSource({ url: "https://www.canada.ca/somewhere-else" });
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(p, "SOURCE_DOCUMENT_VERIFIED", elsewhere.versionRef))).rejects.toThrow(/SOURCE_DOES_NOT_MATCH_CITATION/);
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(p, "SOURCE_DOCUMENT_VERIFIED"))).rejects.toThrow(/SOURCE_REVISION_REQUIRED/);
  });

  it("11. promotion to the source level keeps the citation verification, and needs two people again for a blocking rule", async () => {
    const p = await proposal({ blocked: true });
    await callerFor(cast.v1).compliance.requirementVerify(approval(p));
    await callerFor(cast.v2).compliance.requirementSecondApprove(approval(p));
    const src = await seedSource();
    const step1 = await callerFor(cast.safety).compliance.requirementVerify(approval(p, "SOURCE_DOCUMENT_VERIFIED", src.versionRef));
    expect(step1).toMatchObject({ outcome: "awaiting_second_approval", level: "CITATION_VERIFIED" });
    // The second approver must name the same source revision.
    const other = await seedSource();
    await expect(callerFor(cast.v2).compliance.requirementSecondApprove(approval(p, "SOURCE_DOCUMENT_VERIFIED", other.versionRef))).rejects.toThrow(/SOURCE_MISMATCH_BETWEEN_APPROVERS/);
    await callerFor(cast.v2).compliance.requirementSecondApprove(approval(p, "SOURCE_DOCUMENT_VERIFIED", src.versionRef));

    const prov = await callerFor(cast.dispatcher).compliance.requirementProvenance({ requirementKey: p.requirementKey });
    const events = prov[0].events.map((e) => [e.eventType, e.targetLevel]);
    expect(events).toEqual([
      ["proposed", null],
      ["approved", "CITATION_VERIFIED"], ["approved", "CITATION_VERIFIED"], ["promoted", "CITATION_VERIFIED"],
      ["approved", "SOURCE_DOCUMENT_VERIFIED"], ["approved", "SOURCE_DOCUMENT_VERIFIED"], ["promoted", "SOURCE_DOCUMENT_VERIFIED"],
    ]);
    expect(prov[0].levelNow).toBe("SOURCE_DOCUMENT_VERIFIED");
    const [ledger] = await pool.query<mysql.RowDataPacket[]>("SELECT verificationLevel, status, sourceHash FROM hosRuleLimitHistory WHERE ruleRef = ? ORDER BY id", [`${p.requirementKey}@v${p.version}`]);
    expect(ledger.map((r) => [r.verificationLevel, r.status])).toEqual([["CITATION_VERIFIED", "SUPERSEDED"], ["SOURCE_DOCUMENT_VERIFIED", "CURRENT"]]);
    expect(ledger[1].sourceHash).toBe(src.hash);
  });
});

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

d("verification is not activation", () => {
  const T = (s: string) => new Date(`${s}T00:00:00Z`);
  const input = (key: string, jurisdiction: string, o: { effectiveFrom?: Date; effectiveUntil?: Date; title?: string } = {}) => ({
    requirementKey: key, family: "test", title: o.title ?? "Fixture", subjectType: "operator" as const, jurisdiction,
    satisfiedByDocTypes: ["fixture_doc"], warnDaysBeforeExpiry: 30, missingSeverity: "review" as const,
    instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation", issuingAuthority: `FIXTURE AUTHORITY ${rnd()}`, citation: "s. 1(1)",
    officialUrl: "https://laws-lois.justice.gc.ca/eng/regulations/FIXTURE/", authorityType: "law" as const,
    effectiveFrom: o.effectiveFrom ?? null, effectiveUntil: o.effectiveUntil ?? null,
  });
  const verify = (key: string, version: number, at: Date) =>
    recordApproval({ requirementKey: key, version, target: "CITATION_VERIFIED", step: 1, decision: "approve", reason: "Checked against the cited section" }, cast.v1, "default", at);
  const governing = async (key: string, at: Date) =>
    (await loadRequirementRegistry([], at, "default")).find((r) => r.requirementKey === key);

  it("12/13. a future verified revision waits for its date; history selects what governed then", async () => {
    const key = `test.c1b2b.dates.${rnd()}`; const j = `CA-ZZ-${rnd()}`;
    await proposeRequirement(input(key, j, { effectiveFrom: T("2026-02-01"), title: "v1" }), cast.proposer, "default", T("2026-01-15"));
    await verify(key, 1, T("2026-01-20"));
    await proposeRequirement(input(key, j, { effectiveFrom: T("2026-06-01"), title: "v2" }), cast.proposer, "default", T("2026-03-01"));
    await verify(key, 2, T("2026-03-05"));

    expect(await governing(key, T("2026-01-10"))).toBeUndefined();                                    // nothing recorded yet
    expect(await governing(key, T("2026-01-18"))).toMatchObject({ version: 1, verificationStatus: "unverified" }); // proposed, not verified
    expect(await governing(key, T("2026-02-10"))).toMatchObject({ version: 1, verificationStatus: "verified" });
    expect(await governing(key, T("2026-04-01"))).toMatchObject({ version: 1 });                      // v2 verified but future
    expect(await governing(key, T("2026-07-01"))).toMatchObject({ version: 2, verificationStatus: "verified" });

    // 20. The replaced revision is SUPERSEDED — derived, and still fully auditable.
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM complianceRequirements WHERE requirementKey = ?", [key]);
    const events = await eventsByRequirement(rows.map((r) => Number(r.id)));
    const sup = supersededAt(rows as never, events, T("2026-07-01"));
    expect(sup.has(Number(rows.find((r) => r.version === 1)!.id))).toBe(true);
    const prov = await callerFor(cast.dispatcher).compliance.requirementProvenance({ requirementKey: key });
    expect(prov.map((v) => [v.version, v.levelNow, v.events.map((e) => e.eventType).join(",")])).toEqual([
      [1, "CITATION_VERIFIED", "proposed,approved,promoted"], [2, "CITATION_VERIFIED", "proposed,approved,promoted"],
    ]);
  });

  it("a gap between revisions is a gap, and an overlapping revision is refused", async () => {
    const key = `test.c1b2b.gap.${rnd()}`; const j = `CA-ZZ-${rnd()}`;
    await proposeRequirement(input(key, j, { effectiveFrom: T("2026-01-01"), effectiveUntil: T("2026-03-01") }), cast.proposer, "default", T("2025-12-01"));
    await verify(key, 1, T("2025-12-02"));
    await proposeRequirement(input(key, j, { effectiveFrom: T("2026-05-01") }), cast.proposer, "default", T("2025-12-03"));
    await verify(key, 2, T("2025-12-04"));
    const inGap = await governing(key, T("2026-04-01"));
    // v1 stands for the key but has ended: the requirement does not apply, and nothing older returns.
    expect(inGap).toMatchObject({ version: 1 });
    expect(inGap!.effectiveUntil!.getTime()).toBeLessThanOrEqual(T("2026-04-01").getTime());
    await expect(proposeRequirement(input(key, j, { effectiveFrom: T("2026-04-15") }), cast.proposer, "default", T("2025-12-05")))
      .rejects.toThrow(/OVERLAPPING|takes effect/);
  });
});

/* ------------------------------------------------------------------ */
/* Packs, withdrawal, the legacy path                                  */
/* ------------------------------------------------------------------ */

d("packs, withdrawal and the removed one-step path", () => {
  it("14/15. verification does not activate a pack, and activation does not verify a requirement", async () => {
    const jurisdiction = `CA-ZZ-${rnd()}`;
    const packKey = `test.pack.${rnd()}`;
    await pool.query("INSERT INTO compliancePacks (packKey, title, jurisdiction, core, activatesWhenJson) VALUES (?, 'Fixture pack', ?, false, ?)",
      [packKey, jurisdiction, JSON.stringify({ activitiesAny: ["fixture_activity"] })]);
    const verified = await proposal({ blocked: true, packKey, subjectType: "equipment", jurisdiction });
    await callerFor(cast.v1).compliance.requirementVerify(approval(verified));
    await callerFor(cast.v2).compliance.requirementSecondApprove(approval(verified));
    const unverified = await proposal({ blocked: true, packKey, subjectType: "equipment", jurisdiction });

    const entity = await entityRow();
    const ask = () => callerFor(cast.dispatcher).requirement.workAuthorization({
      financialEntityId: entity, jurisdiction, companyAttributes: {}, worker: null,
      equipment: { id: 999_999_999, equipmentType: "fixture", attributes: {} }, work: { workType: "fixture", attributes: {} },
    });
    const mentions = (r: Awaited<ReturnType<typeof ask>>, key: string) => r.reasons.some((x) => x.includes(`Fixture ${key}`));
    // With an organization present, unowned equipment credentials are refused (F1.1), not evaluated.
    await org();
    await expect(ask()).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);

    await asOneOwnershipDomain(async () => {
      const before = await ask();
      expect(mentions(before, verified.requirementKey)).toBe(false);
      expect(before.activePacks).not.toContain(packKey);

      await callerFor(cast.proposer).requirement.packActivate({ financialEntityId: entity, packKey });
      const after = await ask();
      expect(mentions(after, verified.requirementKey)).toBe(true);
      expect(after.parts.equipment).toBe("blocked");
      // The unverified one in the same active pack still says it cannot tell.
      expect(after.reasons.some((x) => x.includes(`Fixture ${unverified.requirementKey}`) && x.includes("has not been verified"))).toBe(true);
    });
  });

  it("19. a withdrawn requirement no longer applies, and its history stays", async () => {
    const p = await proposal({ blocked: false });
    await callerFor(cast.v1).compliance.requirementVerify(approval(p));
    expect(await passportItem(p)).toBeDefined();
    await expect(callerFor(cast.v1).compliance.requirementWithdraw({ requirementKey: p.requirementKey, version: p.version, reason: "legal cannot retire" })).rejects.toThrow();
    await callerFor(cast.proposer).compliance.requirementWithdraw({ requirementKey: p.requirementKey, version: p.version, reason: "Instrument repealed (fixture)" });
    expect(await passportItem(p)).toBeUndefined();
    const prov = await callerFor(cast.dispatcher).compliance.requirementProvenance({ requirementKey: p.requirementKey });
    expect(prov[0].levelNow).toBe("WITHDRAWN");
    expect(prov[0].events.map((e) => e.eventType)).toEqual(["proposed", "approved", "promoted", "withdrawn"]);
    await expect(callerFor(cast.v1).compliance.requirementVerify(approval(p))).rejects.toThrow(/WITHDRAWN/);
  });

  it("16. the old one-step request stores a proposal, and a legacy verified row is not authority", async () => {
    const key = `test.c1b2b.legacy.${rnd()}`; const jurisdiction = `CA-ZZ-${rnd()}`;
    const r = await callerFor(cast.proposer).compliance.requirementLoad({
      requirementKey: key, family: "test", title: "Fixture", subjectType: "operator", jurisdiction,
      satisfiedByDocTypes: ["fixture_doc"], missingSeverity: "blocked", sourceVerified: true, requestedStatus: "verified",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"), ...cite(),
    });
    expect(r.storedStatus).toBe("unverified");
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT verificationStatus, verifiedByUserId FROM complianceRequirements WHERE requirementKey = ?", [key]);
    expect(rows[0]).toMatchObject({ verificationStatus: "unverified", verifiedByUserId: null });

    // A row as the pre-0198 path wrote it: "verified" by the controller who loaded it.
    const legacyKey = `test.c1b2b.legacy.${rnd()}`;
    await pool.query(`INSERT INTO complianceRequirements (requirementKey, version, family, title, subjectType, jurisdiction, satisfiedByDocTypes, missingSeverity, effectiveFrom, verificationStatus, verifiedByUserId, verifiedAt)
      VALUES (?, 1, 'test', 'Legacy fixture', 'operator', ?, '["fixture_doc"]', 'blocked', '2026-01-01', 'verified', ?, NOW())`, [legacyKey, jurisdiction, cast.proposer]);
    expect((await passportItem({ requirementKey: legacyKey, jurisdiction }))?.status).toBe("requirement_unverified");
    // And it cannot be verified in place: it has no proposer, so it must be proposed again.
    await expect(callerFor(cast.v1).compliance.requirementVerify({ ...approval({ requirementKey: legacyKey, version: 1 }) })).rejects.toThrow(/NOT_FOUND|NO_PROPOSER/);
  });

  it("16. no production code writes a verified requirement, or edits one; the database refuses both", async () => {
    const root = path.resolve(__dirname);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        if (statSync(full).isDirectory()) { if (f !== "node_modules") walk(full); continue; }
        if (f.endsWith(".ts") && !f.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(root);
    const writers = files.filter((f) => readFileSync(f, "utf8").includes("insert(complianceRequirements)"));
    expect(writers.map((f) => path.relative(root, f))).toEqual(["requirementVerification.ts"]);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("update(complianceRequirements)"), f).toBe(false);
      expect(src.includes("update(requirementVerificationEvents)"), f).toBe(false);
    }
    const writer = readFileSync(path.join(root, "requirementVerification.ts"), "utf8");
    const insert = writer.slice(writer.indexOf("insert(complianceRequirements)"), writer.indexOf("insert(complianceRequirements)") + 400);
    expect(insert).toContain('verificationStatus: "unverified"');
    expect(insert).not.toMatch(/verificationStatus:\s*"verified"/);

    const p = await proposal();
    await expect(pool.query("UPDATE complianceRequirements SET verificationStatus = 'verified' WHERE requirementKey = ?", [p.requirementKey])).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM complianceRequirements WHERE requirementKey = ?", [p.requirementKey])).rejects.toThrow(/never deleted/);
    await expect(pool.query("UPDATE requirementVerificationEvents SET actorUserId = 1 WHERE requirementKey = ?", [p.requirementKey])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM requirementVerificationEvents WHERE requirementKey = ?", [p.requirementKey])).rejects.toThrow(/never deleted/);
  });
});

/* ------------------------------------------------------------------ */
/* Pure rules                                                          */
/* ------------------------------------------------------------------ */

describe("pure rules", () => {
  const T = (s: string) => new Date(`${s}T00:00:00Z`);
  type EvRow = Parameters<typeof levelAt>[0][number];
  const ev = (id: number, o: Partial<EvRow>): EvRow => ({
    id, eventRef: `E${id}`, requirementId: 1, requirementKey: "k", version: 1, orgRef: "default", eventType: "approved",
    targetLevel: "CITATION_VERIFIED", step: 1, actorUserId: 10, reason: null, citationHash: null, sourceRevisionRef: null,
    sourceHash: null, comparisonJson: null, promotionRef: null, verifierUserIdsJson: null, createdAt: T("2026-01-01"), ...o,
  });

  it("reads the level at a date from the events, never later ones", () => {
    const events = [ev(1, { eventType: "proposed", targetLevel: null }), ev(2, {}), ev(3, { eventType: "promoted", createdAt: T("2026-02-01") }), ev(4, { eventType: "withdrawn", targetLevel: null, createdAt: T("2026-05-01") })];
    expect(levelAt(events, T("2026-01-15"))).toBe("UNVERIFIED");
    expect(levelAt(events, T("2026-03-01"))).toBe("CITATION_VERIFIED");
    expect(levelAt(events, T("2026-06-01"))).toBe("WITHDRAWN");
  });

  it("resets pending approvals after a rejection", () => {
    const events = [ev(1, { actorUserId: 10 }), ev(2, { eventType: "rejected", actorUserId: 11 }), ev(3, { actorUserId: 12 })];
    expect(pendingApprovals(events, "CITATION_VERIFIED").map((e) => e.actorUserId)).toEqual([12]);
  });

  it("picks the most specific policy, then the latest; defaults to CITATION_ALLOWED", () => {
    const row = (id: number, o: object) => ({ id, policyRef: `P${id}`, orgRef: "default", issuingAuthority: null, domain: null, jurisdiction: null, mode: "CITATION_ALLOWED" as const, reason: "r", setByUserId: 1, createdAt: T("2026-01-01"), ...o });
    const scope = { orgRef: "default", issuingAuthority: "Authority A", domain: "driver_licensing", jurisdiction: "CA-AB" };
    expect(resolvePolicy([], scope, T("2026-06-01"))).toEqual({ mode: "CITATION_ALLOWED", policyRef: null });
    const policies = [
      row(1, { jurisdiction: "CA-AB", mode: "SOURCE_DOCUMENT_REQUIRED" }),
      row(2, { jurisdiction: "CA-AB", issuingAuthority: "authority a", mode: "CITATION_ALLOWED" }),
      row(3, { jurisdiction: "CA-BC", issuingAuthority: "Authority A", domain: "driver_licensing", mode: "SOURCE_DOCUMENT_REQUIRED" }),
      row(4, { orgRef: "other", issuingAuthority: "Authority A", domain: "driver_licensing", jurisdiction: "CA-AB", mode: "SOURCE_DOCUMENT_REQUIRED" }),
    ];
    expect(resolvePolicy(policies, scope, T("2026-06-01"))).toEqual({ mode: "CITATION_ALLOWED", policyRef: "P2" });
    expect(resolvePolicy(policies, { ...scope, issuingAuthority: "B" }, T("2026-06-01"))).toEqual({ mode: "SOURCE_DOCUMENT_REQUIRED", policyRef: "P1" });
    // A policy recorded later does not apply to an earlier date.
    expect(resolvePolicy([row(5, { mode: "SOURCE_DOCUMENT_REQUIRED", createdAt: T("2026-07-01") })], scope, T("2026-06-01")).mode).toBe("CITATION_ALLOWED");
  });

  it("keeps a verified revision governing over a later unverified proposal", () => {
    const base = {
      requirementKey: "k", family: "f", packKey: null, title: "t", subjectType: "operator" as const, jurisdiction: "CA-ZZ",
      appliesWhenJson: null, satisfiedByDocTypes: "[]", renewalIntervalDays: null, warnDaysBeforeExpiry: 30, missingSeverity: "review" as const,
      sourceAuthority: "A", sourceUrl: "https://laws-lois.justice.gc.ca/x", sourceReference: "s.1", effectiveUntil: null,
      verificationStatus: "unverified" as const, verifiedByUserId: null, verifiedAt: null, notes: null, orgRef: "default",
      proposedByUserId: 9, instrumentTitle: "I", authorityType: "law", effectiveDateUnknown: false, citationHash: null,
    };
    const rows = [
      { ...base, id: 1, version: 1, effectiveFrom: T("2026-01-01"), createdAt: T("2026-01-01") },
      { ...base, id: 2, version: 2, effectiveFrom: T("2026-02-01"), createdAt: T("2026-02-01") },
    ];
    const events = new Map([[1, [ev(1, { eventType: "promoted", requirementId: 1 })]], [2, [ev(2, { eventType: "proposed", targetLevel: null, requirementId: 2 })]]]);
    expect(governingRevisions(rows, events, T("2026-03-01")).map((g) => [g.row.version, g.level])).toEqual([[1, "CITATION_VERIFIED"]]);
  });

  it("refuses the proposer and a repeated verifier by id, whichever step they call", () => {
    const row = {
      id: 1, requirementKey: "k", version: 1, family: "f", packKey: null, title: "t", subjectType: "operator" as const, jurisdiction: "CA-ZZ",
      appliesWhenJson: null, satisfiedByDocTypes: "[]", renewalIntervalDays: null, warnDaysBeforeExpiry: 30, missingSeverity: "blocked" as const,
      sourceAuthority: "A", sourceUrl: "https://laws-lois.justice.gc.ca/x", sourceReference: "s.1", effectiveFrom: T("2026-01-01"), effectiveUntil: null,
      verificationStatus: "unverified" as const, verifiedByUserId: null, verifiedAt: null, notes: null, createdAt: T("2026-01-01"), orgRef: "default",
      proposedByUserId: 9, instrumentTitle: "I", authorityType: "law", effectiveDateUnknown: false, citationHash: "",
    };
    row.citationHash = citationHashOf(row);
    const args = { row, target: "CITATION_VERIFIED" as const, policy: "CITATION_ALLOWED" as const, at: T("2026-02-01") };
    expect(approvalCheck({ ...args, events: [], actorUserId: 9, step: 1 })).toMatchObject({ ok: false, code: "SELF_VERIFICATION" });
    const one = [ev(1, { actorUserId: 10 })];
    expect(approvalCheck({ ...args, events: one, actorUserId: 10, step: 2 })).toMatchObject({ ok: false, code: "SAME_VERIFIER" });
    expect(approvalCheck({ ...args, events: one, actorUserId: 11, step: 1 })).toMatchObject({ ok: false, code: "STEP_OUT_OF_ORDER" });
    expect(approvalCheck({ ...args, events: one, actorUserId: 11, step: 2 })).toMatchObject({ ok: true, completes: true });
    // Any change to the stored revision breaks its fingerprint.
    expect(approvalCheck({ ...args, row: { ...row, title: "edited" }, events: [], actorUserId: 11, step: 1 })).toMatchObject({ ok: false, code: "CITATION_INCOMPLETE" });
  });

  it("keeps the seed list unverified", () => {
    expect(COMPLIANCE_REQUIREMENT_SEEDS.every((s) => s.verificationStatus === "unverified")).toBe(true);
  });
});

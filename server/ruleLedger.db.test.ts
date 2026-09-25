/**
 * C1b-1 — one rule ledger.
 *
 * Every figure, instrument and source below is a **test fixture**, not a verified regulatory value.
 *
 * Three things are proved here:
 *
 * 1. **HOS history survives 0189 untouched.** A scratch database is built to the pre-0189 shape,
 *    filled with HOS promotions, snapshotted, migrated, and compared column by column. `believedOn`
 *    returns what the pre-0189 algorithm returns for every date.
 * 2. **Another family cannot leak into HOS reads** — nor HOS into theirs.
 * 3. **A non-HOS rule meets a higher bar than a seed**: a verified source revision whose hash it
 *    records, a verifier who is not the proposer, two verifiers for a blocking statute, an effect the
 *    authority can carry.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  believedOn, ledgerFor, pendingFutureRules, promote, HOS_RULE_FAMILY, type PromotionEvidence,
  believedRuleOn, canTransition, lifecycleOf, promoteRule, ruleHistory, rulesOnStaleSources,
  validateRuleEvidence, verifySourceRevision, type RuleEvidence, type SourceRevision,
} from "./_core/knowledge/promotionLedger";
import { maxEffectFor, requiresSecondVerifier, tierForAuthority } from "./_core/knowledge/admission";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => `TEST-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
const now = () => new Date();
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const CITATION = "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/";

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

/* ------------------------------------------------------------------ */
/* Pure                                                                */
/* ------------------------------------------------------------------ */

const verifiedSource = (o: Partial<SourceRevision> = {}): SourceRevision => ({
  versionRef: "KV-FIXTURE", contentHash: "a".repeat(64), status: "verified", repealedAt: null, effectiveUntil: null, ...o,
});

const ruleEvidence = (o: Partial<RuleEvidence> = {}): RuleEvidence => ({
  ruleFamily: "document_requirement", ruleRef: rnd(), domain: "documents", dispatchEffect: "WARN",
  payload: { satisfiedBy: ["FIXTURE_DOC"] },
  jurisdiction: "CA-FEDERAL", authorityType: "law",
  instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
  issuingAuthority: "FIXTURE — no issuing authority",
  sourceSection: "s. 1", citationUrl: CITATION, verificationMethod: "OFFICIAL_WEB",
  sourceRevisionRef: "KV-FIXTURE",
  proposedByUserId: 11, verifiedByUserId: 12, verifiedAt: days(-1), ...o,
});

describe("the authority mapping is the design's table (§4)", () => {
  it("maps each knowledge level to its tier", () => {
    expect(tierForAuthority("law")).toBe("statute_regulation");
    expect(tierForAuthority("official_guidance")).toBe("statute_regulation");
    expect(tierForAuthority("recognized_standard")).toBe("best_practice");
    expect(tierForAuthority("manufacturer", true)).toBe("carrier_safety_policy");
    expect(tierForAuthority("company_policy")).toBeNull();
    expect(tierForAuthority("unverified")).toBeNull();
  });
  it("caps guidance and best practice at WARN", () => {
    expect(maxEffectFor("statute_regulation", "official_guidance")).toBe("WARN");
    expect(maxEffectFor("best_practice", "recognized_standard")).toBe("WARN");
    expect(maxEffectFor("statute_regulation", "law")).toBe("BLOCK");
  });
  it("asks for two verifiers only on blocking statute and regulator orders (C1b-Q3)", () => {
    expect(requiresSecondVerifier("statute_regulation", "BLOCK")).toBe(true);
    expect(requiresSecondVerifier("regulator_order", "BLOCK")).toBe(true);
    expect(requiresSecondVerifier("statute_regulation", "WARN")).toBe(false);
    expect(requiresSecondVerifier("carrier_safety_policy", "BLOCK")).toBe(false);
  });
});

describe("lifecycle is read from the ledger, never written over it", () => {
  const at = new Date("2026-09-24T12:00:00Z");
  it("maps the stored status and dates", () => {
    expect(lifecycleOf({ status: "CURRENT", effectiveFrom: null, effectiveUntil: null }, at)).toBe("active");
    expect(lifecycleOf({ status: "FUTURE", effectiveFrom: new Date("2027-01-01"), effectiveUntil: null }, at)).toBe("verified");
    // A FUTURE row whose date has come is active — by date, not by anyone flipping it.
    expect(lifecycleOf({ status: "FUTURE", effectiveFrom: new Date("2026-01-01"), effectiveUntil: null }, at)).toBe("active");
    expect(lifecycleOf({ status: "SUPERSEDED", effectiveFrom: null, effectiveUntil: null }, at)).toBe("superseded");
    expect(lifecycleOf({ status: "REVOKED", effectiveFrom: null, effectiveUntil: null }, at)).toBe("withdrawn");
  });
  it("never lets a person move a rule to active, or out of a terminal state", () => {
    expect(canTransition("reviewed", "active")).toBe(false);
    expect(canTransition("candidate", "verified")).toBe(false);
    expect(canTransition("verified", "active")).toBe(true);
    expect(canTransition("superseded", "active")).toBe(false);
    expect(canTransition("withdrawn", "candidate")).toBe(false);
  });
});

describe("what a non-HOS rule must show", () => {
  const at = now();
  const blocking = { dispatchEffect: "BLOCK" as const, secondVerifierUserId: 13, secondVerifiedAt: days(-1) };
  const cases: [string, Partial<RuleEvidence>, SourceRevision | null, string][] = [
    ["an HOS figure through the generic door", { ruleFamily: HOS_RULE_FAMILY }, verifiedSource(), "HOS_FAMILY_USES_PROMOTE"],
    ["no rule ref", { ruleRef: " " }, verifiedSource(), "NO_RULE_REF"],
    ["no proposer", { proposedByUserId: 0 }, verifiedSource(), "NO_PROPOSER"],
    ["no verifier", { verifiedByUserId: 0 }, verifiedSource(), "NO_VERIFIER"],
    ["the proposer verifying", { verifiedByUserId: 11 }, verifiedSource(), "SELF_VERIFICATION"],
    ["no citation", { citationUrl: "" }, verifiedSource(), "NO_CITATION"],
    ["guidance that blocks", { authorityType: "official_guidance", dispatchEffect: "BLOCK" }, verifiedSource(), "EFFECT_EXCEEDS_AUTHORITY"],
    ["best practice that blocks", { authorityType: "recognized_standard", dispatchEffect: "BLOCK" }, verifiedSource(), "EFFECT_EXCEEDS_AUTHORITY"],
    ["a blocking statute with one verifier", { dispatchEffect: "BLOCK" }, verifiedSource(), "NO_SECOND_VERIFIER"],
    ["a second verifier who is the first", { ...blocking, secondVerifierUserId: 12 }, verifiedSource(), "SECOND_VERIFIER_NOT_DISTINCT"],
    ["a second verifier who is the proposer", { ...blocking, secondVerifierUserId: 11 }, verifiedSource(), "SECOND_VERIFIER_NOT_DISTINCT"],
    ["no source revision", {}, null, "NO_SOURCE_REVISION"],
    ["an unverified source", {}, verifiedSource({ status: "candidate" }), "SOURCE_NOT_VERIFIED"],
    ["a superseded source", {}, verifiedSource({ status: "superseded" }), "SOURCE_NOT_VERIFIED"],
    ["a repealed source", {}, verifiedSource({ repealedAt: days(-3) }), "SOURCE_REPEALED"],
  ];
  for (const [label, patch, source, code] of cases) {
    it(`refuses ${label}`, () => {
      const r = validateRuleEvidence(ruleEvidence(patch), source, at);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.code).toBe(code);
    });
  }
  it("accepts a blocking statute with three distinct people and a verified source", () => {
    const r = validateRuleEvidence(ruleEvidence(blocking), verifiedSource(), at);
    expect(r).toEqual({ ok: true, tier: "statute_regulation" });
  });
  it("accepts a warning statute with one verifier", () => {
    expect(validateRuleEvidence(ruleEvidence(), verifiedSource(), at).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 0189 leaves HOS history untouched                                   */
/* ------------------------------------------------------------------ */

/** Statements of a migration file, comments stripped. Enough for the DDL used here. */
const statementsOf = (file: string, keep: (stmt: string) => boolean = () => true) =>
  readFileSync(path.resolve(__dirname, "../drizzle", file), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean).filter(keep);

/** The pre-0189 `believedOn`, verbatim in effect: last recorded non-FUTURE row. */
const believedBefore0189 = (rows: { recordedAt: Date; status: string; value: number; promotionRef: string; citationUrl: string }[], at: Date) => {
  const held = rows.filter((r) => r.recordedAt <= at && r.status !== "FUTURE");
  const last = held[held.length - 1];
  return last ? { value: last.value, promotionRef: last.promotionRef, citationUrl: last.citationUrl } : null;
};

d("0189 on a database that already holds HOS history", () => {
  let scratch: mysql.Connection;
  const scratchDb = `c1b_equiv_${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    const admin = await mysql.createConnection({ uri: DB_URL! });
    await admin.query(`CREATE DATABASE \`${scratchDb}\``);
    await admin.end();
    const u = new URL(DB_URL!); u.pathname = `/${scratchDb}`;
    scratch = await mysql.createConnection({ uri: u.toString() });
    // The pre-0189 shape of exactly the two tables 0189 touches.
    for (const s of statementsOf("0118_knowledge_source_registry.sql")) await scratch.query(s);
    for (const s of statementsOf("0120_hos_rule_limit_history.sql", (s) => !s.includes("`hosRuleLimits`"))) await scratch.query(s);
  });

  afterAll(async () => {
    await scratch?.query(`DROP DATABASE IF EXISTS \`${scratchDb}\``);
    await scratch?.end();
  });

  it("changes no stored HOS value, backfills the family, and keeps believedOn's answers", async () => {
    const insert = `INSERT INTO hosRuleLimitHistory
      (promotionRef, profileKey, limitKey, value, unit, jurisdiction, authorityType, instrumentTitle, issuingAuthority,
       sourceSection, citationUrl, verificationMethod, verifiedByUserId, verifiedAt, effectiveFrom, recordedAt, status, changeReason, previousPromotionRef)
      VALUES (?, 'P1', 'daily_drive_minutes', ?, 'minutes', 'CA-FEDERAL', ?, 'FIXTURE', 'FIXTURE', 's. 12', ?, 'OFFICIAL_WEB', 7, ?, ?, ?, ?, ?, ?)`;
    const rows: [string, number, string, string, string, string | null, string, string, string, string | null][] = [
      ["HOS-A", 780, "law", CITATION, "2025-01-01 00:00:00", null, "2025-01-02 00:00:00", "SUPERSEDED", "INITIAL_VERIFICATION", null],
      ["HOS-B", 800, "law", CITATION, "2025-06-01 00:00:00", null, "2025-06-02 00:00:00", "SUPERSEDED", "VERIFIED_REVISION", "HOS-A"],
      ["HOS-C", 810, "official_guidance", CITATION, "2026-01-01 00:00:00", "2027-01-01 00:00:00", "2026-01-02 00:00:00", "FUTURE", "VERIFIED_REVISION", "HOS-B"],
      ["HOS-D", 790, "recognized_standard", CITATION, "2026-02-01 00:00:00", null, "2026-02-02 00:00:00", "CURRENT", "CORRECTED_VERIFICATION", "HOS-C"],
    ];
    for (const r of rows) await scratch.query(insert, r);
    await scratch.query(`INSERT INTO knowledgeVersions (versionRef, documentRef, contentHash, verifiedByUserId) VALUES
      ('KV-1','D','h1',NULL), ('KV-2','D','h2',9), ('KV-3','D','h3',9)`);
    await scratch.query(`UPDATE knowledgeVersions SET supersededByVersionRef = 'KV-3' WHERE versionRef = 'KV-2'`);

    const [before] = await scratch.query("SELECT * FROM hosRuleLimitHistory ORDER BY id") as [mysql.RowDataPacket[], unknown];
    for (const s of statementsOf("0189_rule_ledger_generalization.sql")) await scratch.query(s);
    const [after] = await scratch.query("SELECT * FROM hosRuleLimitHistory ORDER BY id") as [mysql.RowDataPacket[], unknown];

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      for (const [col, v] of Object.entries(before[i])) expect(after[i][col], `${before[i].promotionRef}.${col}`).toEqual(v);
      expect(after[i].ruleFamily).toBe("hos_limit");
      expect(after[i].ruleRef).toBe("P1.daily_drive_minutes");
      expect(after[i].domain).toBe("hos");
    }
    expect(after.map((r) => r.authorityTier)).toEqual(["statute_regulation", "statute_regulation", "statute_regulation", "best_practice"]);

    // The answers the audit question gets, before and after, for every interesting date.
    for (const at of ["2024-12-31", "2025-01-03", "2025-07-01", "2026-01-03", "2026-03-01", "2030-01-01"]) {
      const t = new Date(`${at}T00:00:00Z`);
      expect(believedBefore0189(after as never, t), at).toEqual(believedBefore0189(before as never, t));
    }

    const [kv] = await scratch.query("SELECT versionRef, status FROM knowledgeVersions ORDER BY versionRef") as [mysql.RowDataPacket[], unknown];
    expect(kv.map((r) => [r.versionRef, r.status])).toEqual([["KV-1", "candidate"], ["KV-2", "superseded"], ["KV-3", "verified"]]);
  });
});

/* ------------------------------------------------------------------ */
/* The live ledger                                                     */
/* ------------------------------------------------------------------ */

const hosEvidence = (o: Partial<PromotionEvidence> = {}): PromotionEvidence => ({
  profileKey: rnd(), limitKey: "daily_drive_minutes", value: 777, unit: "minutes",
  jurisdiction: "CA-FEDERAL", authorityType: "law",
  instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation", issuingAuthority: "FIXTURE — no issuing authority",
  sourceSection: "s. 12(1)", citationUrl: CITATION, verificationMethod: "OFFICIAL_WEB",
  verifiedByUserId: 7, verifiedAt: days(-1), ...o,
});

const seedSource = async (o: { status?: string; fetchedBy?: number | null; repealedAt?: Date | null } = {}) => {
  const documentRef = rnd(); const versionRef = rnd(); const contentHash = `${versionRef}`.padEnd(64, "0");
  await pool.query(`INSERT INTO knowledgeDocuments (documentRef, sourceId, title, purpose, state, authorityLevel, fetchedAt, fetchedByUserId, contentHash)
    VALUES (?, 'FIXTURE', 'FIXTURE DOCUMENT', 'link_only', 'VERIFIED', 'law', NOW(), ?, ?)`, [documentRef, o.fetchedBy ?? null, contentHash]);
  await pool.query(`INSERT INTO knowledgeVersions (versionRef, documentRef, contentHash, status, repealedAt) VALUES (?, ?, ?, ?, ?)`,
    [versionRef, documentRef, contentHash, o.status ?? "verified", o.repealedAt ?? null]);
  return { versionRef, contentHash };
};

d("HOS reads see HOS rows only", () => {
  it("keeps believedOn, ledgerFor and pendingFutureRules on the HOS family", async () => {
    const e = hosEvidence();
    const p = await promote(e, now());
    expect(p.promoted).toBe(true);

    // A row of another family that shares the table.
    const src = await seedSource();
    const r = await promoteRule(ruleEvidence({ sourceRevisionRef: src.versionRef, effectiveFrom: days(30) }), now());
    expect(r.promoted).toBe(true);

    const ledger = await ledgerFor(e.profileKey, e.limitKey);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ ruleFamily: "hos_limit", ruleRef: `${e.profileKey}.daily_drive_minutes`, domain: "hos", authorityTier: "statute_regulation" });
    expect(await believedOn(e.profileKey, e.limitKey, days(1))).toMatchObject({ value: 777 });

    const pending = await pendingFutureRules(now());
    expect(pending.every((row) => row.ruleFamily === HOS_RULE_FAMILY)).toBe(true);
    if (r.promoted) expect(pending.some((row) => row.promotionRef === r.promotionRef)).toBe(false);
  });
});

d("promoting a rule of another family", () => {
  it("records the source hash, the tier, both verifiers and the payload", async () => {
    const src = await seedSource();
    const e = ruleEvidence({ sourceRevisionRef: src.versionRef, dispatchEffect: "BLOCK", secondVerifierUserId: 13, secondVerifiedAt: days(-1) });
    const r = await promoteRule(e, now());
    expect(r).toMatchObject({ promoted: true, status: "CURRENT", lifecycle: "active", tier: "statute_regulation" });
    const [row] = await ruleHistory(e.ruleFamily, e.ruleRef);
    expect(row).toMatchObject({
      ruleFamily: "document_requirement", authorityTier: "statute_regulation", dispatchEffect: "BLOCK",
      sourceRevisionRef: src.versionRef, sourceHash: src.contentHash,
      proposedByUserId: 11, verifiedByUserId: 12, secondVerifierUserId: 13,
      profileKey: null, limitKey: null, value: null,
    });
    expect(JSON.parse(row.payloadJson!)).toEqual(e.payload);
  });

  it("refuses a rule whose source revision is not verified, looked up rather than trusted", async () => {
    const src = await seedSource({ status: "candidate" });
    const r = await promoteRule(ruleEvidence({ sourceRevisionRef: src.versionRef }), now());
    expect(r).toMatchObject({ promoted: false, code: "SOURCE_NOT_VERIFIED" });
    const missing = await promoteRule(ruleEvidence({ sourceRevisionRef: "KV-DOES-NOT-EXIST" }), now());
    expect(missing).toMatchObject({ promoted: false, code: "NO_SOURCE_REVISION" });
  });

  it("answers the point-in-time question from the ledger", async () => {
    const src = await seedSource();
    const e1 = ruleEvidence({ sourceRevisionRef: src.versionRef, payload: { v: 1 } });
    const r1 = await promoteRule(e1, now());
    // An amendment recorded today that takes effect in thirty days.
    const r2 = await promoteRule({ ...e1, payload: { v: 2 }, effectiveFrom: days(30) }, now());
    expect(r1.promoted && r2.promoted).toBe(true);
    if (!r1.promoted || !r2.promoted) return;
    expect(r2).toMatchObject({ status: "FUTURE", lifecycle: "verified" });

    expect(await believedRuleOn(e1.ruleFamily, e1.ruleRef, new Date("2020-01-01"))).toBeNull();
    expect(await believedRuleOn(e1.ruleFamily, e1.ruleRef, days(1))).toMatchObject({ promotionRef: r1.promotionRef, payload: { v: 1 } });
    expect(await believedRuleOn(e1.ruleFamily, e1.ruleRef, days(31))).toMatchObject({ promotionRef: r2.promotionRef, payload: { v: 2 } });

    // The first stays CURRENT until the second's date: nothing is superseded early.
    const hist = await ruleHistory(e1.ruleFamily, e1.ruleRef);
    expect(hist.map((h) => h.status)).toEqual(["CURRENT", "FUTURE"]);
  });

  it("supersedes without rewriting, and corrects by pointing", async () => {
    const src = await seedSource();
    const e = ruleEvidence({ sourceRevisionRef: src.versionRef, payload: { v: 1 } });
    const a = await promoteRule(e, now());
    expect(await promoteRule(e, now())).toMatchObject({ promoted: false, code: "DUPLICATE_PROMOTION" });
    if (!a.promoted) throw new Error("setup");
    const b = await promoteRule({ ...e, payload: { v: 1.1 }, correctsPromotionRef: a.promotionRef }, now());
    expect(b.promoted).toBe(true);
    const hist = await ruleHistory(e.ruleFamily, e.ruleRef);
    expect(hist.map((h) => [h.status, h.changeReason])).toEqual([["SUPERSEDED", "INITIAL_VERIFICATION"], ["CURRENT", "CORRECTED_VERIFICATION"]]);
    expect(JSON.parse(hist[0].payloadJson!)).toEqual({ v: 1 });
    expect(hist[1].correctsPromotionRef).toBe(a.promotionRef);

    expect(await promoteRule({ ...e, payload: { v: 3 }, correctsPromotionRef: "RULE-PROM-NOPE" }, now()))
      .toMatchObject({ promoted: false, code: "CORRECTS_UNKNOWN_PROMOTION" });
  });

  it("lists rules whose source changed after they were verified", async () => {
    const src = await seedSource();
    const e = ruleEvidence({ sourceRevisionRef: src.versionRef });
    const r = await promoteRule(e, now());
    if (!r.promoted) throw new Error("setup");
    expect((await rulesOnStaleSources(now())).some((x) => x.promotionRef === r.promotionRef)).toBe(false);
    await pool.query(`UPDATE knowledgeVersions SET status = 'superseded' WHERE versionRef = ?`, [src.versionRef]);
    expect((await rulesOnStaleSources(now())).some((x) => x.promotionRef === r.promotionRef)).toBe(true);
  });
});

d("verifying a source revision", () => {
  it("is refused to the person who fetched the document, and only moves candidate or reviewed", async () => {
    const src = await seedSource({ status: "candidate", fetchedBy: 21 });
    expect(await verifySourceRevision(src.versionRef, 21, now())).toMatchObject({ verified: false, code: "SELF_VERIFICATION" });
    expect(await verifySourceRevision(src.versionRef, 0, now())).toMatchObject({ verified: false, code: "NO_VERIFIER" });
    expect(await verifySourceRevision(src.versionRef, 22, now())).toEqual({ verified: true });
    const [rows] = await pool.query(`SELECT status, verifiedByUserId FROM knowledgeVersions WHERE versionRef = ?`, [src.versionRef]) as [mysql.RowDataPacket[], unknown];
    expect(rows[0]).toMatchObject({ status: "verified", verifiedByUserId: 22 });

    const old = await seedSource({ status: "superseded" });
    expect(await verifySourceRevision(old.versionRef, 22, now())).toMatchObject({ verified: false, code: "NOT_VERIFIABLE" });
    expect(await verifySourceRevision("KV-NOPE", 22, now())).toMatchObject({ verified: false, code: "UNKNOWN_SOURCE" });
  });
});

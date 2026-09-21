/**
 * The promotion ledger.
 *
 * Every figure below is a **test fixture**, not a verified Canadian regulatory
 * value. This proves the mechanism; only a person with the instrument open can
 * establish a real one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  STALE_VERIFICATION_DAYS, believedOn, divergences, ledgerFor, pendingFutureRules,
  promote, statusFor, validateEvidence, type PromotionEvidence,
} from "./_core/knowledge/promotionLedger";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => `TEST-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
const NOW = new Date("2026-09-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });

afterAll(async () => { await pool?.end(); });

const evidence = (o: Partial<PromotionEvidence> = {}): PromotionEvidence => ({
  profileKey: rnd(), limitKey: "daily_drive_minutes", value: 777, unit: "minutes",
  jurisdiction: "CA-FEDERAL", authorityType: "law",
  // Unmistakably a fixture. An earlier version used the real instrument
  // title with a real citation URL and 780, which put rows in the ledger that
  // read exactly like a verified federal figure to anyone querying it.
  instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
  issuingAuthority: "FIXTURE — no issuing authority",
  sourceSection: "s. 12(1)",
  citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
  verificationMethod: "OFFICIAL_WEB",
  verifiedByUserId: 7, verifiedAt: daysAgo(1), ...o,
});

describe("status comes from the dates, not from a checkbox", () => {
  it("calls a rule that has not started FUTURE", () => {
    expect(statusFor({ effectiveFrom: new Date("2027-03-01") }, NOW)).toBe("FUTURE");
  });
  it("calls a rule that has ended EXPIRED", () => {
    expect(statusFor({ effectiveUntil: new Date("2026-01-01") }, NOW)).toBe("EXPIRED");
  });
  it("calls a rule in force CURRENT", () => {
    expect(statusFor({ effectiveFrom: new Date("2020-01-01") }, NOW)).toBe("CURRENT");
  });
});

describe("evidence the verifier must supply", () => {
  const cases: [string, Partial<PromotionEvidence>, string][] = [
    ["no verifier", { verifiedByUserId: 0 }, "NO_VERIFIER"],
    ["company policy", { authorityType: "company_policy" as never }, "NON_BINDING_AUTHORITY"],
    ["no instrument named", { instrumentTitle: " " }, "NO_INSTRUMENT_TITLE"],
    ["no jurisdiction", { jurisdiction: "" }, "NO_JURISDICTION"],
    ["no citation url", { citationUrl: "" }, "NO_CITATION"],
    ["no section", { sourceSection: "" }, "NO_CITATION"],
    ["ends before it starts", { effectiveFrom: new Date("2027-01-01"), effectiveUntil: new Date("2026-01-01") }, "AMBIGUOUS_EFFECTIVE_DATE"],
    ["verified in the future", { verifiedAt: new Date("2027-01-01") }, "AMBIGUOUS_EFFECTIVE_DATE"],
    ["implausible", { value: 13 }, "IMPLAUSIBLE_VALUE"],
  ];

  for (const [label, patch, code] of cases) {
    it(`refuses: ${label}`, () => {
      const r = validateEvidence(evidence(patch), NOW);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.code).toBe(code);
    });
  }

  it("refuses a verification older than the freshness window", () => {
    const r = validateEvidence(evidence({ verifiedAt: daysAgo(STALE_VERIFICATION_DAYS + 1) }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("STALE_VERIFICATION");
      expect(r.reason).toContain("regulations move");
    }
  });

  it("stores no source text — the type has nowhere to put it", () => {
    const keys = Object.keys(evidence());
    for (const forbidden of ["text", "quotedParagraph", "fullDocument", "screenshot", "courseContent"]) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
  });
});

d("the ledger", () => {
  it("writes one row per promoted figure, not one per mutation", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey, value: 777 }), NOW);
    await promote(evidence({ profileKey, value: 720, sourceSection: "s. 12(1), as amended" }), NOW);

    const ledger = await ledgerFor(profileKey, "daily_drive_minutes");
    // Two promotions, two rows. The departing value is not recorded a second
    // time as a separate "removed" event.
    expect(ledger).toHaveLength(2);
    expect(ledger.map((r) => r.value)).toEqual([777, 720]);
    expect(ledger[0]?.changeReason).toBe("INITIAL_VERIFICATION");
    expect(ledger[1]?.changeReason).toBe("VERIFIED_REVISION");
  });

  it("leaves the superseded row's figure and citation exactly as recorded", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey, value: 777 }), NOW);
    await promote(evidence({ profileKey, value: 720, sourceSection: "s. 12(1), as amended" }), NOW);

    const ledger = await ledgerFor(profileKey, "daily_drive_minutes");
    expect(ledger[0]?.status).toBe("SUPERSEDED");
    // Marked, not rewritten. What LeaseOS believed in March is still readable.
    expect(ledger[0]?.value).toBe(777);
    expect(ledger[0]?.sourceSection).toBe("s. 12(1)");
    expect(ledger[1]?.previousPromotionRef).toBe(ledger[0]?.promotionRef);
  });

  it("answers what LeaseOS believed on a date", async () => {
    const profileKey = rnd();
    const first = await promote(evidence({ profileKey, value: 777 }), NOW);
    expect(first.promoted).toBe(true);

    // recordedAt is the database's now(), not the fixture NOW — so "a day from now"
    // has to mean the real clock, or the assertion starts failing the day the
    // calendar passes the fixture date (which is how this was found).
    const believed = await believedOn(profileKey, "daily_drive_minutes", new Date(Date.now() + 86_400_000));
    expect(believed?.value).toBe(777);
    if (first.promoted) expect(believed?.promotionRef).toBe(first.promotionRef);
  });

  it("links the live figure to the promotion that produced it", async () => {
    const profileKey = rnd();
    const r = await promote(evidence({ profileKey }), NOW);
    if (!r.promoted) throw new Error("expected promotion");

    const [rows] = await pool.query(
      "SELECT currentPromotionRef, value FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
    const live = (rows as { currentPromotionRef: string; value: number }[])[0];
    expect(live?.currentPromotionRef).toBe(r.promotionRef);
    expect(live?.value).toBe(777);
  });

  it("finds no divergence between live figures and their promotions", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey }), NOW);
    // If this ever finds something, hosRuleLimits was written outside the
    // promotion path — the one thing the ledger cannot survive.
    expect(await divergences()).toEqual([]);
  });

  it("detects a live figure edited behind the ledger's back", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey }), NOW);
    await pool.execute("UPDATE hosRuleLimits SET value = 999 WHERE profileKey = ?", [profileKey]);

    const found = await divergences();
    expect(found.some((d2) => d2.profileKey === profileKey && d2.field === "value")).toBe(true);
    await pool.execute("DELETE FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
  });
});

d("future rules are known and not applied", () => {
  it("records a future amendment without touching the live figure", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey, value: 777 }), NOW);
    const future = await promote(evidence({
      profileKey, value: 660, effectiveFrom: new Date("2027-03-01"),
      sourceSection: "s. 12(1), amended 2027",
    }), NOW);

    expect(future.promoted).toBe(true);
    if (future.promoted) {
      expect(future.status).toBe("FUTURE");
      expect(future.becameCurrent).toBe(false);
    }

    const [rows] = await pool.query("SELECT value FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
    // Known in February, effective in March. Compliance still uses the rule in
    // force, which is the whole reason the dates are separate.
    expect((rows as { value: number }[])[0]?.value).toBe(777);
  });

  it("lists amendments waiting to take effect", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey, value: 700, effectiveFrom: new Date("2027-06-01") }), NOW);
    const pending = await pendingFutureRules(NOW);
    expect(pending.some((p) => p.profileKey === profileKey)).toBe(true);
  });
});

d("corrections keep the error visible", () => {
  it("records a correction pointing at the promotion it corrects", async () => {
    const profileKey = rnd();
    // 700 passes plausibility — the documented limitation of that guard.
    const wrong = await promote(evidence({ profileKey, value: 700 }), NOW);
    if (!wrong.promoted) throw new Error("expected the wrong figure to promote");

    const fixed = await promote(evidence({
      profileKey, value: 780, correctsPromotionRef: wrong.promotionRef, verifiedByUserId: 9,
    }), NOW);
    expect(fixed.promoted).toBe(true);

    const ledger = await ledgerFor(profileKey, "daily_drive_minutes");
    expect(ledger).toHaveLength(2);
    // The error is still there, and the correction says which one it fixes.
    expect(ledger[0]?.value).toBe(700);
    expect(ledger[1]?.value).toBe(780);
    expect(ledger[1]?.changeReason).toBe("CORRECTED_VERIFICATION");
    expect(ledger[1]?.correctsPromotionRef).toBe(wrong.promotionRef);
  });

  it("refuses a correction to a promotion that does not exist", async () => {
    const r = await promote(evidence({ correctsPromotionRef: "HOS-PROM-NOPE" }), NOW);
    expect(r.promoted).toBe(false);
    if (!r.promoted) expect(r.code).toBe("CORRECTS_UNKNOWN_PROMOTION");
  });
});

d("evidence is not cosmetic metadata", () => {
  it("refuses the same figure promoted twice with the same evidence", async () => {
    const profileKey = rnd();
    const e = evidence({ profileKey });
    await promote(e, NOW);
    const again = await promote(e, NOW);
    expect(again.promoted).toBe(false);
    if (!again.promoted) expect(again.code).toBe("DUPLICATE_PROMOTION");
  });

  it("refuses a changed citation with an unchanged figure and verifier", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey }), NOW);
    const edited = await promote(evidence({
      profileKey, citationUrl: "https://laws-lois.justice.gc.ca/eng/acts/M-10.01/",
    }), NOW);

    // Editing the justification without re-reading the instrument.
    expect(edited.promoted).toBe(false);
    if (!edited.promoted) expect(edited.code).toBe("CITATION_CHANGED_WITHOUT_REVERIFICATION");
  });

  it("accepts a changed citation when a different verifier re-read it", async () => {
    const profileKey = rnd();
    await promote(evidence({ profileKey }), NOW);
    const reverified = await promote(evidence({
      profileKey, citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/page-2.html",
      verifiedByUserId: 11,
    }), NOW);
    expect(reverified.promoted).toBe(true);
  });
});

/**
 * P8.5 — the vault's three refusals, tested as refusals.
 *
 * Each case below is a way the subsystem could quietly become useless while still looking built:
 * a role that is treated as access, a grant that opens the sector instead of a record, a log
 * written after the content, a decline that leaves an investigation behind anyway.
 */
import { describe, expect, it } from "vitest";
import {
  TIER_OF_MATTER, createsInvestigation, declineRecordsOnly, evaluateRestrictedAccess, isRestricted,
  matterTrackingNumber, proposeInternalInvestigation, serveRestricted, trackingNumberLeaksCategory, validatePurpose,
  type ExistingGrant,
} from "./restrictedVault";

const NOW = new Date("2026-09-18T12:00:00Z");
const grant = (o: Partial<ExistingGrant> = {}): ExistingGrant =>
  ({ id: 1, userId: 7, recordType: "incidentMatter", recordId: 42, expiresAt: new Date("2026-09-18T13:00:00Z"), revokedAt: null, ...o });

const ask = (o: Partial<Parameters<typeof evaluateRestrictedAccess>[0]> = {}) =>
  evaluateRestrictedAccess({ holdsRestrictedPermission: true, userId: 7, recordType: "incidentMatter", recordId: 42, grants: [], now: NOW, ...o });

describe("administration role alone is not access", () => {
  it("denies a person without the restricted permission, and does not offer them the prompt", () => {
    const d = ask({ holdsRestrictedPermission: false });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.code).toBe("NO_RESTRICTED_PERMISSION");
    expect(d.promptRequired).toBe(false);          // the prompt is not a way in for someone without the role
    expect(d.reason).toMatch(/administration role is not by itself access/);
  });

  it("denies a person who holds the permission but has no grant, and sends them to the prompt", () => {
    const d = ask();
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.code).toBe("BREAK_GLASS_REQUIRED");
    expect(d.promptRequired).toBe(true);
    expect(d.reason).toMatch(/The prompt is the gate/);
  });
});

describe("a grant opens one record, not the vault", () => {
  it("serves a live grant for this record", () => {
    const d = ask({ grants: [grant()] });
    expect(d.allowed).toBe(true);
    if (!d.allowed) throw new Error("unreachable");
    expect(d.grantId).toBe(1);
    expect(d.mustLogBeforeServing).toBe(true);
  });

  it("does not let a grant for another record open this one", () => {
    // The failure this prevents: one break-glass at 9am opening everything for the rest of the day.
    const d = ask({ grants: [grant({ recordId: 99 })] });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.code).toBe("BREAK_GLASS_REQUIRED");
  });

  it("does not let another person's grant open it", () => {
    const d = ask({ grants: [grant({ userId: 8 })] });
    expect(d.allowed).toBe(false);                 // bound to the person, not the session or device
  });

  it("enforces expiry here rather than by hiding the link", () => {
    const d = ask({ grants: [grant({ expiresAt: new Date("2026-09-18T11:59:00Z") })] });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.code).toBe("GRANT_EXPIRED");
    expect(d.reason).toMatch(/a stale tab cannot outlive it/);
  });

  it("makes revocation immediate, and says so rather than looking like expiry", () => {
    const d = ask({ grants: [grant({ revokedAt: new Date("2026-09-18T11:00:00Z") })] });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.code).toBe("GRANT_REVOKED");
  });
});

describe("a purpose must explain the access to someone reading it later", () => {
  it("refuses a word, and names why it is not enough", () => {
    for (const p of ["audit", "review", "check", "investigation"]) {
      const v = validatePurpose(p);
      expect(v.ok, p).toBe(false);
    }
    expect(validatePurpose("audit")).toMatchObject({ ok: false });
    const short = validatePurpose("looking");
    if (short.ok) throw new Error("unreachable");
    expect(short.reason).toMatch(/at least twenty characters/);
  });

  it("accepts a sentence that says what is being established", () => {
    expect(validatePurpose("Checking whether the near-miss on 12 Sep names the same unit as this claim.")).toEqual({ ok: true });
  });
});

describe("the tracking number does not say what kind of matter it is", () => {
  it("uses one prefix for every type", () => {
    expect(matterTrackingNumber(3, 2026)).toBe("MTR-2026-000003");
    expect(trackingNumberLeaksCategory(matterTrackingNumber(3, 2026))).toBe(false);
  });

  it("catches a number that spells out its category", () => {
    // INV-2026-0003 tells anyone glancing at a spreadsheet that this incident produced an
    // investigation, which is the one fact the restricted sector exists to keep.
    for (const n of ["INV-2026-0003", "WCB-2026-0007", "MTR-2026-INVEST-1", "INS-CLAIM-88"]) {
      expect(trackingNumberLeaksCategory(n), n).toBe(true);
    }
  });
});

describe("the tiers, and WCB as its own chain", () => {
  it("puts only the internal investigation in the restricted sector", () => {
    expect(TIER_OF_MATTER.INTERNAL_INVESTIGATION).toBe("RESTRICTED");
    expect(isRestricted(TIER_OF_MATTER.INTERNAL_INVESTIGATION)).toBe(true);
    for (const t of ["INSURANCE_CLAIM", "WCB_CLAIM", "REGULATORY_REPORT", "POLICE_FILE"] as const) {
      expect(isRestricted(TIER_OF_MATTER[t]), t).toBe(false);
    }
  });

  it("keeps WCB as a matter type of its own, not a kind of insurance claim", () => {
    // Folding WCB into insurance is how a supervisor ends up reading a diagnosis: the two have
    // different lifecycles, different deadlines and a different privacy boundary.
    expect(TIER_OF_MATTER.WCB_CLAIM).toBeDefined();
    expect(Object.keys(TIER_OF_MATTER)).toContain("WCB_CLAIM");
    expect(Object.keys(TIER_OF_MATTER)).toContain("INSURANCE_CLAIM");
  });
});

describe("the system proposes an investigation; it never compels one", () => {
  it("proposes from a stated rule, naming the rule and why", () => {
    const p = proposeInternalInvestigation({ injuryReported: true })!;
    expect(p.rule).toBe("injury_reported");
    expect(p.because).toMatch(/an injury was reported/);
    expect(p.policy).toBeTruthy();                 // a rule a company can read and argue with
  });

  it("proposes nothing when no rule fires, rather than guessing", () => {
    expect(proposeInternalInvestigation({ injuryReported: false, severity: "minor" })).toBeNull();
  });

  it("records the decision and nothing else when a company handles it in-house", () => {
    expect(createsInvestigation("HANDLED_INTERNALLY")).toBe(false);
    const kept = declineRecordsOnly("HANDLED_INTERNALLY");
    expect(kept).toContain("that a proposal was raised");
    expect(kept).toContain("who decided");
    expect(kept.join(" ")).toMatch(/a reason, if one was given/);   // optional, by owner decision
    // No content, because declining creates no investigation to have content.
    expect(kept.join(" ")).not.toMatch(/finding|allegation|witness|narrative/i);
  });

  it("creates the investigation only on OPENED", () => {
    expect(createsInvestigation("OPENED")).toBe(true);
    for (const d of ["PENDING", "NOT_WARRANTED", "DEFERRED", "HANDLED_INTERNALLY"] as const) {
      expect(createsInvestigation(d), d).toBe(false);
    }
  });
});

describe("the log is written before the content, and a failed log means no content", () => {
  const allowed = { allowed: true as const, grantId: 1, mustLogBeforeServing: true as const };

  it("logs first, then fetches — proved by the order they record themselves in", async () => {
    const order: string[] = [];
    const r = await serveRestricted({
      decision: allowed,
      logAccess: async () => { order.push("log"); },
      fetchContent: async () => { order.push("fetch"); return { secret: "x" }; },
      logDenial: async () => { order.push("denial"); },
    });
    expect(order).toEqual(["log", "fetch"]);        // not ["fetch", "log"], and not just "both ran"
    expect(r).toMatchObject({ served: true, content: { secret: "x" } });
  });

  it("serves nothing when the audit write fails — the content is never even fetched", async () => {
    let fetched = false;
    await expect(serveRestricted({
      decision: allowed,
      logAccess: async () => { throw new Error("audit store unavailable"); },
      fetchContent: async () => { fetched = true; return { secret: "x" }; },
      logDenial: async () => {},
    })).rejects.toThrow(/audit store unavailable/);
    // The failure that matters: a record served under a log that was never written.
    expect(fetched, "content must not be fetched when the access could not be logged").toBe(false);
  });

  it("logs a refusal too, and returns the code rather than the record", async () => {
    let denialLogged: string | null = null;
    const r = await serveRestricted({
      decision: { allowed: false, code: "BREAK_GLASS_REQUIRED", reason: "state a purpose", promptRequired: true },
      logAccess: async () => { throw new Error("must not be called"); },
      fetchContent: async () => { throw new Error("must not be called"); },
      logDenial: async (code) => { denialLogged = code; },
    });
    expect(denialLogged).toBe("BREAK_GLASS_REQUIRED");   // an attempt nobody can see is a gap too
    expect(r).toMatchObject({ served: false, code: "BREAK_GLASS_REQUIRED", promptRequired: true });
  });
});

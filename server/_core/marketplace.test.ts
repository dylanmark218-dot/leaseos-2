/**
 * The marketplace rules, without a database.
 *
 * Everything the transactional service asks the pure module is pinned here:
 * which transitions exist and which do not, that the bidding deadline is a
 * clock and not a state, that a sealed tender's prices stay sealed, that a
 * revision's hash moves when its content moves and not otherwise, and that
 * readiness fails closed on what the posting requires.
 */
import { describe, expect, it } from "vitest";
import {
  BID_STATES,
  POSTING_STATES,
  assessBidReadiness,
  bidContentHash,
  biddingWindow,
  comparableTotalCents,
  makeRef,
  mayViewBidPricing,
  openBidRange,
  transitionBid,
  transitionPosting,
  validateBidContent,
  type BidContent,
  type BidderPicture,
  type PostingState,
} from "./marketplace";

const NOW = new Date("2026-09-22T18:00:00Z");

const fixed = (over: Partial<BidContent> = {}): BidContent => ({
  pricingType: "fixed_price",
  currency: "CAD",
  fixedTotalCents: 1_480_000,
  components: [],
  exclusions: ["Disposal fees"],
  qualifications: { certifications: ["TDG", "H2S"], permits: [], dangerousGoods: ["CLASS_3"], insuranceLiabilityCents: 500_000_000, equipmentTypes: ["TRI_DRIVE_VAC"] },
  unitsOffered: 4,
  availableFrom: new Date("2026-09-24T07:00:00Z"),
  notes: null,
  attachments: [],
  ...over,
});

describe("posting lifecycle", () => {
  it("walks the happy path in order and nowhere else", () => {
    const path: Array<[PostingState, Parameters<typeof transitionPosting>[1], PostingState]> = [
      ["draft", "publish", "published"],
      ["published", "open_bidding", "bidding"],
      ["bidding", "close_bidding", "bidding_closed"],
      ["bidding_closed", "award", "awarded"],
      ["awarded", "contract", "contracted"],
      ["contracted", "dispatch", "dispatched"],
      ["dispatched", "start", "active"],
      ["active", "complete", "completed"],
      ["completed", "close", "closed"],
    ];
    for (const [from, event, to] of path) {
      const t = transitionPosting(from, event);
      expect(t.allowed, `${from} --${event}--> ${to}`).toBe(true);
      if (t.allowed) expect(t.to).toBe(to);
    }
  });

  it("refuses to award before bidding has closed, and to skip states", () => {
    expect(transitionPosting("bidding", "award").allowed).toBe(false);
    expect(transitionPosting("draft", "open_bidding").allowed).toBe(false);
    expect(transitionPosting("published", "close_bidding").allowed).toBe(false);
    expect(transitionPosting("awarded", "award").allowed).toBe(false);
    const t = transitionPosting("draft", "award");
    expect(t.allowed).toBe(false);
    if (!t.allowed) expect(t.reason).toMatch(/cannot "award"/);
  });

  it("can be cancelled up to and including the award, and not once contracted", () => {
    for (const s of ["draft", "published", "bidding", "bidding_closed", "awarded"] as const) {
      expect(transitionPosting(s, "cancel").allowed, s).toBe(true);
    }
    for (const s of ["contracted", "dispatched", "active", "completed", "closed", "cancelled"] as const) {
      expect(transitionPosting(s, "cancel").allowed, s).toBe(false);
    }
  });

  it("has no transition out of a terminal state", () => {
    const events = ["publish", "open_bidding", "close_bidding", "award", "contract", "dispatch", "start", "complete", "close", "cancel"] as const;
    for (const s of ["closed", "cancelled"] as const) {
      for (const e of events) expect(transitionPosting(s, e).allowed, `${s} ${e}`).toBe(false);
    }
    expect(POSTING_STATES).toHaveLength(11);
  });
});

describe("bid lifecycle", () => {
  it("submits, withdraws, and resubmits as a new revision", () => {
    expect(transitionBid("draft", "submit")).toMatchObject({ allowed: true, to: "submitted" });
    expect(transitionBid("submitted", "withdraw")).toMatchObject({ allowed: true, to: "withdrawn" });
    expect(transitionBid("withdrawn", "submit")).toMatchObject({ allowed: true, to: "submitted" });
  });

  it("shortlists, accepts and rejects only a standing bid", () => {
    expect(transitionBid("submitted", "shortlist")).toMatchObject({ allowed: true, to: "shortlisted" });
    expect(transitionBid("shortlisted", "accept")).toMatchObject({ allowed: true, to: "accepted" });
    expect(transitionBid("submitted", "reject")).toMatchObject({ allowed: true, to: "rejected" });
    expect(transitionBid("withdrawn", "accept").allowed).toBe(false);
    expect(transitionBid("draft", "accept").allowed).toBe(false);
    expect(transitionBid("draft", "withdraw").allowed).toBe(false);
  });

  it("never leaves accepted or rejected", () => {
    for (const s of ["accepted", "rejected"] as const) {
      for (const e of ["submit", "withdraw", "shortlist", "accept", "reject"] as const) {
        expect(transitionBid(s, e).allowed, `${s} ${e}`).toBe(false);
      }
    }
    expect(BID_STATES).toHaveLength(6);
  });
});

describe("the bidding window is a clock, not a state", () => {
  const closes = new Date("2026-09-22T18:00:00Z");

  it("is open while bidding and before the deadline", () => {
    const w = biddingWindow({ state: "bidding", biddingClosesAt: closes }, new Date("2026-09-22T17:59:59Z"));
    expect(w.open).toBe(true);
    if (w.open) expect(w.remainingMs).toBe(1000);
  });

  it("is closed AT the deadline even though nobody has closed the posting", () => {
    const w = biddingWindow({ state: "bidding", biddingClosesAt: closes }, closes);
    expect(w).toEqual({ open: false, reason: "closed_by_deadline" });
  });

  it("is closed by the client once the posting says so, and not yet open before bidding opens", () => {
    expect(biddingWindow({ state: "bidding_closed", biddingClosesAt: closes }, new Date("2026-09-22T12:00:00Z"))).toEqual({ open: false, reason: "closed_by_client" });
    expect(biddingWindow({ state: "published", biddingClosesAt: closes }, new Date("2026-09-22T12:00:00Z"))).toEqual({ open: false, reason: "not_yet_open" });
    expect(biddingWindow({ state: "draft", biddingClosesAt: null }, NOW)).toEqual({ open: false, reason: "not_yet_open" });
    expect(biddingWindow({ state: "awarded", biddingClosesAt: null }, NOW)).toEqual({ open: false, reason: "not_bidding" });
  });

  it("stays open indefinitely when no deadline is set", () => {
    const w = biddingWindow({ state: "bidding", biddingClosesAt: null }, new Date("2030-01-01T00:00:00Z"));
    expect(w.open).toBe(true);
    if (w.open) expect(w.remainingMs).toBeNull();
  });
});

describe("sealed tender: who may see a price", () => {
  const base = { clientOrgRef: "ORG-CLIENT", bidderOrgRef: "ORG-BIDDER" } as const;

  it("the bidder always sees its own price", () => {
    for (const s of POSTING_STATES) {
      expect(mayViewBidPricing({ ...base, viewerOrgRef: "ORG-BIDDER", visibility: "sealed", postingState: s }).visible, s).toBe(true);
    }
  });

  it("the client sees a sealed price only once bidding has closed", () => {
    for (const s of ["draft", "published", "bidding"] as const) {
      const v = mayViewBidPricing({ ...base, viewerOrgRef: "ORG-CLIENT", visibility: "sealed", postingState: s });
      expect(v.visible, s).toBe(false);
      if (!v.visible) expect(v.reason).toMatch(/sealed tender/);
    }
    for (const s of ["bidding_closed", "awarded", "contracted", "cancelled"] as const) {
      expect(mayViewBidPricing({ ...base, viewerOrgRef: "ORG-CLIENT", visibility: "sealed", postingState: s }).visible, s).toBe(true);
    }
  });

  it("the client sees an open price at any time", () => {
    expect(mayViewBidPricing({ ...base, viewerOrgRef: "ORG-CLIENT", visibility: "open", postingState: "bidding" }).visible).toBe(true);
  });

  it("a third organization never sees another's price, open or sealed", () => {
    for (const visibility of ["open", "sealed"] as const) {
      const v = mayViewBidPricing({ ...base, viewerOrgRef: "ORG-OTHER", visibility, postingState: "bidding_closed" });
      expect(v.visible).toBe(false);
    }
  });

  it("an open posting publishes a range over live bids only, and counts bids with no comparable total", () => {
    const r = openBidRange([
      { state: "submitted", comparableTotalCents: 1_940_000 },
      { state: "shortlisted", comparableTotalCents: 1_790_000 },
      { state: "withdrawn", comparableTotalCents: 900_000 },
      { state: "submitted", comparableTotalCents: null },
    ]);
    expect(r).toEqual({ liveBids: 3, withTotal: 2, lowestCents: 1_790_000, highestCents: 1_940_000 });
    expect(openBidRange([])).toEqual({ liveBids: 0, withTotal: 0, lowestCents: null, highestCents: null });
  });
});

describe("bid content", () => {
  it("accepts each pricing type in its own shape", () => {
    expect(validateBidContent(fixed())).toEqual({ ok: true });
    expect(validateBidContent(fixed({ pricingType: "unit_rate", fixedTotalCents: null, components: [{ code: "LOAD", label: "Per load", unit: "LOAD", rateCents: 48_500, estimatedQuantityMillis: 8_000 }] }))).toEqual({ ok: true });
    expect(validateBidContent(fixed({ pricingType: "hourly", fixedTotalCents: null, components: [{ code: "HOURLY", label: "Per hour per unit", unit: "HOUR", rateCents: 24_500, estimatedQuantityMillis: null }] }))).toEqual({ ok: true });
    expect(validateBidContent(fixed({
      pricingType: "combination", fixedTotalCents: null,
      components: [
        { code: "HOURLY", label: "Hourly", unit: "HOUR", rateCents: 24_500, estimatedQuantityMillis: 40_000 },
        { code: "MILEAGE", label: "Mileage", unit: "KM", rateCents: 350, estimatedQuantityMillis: 688_000 },
        { code: "STANDBY", label: "Standby", unit: "HOUR", rateCents: 12_000, estimatedQuantityMillis: 0 },
      ],
    }))).toEqual({ ok: true });
  });

  it("refuses the shapes that are two bids pretending to be one", () => {
    const r1 = validateBidContent(fixed({ components: [{ code: "LOAD", label: "l", unit: "LOAD", rateCents: 1, estimatedQuantityMillis: null }] }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reasons.join(" ")).toMatch(/fixed-price bid carries no rate components/);
    const r2 = validateBidContent(fixed({ pricingType: "unit_rate", components: [{ code: "LOAD", label: "l", unit: "LOAD", rateCents: 1, estimatedQuantityMillis: null }] }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reasons.join(" ")).toMatch(/unit-rate bid carries no fixed total/);
    const r3 = validateBidContent(fixed({ pricingType: "hourly", fixedTotalCents: null, components: [{ code: "LOAD", label: "l", unit: "LOAD", rateCents: 1, estimatedQuantityMillis: null }] }));
    expect(r3.ok).toBe(false);
    const r4 = validateBidContent(fixed({ pricingType: "combination", fixedTotalCents: null, components: [{ code: "HOURLY", label: "l", unit: "HOUR", rateCents: 1, estimatedQuantityMillis: null }] }));
    expect(r4.ok).toBe(false);
  });

  it("refuses non-integer money, negative insurance, duplicate codes and a bad digest", () => {
    const r = validateBidContent(fixed({
      pricingType: "combination", fixedTotalCents: null,
      components: [
        { code: "A", label: "a", unit: "KM", rateCents: 1.5, estimatedQuantityMillis: null },
        { code: "HOURLY", label: "h", unit: "HOUR", rateCents: 1, estimatedQuantityMillis: null },
        { code: "HOURLY", label: "h again", unit: "HOUR", rateCents: 2, estimatedQuantityMillis: null },
      ],
      qualifications: { certifications: [], permits: [], dangerousGoods: [], insuranceLiabilityCents: -1, equipmentTypes: [] },
      attachments: [{ name: "coi.pdf", sha256: "nope", sizeBytes: 10 }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons.join("\n")).toMatch(/UPPER_SNAKE/);
      expect(r.reasons.join("\n")).toMatch(/non-negative integer rate/);
      expect(r.reasons.join("\n")).toMatch(/unique/);
      expect(r.reasons.join("\n")).toMatch(/insurance/);
      expect(r.reasons.join("\n")).toMatch(/SHA-256/);
    }
  });

  it("computes a comparable total only when every rate carries a quantity", () => {
    expect(comparableTotalCents(fixed())).toEqual({ totalCents: 1_480_000, basis: "fixed total as bid" });
    const unit = fixed({ pricingType: "unit_rate", fixedTotalCents: null, components: [{ code: "LOAD", label: "l", unit: "LOAD", rateCents: 48_500, estimatedQuantityMillis: 8_000 }] });
    expect(comparableTotalCents(unit).totalCents).toBe(388_000);
    const unknown = fixed({ pricingType: "hourly", fixedTotalCents: null, components: [{ code: "HOURLY", label: "h", unit: "HOUR", rateCents: 24_500, estimatedQuantityMillis: null }] });
    const c = comparableTotalCents(unknown);
    expect(c.totalCents).toBeNull();
    expect(c.basis).toMatch(/UNKNOWN/);
    // Half a load rounds, and does not truncate.
    const half = fixed({ pricingType: "unit_rate", fixedTotalCents: null, components: [{ code: "LOAD", label: "l", unit: "LOAD", rateCents: 1, estimatedQuantityMillis: 500 }] });
    expect(comparableTotalCents(half).totalCents).toBe(1);
  });

  it("hashes the same content the same and changed content differently, regardless of key order", () => {
    const a = fixed();
    const b = fixed();
    expect(bidContentHash(a)).toBe(bidContentHash(b));
    expect(bidContentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    const reordered = JSON.parse(JSON.stringify({ ...a, qualifications: { equipmentTypes: a.qualifications.equipmentTypes, insuranceLiabilityCents: a.qualifications.insuranceLiabilityCents, dangerousGoods: a.qualifications.dangerousGoods, permits: a.qualifications.permits, certifications: a.qualifications.certifications } })) as BidContent;
    reordered.availableFrom = new Date(reordered.availableFrom as unknown as string);
    expect(bidContentHash(reordered)).toBe(bidContentHash(a));
    expect(bidContentHash(fixed({ fixedTotalCents: 1_480_001 }))).not.toBe(bidContentHash(a));
    expect(bidContentHash(fixed({ exclusions: [] }))).not.toBe(bidContentHash(a));
    expect(bidContentHash(fixed({ attachments: [{ name: "coi.pdf", sha256: "a".repeat(64), sizeBytes: 1 }] }))).not.toBe(bidContentHash(a));
  });
});

describe("bid readiness", () => {
  const picture = (over: Partial<BidderPicture> = {}): BidderPicture => ({
    bidderOrgRef: "ORG-BIDDER",
    clientOrgRef: "ORG-CLIENT",
    organizationStatus: "active",
    contractorProfileStatus: "active",
    distribution: "public",
    invited: false,
    window: { open: true, closesAt: null, remainingMs: null },
    unitsRequired: 4,
    requirements: { certifications: ["TDG", "H2S"], permits: [], dangerousGoods: ["CLASS_3"], insuranceLiabilityMinimumCents: 500_000_000, equipmentTypes: ["TRI_DRIVE_VAC"] },
    content: fixed(),
    ...over,
  });

  it("is eligible when every stated requirement is declared, and says 'declared, not verified'", () => {
    const r = assessBidReadiness(picture(), NOW);
    expect(r.verdict).toBe("eligible_to_submit");
    expect(r.basis).toBe("declared_only");
    const byCheck = Object.fromEntries(r.rows.map(x => [x.check, x]));
    expect(byCheck.certifications!.result).toBe("WARNING");
    expect(byCheck.certifications!.detail).toMatch(/declared, not verified/);
    expect(byCheck.insurance!.result).toBe("WARNING");
    expect(byCheck.units!.result).toBe("PASS");
    expect(byCheck.driver_availability!.result).toBe("UNKNOWN");
    expect(byCheck.hos_forecast!.result).toBe("UNKNOWN");
    expect(r.rows.every(x => x.blocking === (x.result === "FAIL"))).toBe(true);
  });

  it("fails closed on a missing required certification, an insurance shortfall, or a missing DG declaration", () => {
    const noTdg = assessBidReadiness(picture({ content: fixed({ qualifications: { ...fixed().qualifications, certifications: ["H2S"] } }) }), NOW);
    expect(noTdg.verdict).toBe("draft_only");
    expect(noTdg.rows.find(x => x.check === "certifications")).toMatchObject({ result: "FAIL", detail: "Not declared: TDG." });

    const thin = assessBidReadiness(picture({ content: fixed({ qualifications: { ...fixed().qualifications, insuranceLiabilityCents: 200_000_000 } }) }), NOW);
    expect(thin.rows.find(x => x.check === "insurance")).toMatchObject({ result: "FAIL" });

    const noIns = assessBidReadiness(picture({ content: fixed({ qualifications: { ...fixed().qualifications, insuranceLiabilityCents: null } }) }), NOW);
    expect(noIns.rows.find(x => x.check === "insurance")!.detail).toMatch(/none declared/);

    const noDg = assessBidReadiness(picture({ content: fixed({ qualifications: { ...fixed().qualifications, dangerousGoods: [] } }) }), NOW);
    expect(noDg.rows.find(x => x.check === "dangerous_goods")).toMatchObject({ result: "FAIL" });
  });

  it("matches requirement codes without regard to case or whitespace", () => {
    const r = assessBidReadiness(picture({ content: fixed({ qualifications: { ...fixed().qualifications, certifications: [" tdg", "h2s "] } }) }), NOW);
    expect(r.rows.find(x => x.check === "certifications")!.result).toBe("WARNING");
  });

  it("treats fewer units than required as a warning the client decides on, not a refusal", () => {
    const r = assessBidReadiness(picture({ content: fixed({ unitsOffered: 3 }) }), NOW);
    expect(r.verdict).toBe("eligible_to_submit");
    expect(r.rows.find(x => x.check === "units")).toMatchObject({ result: "WARNING" });
    expect(r.rows.find(x => x.check === "units")!.detail).toMatch(/3 of 4/);
  });

  it("refuses a self-bid, a non-active organization, an uninvited bidder on an invite-only tender, and a closed window", () => {
    expect(assessBidReadiness(picture({ bidderOrgRef: "ORG-CLIENT" }), NOW).rows.find(x => x.check === "counterparty")!.result).toBe("FAIL");
    expect(assessBidReadiness(picture({ organizationStatus: "suspended" }), NOW).rows.find(x => x.check === "organization")!.result).toBe("FAIL");
    expect(assessBidReadiness(picture({ organizationStatus: "missing" }), NOW).rows.find(x => x.check === "organization")!.result).toBe("FAIL");
    expect(assessBidReadiness(picture({ distribution: "invite_only", invited: false }), NOW).rows.find(x => x.check === "invitation")!.result).toBe("FAIL");
    expect(assessBidReadiness(picture({ distribution: "invite_only", invited: true }), NOW).rows.find(x => x.check === "invitation")!.result).toBe("PASS");
    const closed = assessBidReadiness(picture({ window: { open: false, reason: "closed_by_deadline" } }), NOW);
    expect(closed.verdict).toBe("draft_only");
    expect(closed.rows.find(x => x.check === "bidding_window")!.detail).toMatch(/closed_by_deadline/);
  });

  it("a bidder with no contractor profile is a warning, a suspended one a refusal", () => {
    expect(assessBidReadiness(picture({ contractorProfileStatus: "none" }), NOW).rows.find(x => x.check === "contractor_profile")!.result).toBe("WARNING");
    expect(assessBidReadiness(picture({ contractorProfileStatus: "suspended" }), NOW).verdict).toBe("draft_only");
  });

  it("a posting with no requirements passes every requirement row", () => {
    const r = assessBidReadiness(picture({ requirements: { certifications: [], permits: [], dangerousGoods: [], insuranceLiabilityMinimumCents: null, equipmentTypes: [] }, unitsRequired: null }), NOW);
    for (const c of ["certifications", "permits", "dangerous_goods", "insurance", "equipment", "units"]) {
      expect(r.rows.find(x => x.check === c)!.result, c).toBe("PASS");
    }
  });
});

describe("references", () => {
  it("are prefixed, ten characters of an unambiguous alphabet, and deterministic for a seeded source", () => {
    let i = 0;
    const seq = () => ((i += 7) % 32) / 32;
    const a = makeRef("MKT", seq);
    expect(a).toMatch(/^MKT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    i = 0;
    expect(makeRef("MKT", seq)).toBe(a);
    expect(makeRef("BID")).not.toBe(makeRef("BID"));
  });
});

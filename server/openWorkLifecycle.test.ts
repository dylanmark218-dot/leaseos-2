/**
 * 0206 — the post's life, the offer's life, and what a declaration is.
 *
 * Pure. The tables are the rule; these pin the shape of them, the same way
 * `dispatchLifecycle` is pinned: every terminal state has no exit, `filled` is
 * reached only from a live post, and an unknown is never read as consent.
 */
import { describe, expect, it } from "vitest";
import {
  availabilityReasons, canTransitionOffer, canTransitionPost, declarationCovers, declaredStateAt, effectiveOfferStatus, effectivePostStatus,
  isLiveOffer, isTerminalPost, OFFER_TRANSITIONS, POST_TRANSITIONS, responseVolunteers,
  type AvailabilityDeclaration, type OfferStatus, type PostStatus,
} from "./_core/openShifts";

const T = (s: string) => new Date(s);

describe("the post's life", () => {
  it("terminal states have no exit", () => {
    for (const s of ["filled", "cancelled", "expired"] as PostStatus[]) {
      expect(isTerminalPost(s)).toBe(true);
      expect(POST_TRANSITIONS[s]).toEqual([]);
    }
  });

  it("is filled only from a live post — never from a draft, never from a terminal one", () => {
    expect(canTransitionPost("open", "filled")).toBe(true);
    expect(canTransitionPost("closed", "filled")).toBe(true);
    expect(canTransitionPost("draft", "filled")).toBe(false);
    expect(canTransitionPost("cancelled", "filled")).toBe(false);
    expect(canTransitionPost("expired", "filled")).toBe(false);
  });

  it("reopens a closed post and cancels from anywhere live", () => {
    expect(canTransitionPost("closed", "open")).toBe(true);
    for (const s of ["draft", "open", "closed"] as PostStatus[]) expect(canTransitionPost(s, "cancelled")).toBe(true);
  });

  it("derives expiry on read from closesAt, and only for an open post", () => {
    const now = T("2026-11-01T00:00:00Z");
    expect(effectivePostStatus({ status: "open", closesAt: T("2026-10-31T00:00:00Z") }, now)).toBe("expired");
    expect(effectivePostStatus({ status: "open", closesAt: T("2026-11-02T00:00:00Z") }, now)).toBe("open");
    expect(effectivePostStatus({ status: "open", closesAt: null }, now)).toBe("open");
    // A closed post past its closesAt is closed, not expired: somebody decided.
    expect(effectivePostStatus({ status: "closed", closesAt: T("2026-10-31T00:00:00Z") }, now)).toBe("closed");
  });
});

describe("the offer's life", () => {
  it("is awarded or not selected only from accepted, and only the award writes those", () => {
    expect(canTransitionOffer("accepted", "awarded")).toBe(true);
    expect(canTransitionOffer("accepted", "not_selected")).toBe(true);
    expect(canTransitionOffer("offered", "awarded")).toBe(false);
    expect(canTransitionOffer("declined", "awarded")).toBe(false);
  });

  it("answers an offer once: accepted and declined are terminal for the person", () => {
    expect(canTransitionOffer("offered", "accepted")).toBe(true);
    expect(canTransitionOffer("offered", "declined")).toBe(true);
    expect(canTransitionOffer("accepted", "declined")).toBe(false);
    expect(canTransitionOffer("declined", "accepted")).toBe(false);
  });

  it("keeps live exactly the two states somebody still has to decide on", () => {
    const live = (Object.keys(OFFER_TRANSITIONS) as OfferStatus[]).filter(isLiveOffer);
    expect(live.sort()).toEqual(["accepted", "offered"]);
  });

  it("expires an unanswered offer on read, and never an answered one", () => {
    const now = T("2026-11-01T00:00:00Z");
    expect(effectiveOfferStatus({ status: "offered", expiresAt: T("2026-10-31T00:00:00Z") }, now)).toBe("expired");
    expect(effectiveOfferStatus({ status: "accepted", expiresAt: T("2026-10-31T00:00:00Z") }, now)).toBe("accepted");
  });
});

describe("responses", () => {
  it("volunteers with every kind but declined", () => {
    expect(responseVolunteers("interested")).toBe(true);
    expect(responseVolunteers("available")).toBe(true);
    expect(responseVolunteers("request_assignment")).toBe(true);
    expect(responseVolunteers("declined")).toBe(false);
  });
});

describe("availability is a declaration", () => {
  const decl = (o: Partial<AvailabilityDeclaration>): AvailabilityDeclaration => ({
    state: "available", windowStartsAt: null, windowEndsAt: null, preferences: null, declaredAt: T("2026-09-01T00:00:00Z"), ...o,
  });

  it("covers half-open windows and every instant when standing", () => {
    const w = { windowStartsAt: T("2026-09-22T18:00:00Z"), windowEndsAt: T("2026-09-23T02:00:00Z") };
    expect(declarationCovers(w, T("2026-09-22T18:00:00Z"))).toBe(true);
    expect(declarationCovers(w, T("2026-09-23T02:00:00Z"))).toBe(false);
    expect(declarationCovers(w, T("2026-09-22T17:59:00Z"))).toBe(false);
    expect(declarationCovers({ windowStartsAt: null, windowEndsAt: null }, T("2031-01-01T00:00:00Z"))).toBe(true);
  });

  it("reads silence as undeclared — neither available nor unavailable", () => {
    expect(declaredStateAt([], T("2026-09-22T19:00:00Z"))).toBe("undeclared");
    expect(availabilityReasons({ state: "undeclared", preferences: null, post: { overtime: false, regionCode: null } }).map(r => r.code)).toEqual(["undeclared"]);
  });

  it("lets the latest declaration that covers the instant win", () => {
    const at = T("2026-09-22T19:00:00Z");
    const older = decl({ state: "available", declaredAt: T("2026-09-01T00:00:00Z") });
    const newer = decl({ state: "unavailable", windowStartsAt: T("2026-09-22T00:00:00Z"), windowEndsAt: T("2026-09-23T00:00:00Z"), declaredAt: T("2026-09-20T00:00:00Z") });
    expect(declaredStateAt([older, newer], at)).toBe("unavailable");
    expect(declaredStateAt([older, newer], T("2026-09-24T00:00:00Z"))).toBe("available");
  });

  it("excludes on a declared unavailability, a declined overtime, or a region outside the declared ones, and names each", () => {
    const prefs = { regions: ["HINTON"], equipmentClasses: [], jobTypes: [], maxDistanceKm: 150, overnight: false, nights: null, weekends: null, overtime: false };
    const codes = availabilityReasons({ state: "available", preferences: prefs, post: { overtime: true, regionCode: "JASPER" } }).map(r => r.code);
    expect(codes).toEqual(["declines_overtime", "outside_region"]);
    expect(availabilityReasons({ state: "unavailable", preferences: null, post: { overtime: false, regionCode: null } }).map(r => r.code)).toEqual(["declared_unavailable"]);
    expect(availabilityReasons({ state: "on_call", preferences: prefs, post: { overtime: false, regionCode: "HINTON" } })).toEqual([]);
  });
});

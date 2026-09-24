/**
 * 0187 — the pure rules behind Training Compliance Operations: escalation
 * ladders (company policy), what the worker sees, the delivery boundary,
 * two-person source review, and system failures kept apart from compliance.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPANY_POLICY_LABEL, DEFAULT_ESCALATION, NOT_CONFIGURED, categoryOf, deliverAcross, describeFailure, escalationFor, handoffRecoveryNote,
  impactStatus, nextEscalation, signalFor, sourceReviewDecision, stepAt, thresholdsOf, validateEscalation, walletStatus, type SourceForReview,
} from "./complianceOperations";
import { heldForWork, lifecycleFacts, planRenewalReminders, policyFor, type WalletHolding } from "./credentialLifecycle";
import { EXCEPTION_SOURCE_TENANCY, deriveExceptions } from "./exceptionCentre";

const NOW = new Date("2026-06-01T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const holding = (code: string, over: Partial<WalletHolding> = {}): WalletHolding => ({ holdingRef: `WQ-${code}`, code, verificationState: "verified", issuedAt: day(-700), expiresAt: day(40), recordedAt: day(-700), userId: 7, restrictions: [], supersededByHoldingRef: null, ...over });

describe("escalation ladder (company policy)", () => {
  it("defaults: 120 awareness, 90 employee, 60 +supervisor, 30 +safety/admin, 14 urgent, 7 and 1 critical, expired exception", () => {
    expect(thresholdsOf(DEFAULT_ESCALATION)).toEqual([120, 90, 60, 30, 14, 7, 1]);
    expect(stepAt(DEFAULT_ESCALATION, 120)).toMatchObject({ recipients: ["employee"], urgency: "awareness" });
    expect(stepAt(DEFAULT_ESCALATION, 60)!.recipients).toEqual(["employee", "supervisor"]);
    expect(stepAt(DEFAULT_ESCALATION, 30)!.recipients).toEqual(expect.arrayContaining(["employee", "safety", "hr"]));
    expect(stepAt(DEFAULT_ESCALATION, 14)!.urgency).toBe("urgent");
    expect(stepAt(DEFAULT_ESCALATION, 7)!.urgency).toBe("critical");
    expect(stepAt(DEFAULT_ESCALATION, 1)!.urgency).toBe("critical");
    expect(stepAt(DEFAULT_ESCALATION, "expired")!.urgency).toBe("exception");
    expect(validateEscalation(DEFAULT_ESCALATION)).toEqual([]);
  });

  it("is labelled company policy and may differ per category; a company ladder is validated", () => {
    const safety = { label: "x", steps: [{ threshold: 45, recipients: ["employee", "safety"] as const, urgency: "notice" as const }] };
    const by = { safety_ticket: { label: "x", steps: safety.steps.map(s => ({ ...s, recipients: [...s.recipients] })) } };
    expect(escalationFor(by, "safety_ticket").steps[0]!.threshold).toBe(45);
    expect(escalationFor(by, "driver_licence")).toMatchObject({ steps: DEFAULT_ESCALATION.steps });
    expect(escalationFor(by, "safety_ticket").label).toBe(COMPANY_POLICY_LABEL);
    expect(validateEscalation({ label: "", steps: [{ threshold: 10, recipients: ["safety"], urgency: "notice" }] }).join()).toMatch(/employee is told/);
    expect(validateEscalation({ label: "", steps: [{ threshold: 10, recipients: ["employee"], urgency: "notice" }, { threshold: 30, recipients: ["employee"], urgency: "notice" }] }).join()).toMatch(/widest to the tightest/);
    expect(validateEscalation({ label: "", steps: [{ threshold: 900, recipients: ["employee"], urgency: "notice" }] }).join()).toMatch(/1 to 730/);
    expect(categoryOf("WHMIS_EMPLOYER", "employer_review")).toBe("company_review");
    expect(categoryOf("H2S_ALIVE", "actual_expiry")).toBe("safety_ticket");
  });

  it("next escalation is the next threshold below the days remaining", () => {
    expect(nextEscalation(DEFAULT_ESCALATION, 40)).toMatchObject({ threshold: 30, inDays: 10 });
    expect(nextEscalation(DEFAULT_ESCALATION, 5)).toMatchObject({ threshold: 1, inDays: 4 });
    expect(nextEscalation(DEFAULT_ESCALATION, 0)).toMatchObject({ threshold: "expired", inDays: 1 });
    expect(nextEscalation(DEFAULT_ESCALATION, -3)).toBeNull();
    expect(nextEscalation(DEFAULT_ESCALATION, null)).toBeNull();
  });

  it("the ladder drives reminders: supervisor at 60, safety/hr at 30, CRITICAL prefix at 7; keys stay idempotent", () => {
    const plan = (days: number) => planRenewalReminders({ userId: 7, code: "H2S_ALIVE", holdings: [holding("H2S_ALIVE", { expiresAt: day(days) })], policy: policyFor("H2S_ALIVE"), now: NOW, escalation: DEFAULT_ESCALATION, supervisorUserId: 99 });
    const at60 = plan(59);
    expect(at60.map(p => p.recipient)).toEqual(expect.arrayContaining([{ kind: "user", userId: 7 }, { kind: "user", userId: 99 }]));
    expect(plan(29).some(p => p.recipient.kind === "role" && p.recipient.role === "safety")).toBe(true);
    expect(plan(6).every(p => p.title.startsWith("CRITICAL"))).toBe(true);
    expect(plan(59).map(p => p.notificationKey)).toEqual(at60.map(p => p.notificationKey));
  });

  it("Q (no expiry by rule) gets no fabricated notices", () => {
    const q = planRenewalReminders({ userId: 7, code: "AIR_BRAKE_Q", holdings: [holding("AIR_BRAKE_Q", { expiresAt: null })], policy: policyFor("AIR_BRAKE_Q"), now: NOW, escalation: DEFAULT_ESCALATION });
    expect(q).toEqual([]);
  });
});

describe("what the worker sees", () => {
  const status = (code: string, hs: WalletHolding[], handoff: Parameters<typeof walletStatus>[0]["handoff"] = null, settings = {}) =>
    walletStatus({ facts: lifecycleFacts({ code, holdings: hs, policy: policyFor(code), settings, now: NOW }), verdict: heldForWork(hs, code, NOW), handoff, now: NOW });

  it("VALID / EXPIRING / EXPIRED / UNVERIFIED", () => {
    expect(status("H2S_ALIVE", [holding("H2S_ALIVE", { expiresAt: day(400) })]).status).toBe("VALID");
    expect(status("H2S_ALIVE", [holding("H2S_ALIVE", { expiresAt: day(20) })]).status).toBe("EXPIRING");
    expect(status("H2S_ALIVE", [holding("H2S_ALIVE", { expiresAt: day(-2) })]).status).toBe("EXPIRED");
    expect(status("H2S_ALIVE", [holding("H2S_ALIVE", { verificationState: "unverified" })]).status).toBe("UNVERIFIED");
  });

  it("a renewal request, booking or upload is shown as progress and never extends validity", () => {
    const hs = [holding("H2S_ALIVE", { expiresAt: day(10) })];
    const requested = status("H2S_ALIVE", hs, { status: "REQUESTED", requestedAt: day(-1), appointmentAt: null });
    expect(requested).toMatchObject({ status: "EXPIRING", renewal: "RENEWAL_REQUESTED" });
    expect(requested.validityNote).toMatch(/does not extend it/);
    expect(status("H2S_ALIVE", hs, { status: "BOOKED", requestedAt: day(-1), appointmentAt: day(3) })).toMatchObject({ status: "EXPIRING", renewal: "BOOKED" });
    expect(status("H2S_ALIVE", [holding("H2S_ALIVE", { expiresAt: day(-1) })], { status: "DOCUMENT_UPLOADED_UNVERIFIED", requestedAt: day(-9), appointmentAt: null })).toMatchObject({ status: "EXPIRED", renewal: "AWAITING_DOCUMENT" });
  });

  it("a company review is COMPANY_REVIEW_DUE, never expired", () => {
    const w = status("WHMIS_EMPLOYER", [holding("WHMIS_EMPLOYER", { expiresAt: null, issuedAt: day(-360) })], null, { employerReviewMonths: 12 });
    expect(w.status).toBe("COMPANY_REVIEW_DUE");
    expect(w.line).toMatch(/not an expiry/);
    expect(w.line).not.toMatch(/Expired/);
  });

  it("dispatch explanation of a renewal in motion", () => {
    expect(handoffRecoveryNote({ status: "REQUESTED", appointmentAt: null })).toBe("Renewal requested — awaiting booking");
    expect(handoffRecoveryNote({ status: "DOCUMENT_UPLOADED_UNVERIFIED", appointmentAt: null })).toBe("Certificate uploaded — Safety verification required");
    expect(handoffRecoveryNote({ status: "BOOKED", appointmentAt: day(2) })).toMatch(/does not count until the new certificate is verified/);
    expect(handoffRecoveryNote({ status: "ACTIVE", appointmentAt: null })).toBeNull();
  });
});

describe("delivery boundary", () => {
  const msg = { recipient: "user:1", title: "t", body: "b" };
  it("in-app is recorded first; EMAIL/SMS without a provider report not_configured", async () => {
    const r = await deliverAcross({ channels: ["IN_APP", "EMAIL", "SMS"], inApp: async () => "recorded", adapters: {}, message: msg });
    expect(r.inApp).toBe("recorded");
    expect(r.external.map(x => [x.channel, x.status])).toEqual([["EMAIL", "not_configured"], ["SMS", "not_configured"]]);
    expect(NOT_CONFIGURED("EMAIL").configured).toBe(false);
  });
  it("an external failure never removes the in-app notification", async () => {
    let inAppWrites = 0;
    const r = await deliverAcross({ channels: ["IN_APP", "SMS"], inApp: async () => { inAppWrites++; return "recorded"; }, adapters: { SMS: { channel: "SMS", configured: true, deliver: async () => { throw new Error("gateway down"); } } }, message: msg });
    expect(inAppWrites).toBe(1);
    expect(r).toMatchObject({ inApp: "recorded", external: [{ channel: "SMS", status: "failed", detail: "gateway down" }] });
  });
  it("an already-delivered (suppressed) notice is not re-sent externally", async () => {
    let calls = 0;
    const r = await deliverAcross({ channels: ["EMAIL"], inApp: async () => "suppressed", adapters: { EMAIL: { channel: "EMAIL", configured: true, deliver: async () => { calls++; return { channel: "EMAIL", status: "recorded", detail: "" }; } } }, message: msg });
    expect(calls).toBe(0);
    expect(r.external).toEqual([]);
  });
});

describe("source review (two people)", () => {
  const src = (over: Partial<SourceForReview> = {}): SourceForReview => ({ sourceRef: "S1", reviewStatus: "unreviewed", proposedByUserId: null, firstReviewedByUserId: null, sourceUrl: "https://example.gov/x", edition: "2025", sourceTier: "regulator", ...over });
  const note = "Checked edition and URL against the authority";
  it("REVIEW then a different person APPROVEs", () => {
    expect(sourceReviewDecision({ action: "REVIEW", source: src(), actorUserId: 1, note })).toMatchObject({ permitted: true, next: "under_review" });
    expect(sourceReviewDecision({ action: "APPROVE", source: src({ reviewStatus: "under_review", firstReviewedByUserId: 1 }), actorUserId: 1, note }).blockers.join()).toMatch(/second person/);
    expect(sourceReviewDecision({ action: "APPROVE", source: src({ reviewStatus: "under_review", firstReviewedByUserId: 1 }), actorUserId: 2, note })).toMatchObject({ permitted: true, next: "reviewed" });
    expect(sourceReviewDecision({ action: "APPROVE", source: src(), actorUserId: 2, note }).permitted).toBe(false);
  });
  it("the proposer may neither review nor approve their own version; vendor tier is never trusted", () => {
    expect(sourceReviewDecision({ action: "REVIEW", source: src({ proposedByUserId: 5 }), actorUserId: 5, note }).permitted).toBe(false);
    expect(sourceReviewDecision({ action: "APPROVE", source: src({ reviewStatus: "under_review", proposedByUserId: 5, firstReviewedByUserId: 1 }), actorUserId: 5, note }).permitted).toBe(false);
    expect(sourceReviewDecision({ action: "APPROVE", source: src({ reviewStatus: "under_review", firstReviewedByUserId: 1, sourceTier: "vendor" }), actorUserId: 2, note }).permitted).toBe(false);
  });
  it("a reviewed source is superseded by a named live successor, never rejected; decided states are final", () => {
    expect(sourceReviewDecision({ action: "REJECT", source: src({ reviewStatus: "reviewed" }), actorUserId: 2, note }).permitted).toBe(false);
    expect(sourceReviewDecision({ action: "MARK_SUPERSEDED", source: src({ reviewStatus: "reviewed" }), actorUserId: 2, note }).permitted).toBe(false);
    expect(sourceReviewDecision({ action: "MARK_SUPERSEDED", source: src({ reviewStatus: "reviewed" }), successor: src({ sourceRef: "S2" }), actorUserId: 2, note })).toMatchObject({ permitted: true, next: "superseded" });
    expect(sourceReviewDecision({ action: "MARK_SUPERSEDED", source: src({ reviewStatus: "superseded" }), successor: src({ sourceRef: "S2" }), actorUserId: 2, note }).permitted).toBe(false);
    expect(sourceReviewDecision({ action: "REVIEW", source: src(), actorUserId: 1, note: "ok" }).permitted).toBe(false);
  });
  it("impact statuses", () => {
    expect([impactStatus("reviewed"), impactStatus("superseded"), impactStatus("unreviewed"), impactStatus("under_review"), impactStatus("rejected"), impactStatus(null)])
      .toEqual(["SOURCE_CURRENT", "SOURCE_SUPERSEDED_REVIEW_REQUIRED", "SOURCE_UNREVIEWED", "SOURCE_UNREVIEWED", "SOURCE_REJECTED", "SOURCE_UNREVIEWED"]);
  });
});

describe("system failures are not compliance conclusions", () => {
  const f = { kind: "NOTIFICATION_WRITE_FAILED" as const, tenantId: "ORG-A", subjectRef: null, detail: "db down" };
  it("SYSTEM_FAILURE vs QUALIFICATION_EXPIRED vs QUALIFICATION_UNKNOWN", () => {
    expect(signalFor({ failure: f, verdict: { held: true, reason: "", code: null } })).toBe("SYSTEM_FAILURE");
    expect(signalFor({ verdict: { held: false, reason: "", code: "expired" } })).toBe("QUALIFICATION_EXPIRED");
    expect(signalFor({ verdict: { held: false, reason: "", code: "unverified" } })).toBe("QUALIFICATION_UNKNOWN");
    expect(signalFor({ verdict: { held: true, reason: "", code: null } })).toBeNull();
    expect(describeFailure(f)).toMatch(/SYSTEM FAILURE .* says nothing about whether the credential is valid/);
  });
  it("a sweep failure becomes a visible Exception Centre item that names no credential state", () => {
    const empty = Object.fromEntries(Object.keys(EXCEPTION_SOURCE_TENANCY).filter(k => k !== "facilityDirectory").map(k => [k, []]));
    const ex = deriveExceptions({ ...empty, now: NOW, trainingSweepFailures: [{ tenantId: "ORG-A", runRef: "RUN-1", failureKind: "NOTIFICATION_WRITE_FAILED", subjectRef: null, detail: "db down", at: NOW }] } as never);
    const item = ex.find(e => e.key.startsWith("sweep-failure:RUN-1"))!;
    expect(item).toBeDefined();
    expect(item.title).toMatch(/^SYSTEM FAILURE/);
    expect(item.reason).not.toMatch(/\bexpired\b/i);
  });
});

describe("Exception Centre source tenancy audit", () => {
  it("classifies every ExceptionSources key", () => {
    const src = readFileSync(new URL("./exceptionCentre.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export type ExceptionSources = {"), src.indexOf("};", src.indexOf("export type ExceptionSources = {")));
    const keys = Array.from(body.matchAll(/^\s{2}(\w+)\??:/gm)).map(m => m[1]!).filter(k => k !== "now");
    expect(keys.length).toBeGreaterThan(10);
    expect(Object.keys(EXCEPTION_SOURCE_TENANCY).sort()).toEqual(Array.from(new Set(keys)).sort());
  });
});

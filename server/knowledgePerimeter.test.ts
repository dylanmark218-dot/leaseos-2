/**
 * The request perimeter and the learning intake.
 *
 * Two gates that must not be confused: what may be asked, and what may be
 * learned. The first is narrow, the second is wide, and the narrow thing is the
 * *destination* of learning rather than its source.
 */
import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_ORIGINS, PERIMETER_DOMAINS, classifyRequest, promote, routeLearning,
  type LearningIntake,
} from "./_core/knowledge/perimeter";

const NOW = new Date("2026-09-13T12:00:00Z");

describe("the request perimeter refuses off-domain work", () => {
  it("declines software development, which is the likeliest misuse", () => {
    for (const ask of [
      "write a python script to parse this csv",
      "build me an app for tracking my golf scores",
      "debug this stack trace",
      "refactor this react component",
    ]) {
      const v = classifyRequest(ask);
      expect(v.admitted, ask).toBe(false);
      if (!v.admitted) expect(v.code).toBe("SOFTWARE_DEVELOPMENT");
    }
  });

  it("declines general-assistant work", () => {
    for (const ask of ["write a poem about my dog", "give me a recipe for chili", "what movie should I watch"]) {
      const v = classifyRequest(ask);
      expect(v.admitted, ask).toBe(false);
      if (!v.admitted) expect(v.code).toBe("GENERAL_ASSISTANT");
    }
  });

  it("declines anything it cannot place in a domain", () => {
    const v = classifyRequest("what is the capital of France");
    expect(v.admitted).toBe(false);
    if (!v.admitted) expect(v.code).toBe("OUT_OF_PERIMETER");
  });

  it("tells the person what it does instead of only what it will not do", () => {
    const v = classifyRequest("write me a birthday card");
    if (v.admitted) throw new Error("expected refusal");
    expect(v.suggestion).toBeTruthy();
    expect(v.suggestion).toMatch(/trucks|jobs|compliance|equipment/i);
  });

  it("refuses before any retrieval or model call", () => {
    // The cost argument: an off-domain request should cost a string compare,
    // not a context window. This function touches nothing else.
    const src = require("node:fs").readFileSync(
      new URL("./_core/knowledge/perimeter.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function classifyRequest"), src.indexOf("/* ---", src.indexOf("export function classifyRequest")));
    for (const forbidden of ["await", "fetch(", "db.", "embed", "retrieve"]) {
      expect(fn, `classifyRequest must not ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the perimeter admits real operational language", () => {
  const asks: [string, string][] = [
    ["how many hours can I drive today", "hours_of_service"],
    ["what UN number is this load", "dangerous_goods"],
    ["why is unit 204 out of service", "mechanical_fleet"],
    ["is there a road ban on that route", "routing_navigation"],
    ["what am I missing before I leave", "dispatch"],
    ["when does my air brake ticket expire", "training"],
    ["why hasn't job 4821 invoiced", "billing"],
    ["how do I report a spill", "environmental"],
    ["what PPE do I need on that lease", "safety_ohs"],
    ["who can take the acid load tomorrow", "dispatch"],
  ];

  for (const [ask, domain] of asks) {
    it(`admits "${ask}"`, () => {
      const v = classifyRequest(ask);
      expect(v.admitted, ask).toBe(true);
      if (v.admitted) expect(v.domain).toBe(domain);
    });
  }

  it("admits an operations question that happens to contain a technical word", () => {
    // A dispatcher asking this is asking an operations question. Refusing it
    // for containing "query" would be the gate failing at its job.
    const v = classifyRequest("can you query which units are out of service");
    expect(v.admitted).toBe(true);
  });

  it("covers every domain in the perimeter document", () => {
    expect(PERIMETER_DOMAINS).toHaveLength(20);
  });
});

describe("learning is wide; promotion is not", () => {
  const intake = (o: Partial<LearningIntake>): LearningIntake => ({
    origin: "web_discovery", domain: "hours_of_service", claim: "a rule changed",
    observedAt: NOW, reportedBy: "assistant", ...o,
  });

  it("lets the assistant learn from the internet, into a queue", () => {
    const d = routeLearning(intake({ origin: "web_discovery" }));
    expect(d.destination).toBe("discovery_queue");
    expect(d.requiresHumanReview).toBe(true);
  });

  it("does not let even a regulator publication write a rule by itself", () => {
    const d = routeLearning(intake({ origin: "regulator_feed" }));
    expect(d.destination).toBe("discovery_queue");
    expect(d.requiresHumanReview).toBe(true);
    // A regulator publishing is evidence for a reviewer, not a reviewer.
    expect(d.reason).toContain("still needs a person");
  });

  it("lets field observation and job outcomes land autonomously, as operational knowledge", () => {
    for (const origin of AUTONOMOUS_ORIGINS) {
      const d = routeLearning(intake({ origin }));
      expect(d.destination).toBe("operational_knowledge");
      expect(d.requiresHumanReview).toBe(false);
      expect(d.authorityLevel).toBe("operational");
      // Which explains, and never authorizes.
      expect(d.reason).toContain("may never support a compliance or dispatch decision");
    }
  });

  it("never routes anything straight to the authoritative store", () => {
    for (const origin of ["web_discovery", "regulator_feed", "user_statement", "field_observation", "job_outcome", "vendor_document"] as const) {
      expect(routeLearning(intake({ origin })).destination).not.toBe("authoritative_rules");
    }
  });

  it("stops one conversation changing a fleet-wide rule", () => {
    const d = routeLearning(intake({ origin: "user_statement" }));
    expect(d.requiresHumanReview).toBe(true);
    expect(d.reason).toContain("one conversation must not");
  });
});

describe("promotion needs a person and a source", () => {
  const base = { reviewerUserId: 42, reviewedAt: NOW, authorityLevel: "law" as const,
    sourceTitle: "Hours of Service Regulations", jurisdiction: "CA-FEDERAL", contentHash: "abcdef123456789" };
  const intake: LearningIntake = { origin: "regulator_feed", domain: "hours_of_service",
    claim: "cycle changed", observedAt: NOW, reportedBy: "feed" };

  it("refuses promotion with no named reviewer", () => {
    expect(promote(intake, { ...base, reviewerUserId: 0 })).toMatchObject({ promoted: false });
    const r = promote(intake, { ...base, reviewerUserId: 0 });
    if (!r.promoted) expect(r.reason).toContain("automated promotion is not available");
  });

  it("refuses promotion without a source title or jurisdiction", () => {
    expect(promote(intake, { ...base, sourceTitle: "  " })).toMatchObject({ promoted: false });
    expect(promote(intake, { ...base, jurisdiction: "" })).toMatchObject({ promoted: false });
  });

  it("refuses to promote something as unverified", () => {
    const r = promote(intake, { ...base, authorityLevel: "unverified" });
    expect(r.promoted).toBe(false);
  });

  it("promotes with a reviewer, and records who and when", () => {
    const r = promote(intake, base);
    expect(r.promoted).toBe(true);
    if (!r.promoted) return;
    expect(r.authority.confidence).toBe("human_verified");
    expect(r.authority.lastVerifiedAt).toEqual(NOW);
    expect(r.authority.authorityLevel).toBe("law");
  });

  it("does not grant a licence by promoting authority", () => {
    const r = promote(intake, base);
    if (!r.promoted) throw new Error("expected promotion");
    // Establishing that something is law says nothing about whether its text
    // may be stored or quoted. Two assessments, two gates.
    expect(r.authority.licenceStatus).toBe("unknown");
    expect(r.authority.allowedUses).toEqual({ search: false, aiAnswer: false, training: false, reproduce: false });
  });
});

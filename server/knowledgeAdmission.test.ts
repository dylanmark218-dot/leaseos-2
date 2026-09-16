/**
 * The knowledge admission gate, tested against the case that motivated it:
 * a government course whose regulatory facts are public and whose text is not
 * obviously reusable.
 */
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_LEVELS, UNASSESSED, admit, checkClaim, isBinding, outranks, planAnswer,
  type KnowledgeAuthority,
} from "./_core/knowledge/admission";

const NOW = new Date("2026-09-13T12:00:00Z");

const authority = (o: Partial<KnowledgeAuthority>): KnowledgeAuthority => ({
  id: "K1", jurisdiction: "AB", authorityLevel: "law", sourceTitle: "Source",
  contentHash: "h", licenceStatus: "public",
  allowedUses: { search: true, aiAnswer: true, training: false, reproduce: true },
  confidence: "human_verified", ...o,
});

/** The Alberta Carrier Education course, as the perimeter would classify it. */
const CARRIER_COURSE = authority({
  id: "AB-CARRIER-ED",
  authorityLevel: "official_guidance",
  issuingAuthority: "Government of Alberta",
  sourceTitle: "Alberta Carrier Education Course",
  sourceUrl: "https://511.alberta.ca/",
  licenceStatus: "permission_required",
  // Referenceable, not reproducible, not training data. This is the split the
  // scrape-and-embed blueprint has no way to express.
  allowedUses: { search: true, aiAnswer: false, training: false, reproduce: false },
  confidence: "imported",
});

/** The regulation the course teaches, which stands on its own. */
const NSC_REG = authority({
  id: "NSC-HOS",
  authorityLevel: "law",
  issuingAuthority: "Canada",
  sourceTitle: "Commercial Vehicle Drivers Hours of Service Regulations",
  licenceStatus: "public",
  allowedUses: { search: true, aiAnswer: true, training: false, reproduce: true },
  confidence: "authority_confirmed",
});

describe("the licence check runs before anything is stored", () => {
  it("refuses every use of an unassessed source", () => {
    const unknown = authority({ licenceStatus: "unknown", allowedUses: UNASSESSED });
    for (const intent of ["index", "chunk", "answer", "quote", "train"] as const) {
      const r = admit(unknown, intent, NOW);
      expect(r.admitted, intent).toBe(false);
      if (!r.admitted) expect(r.code).toBe("LICENCE_UNASSESSED");
    }
  });

  it("treats chunking as reproduction, because it is", () => {
    // The heart of it. A pipeline may call this step "embedding"; it stores the
    // text either way.
    const r = admit(CARRIER_COURSE, "chunk", NOW);
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      expect(r.code).toBe("REPRODUCTION_NOT_PERMITTED");
      expect(r.reason).toContain("may be referenced but its text may not be stored");
    }
  });

  it("still allows the course to be indexed and linked", () => {
    expect(admit(CARRIER_COURSE, "index", NOW).admitted).toBe(true);
  });

  it("refuses it as training data separately from everything else", () => {
    const r = admit(CARRIER_COURSE, "train", NOW);
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.code).toBe("TRAINING_NOT_PERMITTED");
  });

  it("lets the underlying regulation through where the course cannot", () => {
    // Public regulatory fact versus course content: the distinction the
    // perimeter asks for, made mechanical.
    for (const intent of ["index", "chunk", "answer", "quote"] as const) {
      expect(admit(NSC_REG, intent, NOW).admitted, intent).toBe(true);
    }
    expect(admit(NSC_REG, "train", NOW).admitted).toBe(false);
  });
});

describe("time and supersession", () => {
  it("refuses a superseded source", () => {
    const r = admit(authority({ supersededById: "K2" }), "answer", NOW);
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.code).toBe("SUPERSEDED");
  });

  it("refuses a rule that has not taken effect", () => {
    const r = admit(authority({ effectiveFrom: new Date("2027-01-01") }), "answer", NOW);
    if (!r.admitted) expect(r.code).toBe("NOT_YET_EFFECTIVE");
    expect(r.admitted).toBe(false);
  });

  it("refuses one that has ceased to have effect", () => {
    const r = admit(authority({ effectiveUntil: new Date("2026-01-01") }), "answer", NOW);
    if (!r.admitted) expect(r.code).toBe("EXPIRED");
    expect(r.admitted).toBe(false);
  });
});

describe("planning an answer", () => {
  it("separates what may be quoted from what may only be cited", () => {
    const plan = planAnswer([
      { authority: NSC_REG, content: "drivers may not drive after 13 hours" },
      { authority: CARRIER_COURSE, content: "Module 7 explains the daily limit" },
    ], NOW);

    expect(plan.usable).toHaveLength(1);
    expect(plan.usable[0]?.authority.id).toBe("NSC-HOS");
    // Not dropped — pointed at. "We cannot quote this, here is where it is."
    expect(plan.referenceOnly).toHaveLength(1);
    expect(plan.referenceOnly[0]?.authority.id).toBe("AB-CARRIER-ED");
    expect(plan.withheld).toHaveLength(0);
  });

  it("reports the highest usable authority, not the highest retrieved", () => {
    const plan = planAnswer([{ authority: CARRIER_COURSE, content: "x" }], NOW);
    // The course is official guidance, but it cannot be answered from, so the
    // answer rests on nothing.
    expect(plan.highestUsable).toBeNull();
    expect(plan.advisoryOnly).toBe(true);
  });

  it("marks an answer advisory when only non-binding material is usable", () => {
    const note = authority({ id: "OPS", authorityLevel: "operational", sourceTitle: "Driver note" });
    const plan = planAnswer([{ authority: note, content: "the gate is usually open" }], NOW);
    expect(plan.highestUsable).toBe("operational");
    expect(plan.advisoryOnly).toBe(true);
  });

  it("is not advisory when a binding source is usable", () => {
    const plan = planAnswer([{ authority: NSC_REG, content: "x" }], NOW);
    expect(plan.advisoryOnly).toBe(false);
    expect(plan.highestUsable).toBe("law");
  });

  it("records a withheld source rather than silently shrinking the answer", () => {
    const secret = authority({ id: "S", licenceStatus: "internal",
      allowedUses: { search: false, aiAnswer: false, training: false, reproduce: false } });
    const plan = planAnswer([{ authority: secret, content: "x" }], NOW);
    expect(plan.withheld).toHaveLength(1);
    // A gap the caller can see is a gap somebody can fix.
    expect(plan.withheld[0]?.code).toBe("ANSWERING_NOT_PERMITTED");
  });
});

describe("authority never inverts", () => {
  it("ranks law above everything and unverified below everything", () => {
    for (const l of AUTHORITY_LEVELS) {
      if (l !== "law") expect(outranks("law", l), l).toBe(true);
      if (l !== "unverified") expect(outranks(l, "unverified"), l).toBe(true);
    }
  });

  it("treats company policy, operational notes and AI inference as non-binding", () => {
    expect(isBinding("company_policy")).toBe(false);
    expect(isBinding("operational")).toBe(false);
    expect(isBinding("unverified")).toBe(false);
    expect(isBinding("law")).toBe(true);
  });
});

describe("the AI may explain, but not decide", () => {
  it("lets an explanation rest on an operational note", () => {
    const r = checkClaim({ topic: "access", assertion: "that lease road is usually open",
      supportedBy: [authority({ authorityLevel: "operational" })], kind: "explanation" });
    expect(r.permitted).toBe(true);
  });

  it("refuses a decision resting on a driver observation", () => {
    // The perimeter's rule: Level F may explain, never authorize.
    const r = checkClaim({ topic: "hos", assertion: "you may drive another two hours",
      supportedBy: [authority({ authorityLevel: "unverified" })], kind: "decision" });
    expect(r.permitted).toBe(false);
    if (!r.permitted) expect(r.reason).toContain("needs binding authority");
  });

  it("refuses a decision resting only on company policy", () => {
    const r = checkClaim({ topic: "permit", assertion: "no permit is required",
      supportedBy: [authority({ authorityLevel: "company_policy" })], kind: "decision" });
    expect(r.permitted).toBe(false);
  });

  it("refuses a decision where nobody has verified the authority", () => {
    const r = checkClaim({ topic: "weight", assertion: "this axle group is legal",
      supportedBy: [authority({ authorityLevel: "law", confidence: "imported" })], kind: "decision" });
    expect(r.permitted).toBe(false);
    if (!r.permitted) expect(r.reason).toContain("a person has not confirmed");
  });

  it("permits a decision on verified binding authority", () => {
    const r = checkClaim({ topic: "hos", assertion: "the daily driving limit is 13 hours",
      supportedBy: [NSC_REG], kind: "decision" });
    expect(r.permitted).toBe(true);
  });

  it("refuses any claim with no authority at all", () => {
    const r = checkClaim({ topic: "x", assertion: "y", supportedBy: [], kind: "explanation" });
    expect(r.permitted).toBe(false);
  });
});

describe("the outcomes the AI may never produce", () => {
  it("names them explicitly rather than leaving them to judgement", () => {
    const src = require("node:fs").readFileSync(
      new URL("./_core/knowledge/admission.ts", import.meta.url), "utf8");
    for (const outcome of ["authorize_dispatch", "certify_driver", "issue_government_certificate",
      "clear_mechanical_defect", "finalize_invoice", "alter_audit_record"]) {
      expect(src).toContain(outcome);
    }
    // The one the screenshot makes concrete: the course issues a certificate
    // valid for a Safety Fitness Certificate application. LeaseOS teaching the
    // material does not issue that.
    expect(src).toContain("issue_government_certificate");
  });
});

/**
 * The source licence gate, tested against the real 511 Alberta assessment.
 *
 * Every row of the assessment's risk table is a test, so the code and the
 * document cannot drift apart without something going red.
 */
import { describe, expect, it } from "vitest";
import {
  AB_511, advance, allowedUsesFrom, authorityFrom, authorizeCommercialUse,
  checkSourceGate, licenceFor, registeredSources,
  type IngestionPurpose, type SourceLicenceRecord,
} from "./_core/knowledge/sourceGate";
import { admit, planAnswer } from "./_core/knowledge/admission";

const NOW = new Date("2026-09-13T12:00:00Z");

describe("an unassessed source can do nothing", () => {
  it("refuses every purpose for a source not in the registry", () => {
    const purposes: IngestionPurpose[] = ["link_only", "metadata_only", "rag_ingestion",
      "api_production", "model_training", "commercial_redisplay"];
    for (const p of purposes) {
      const g = checkSourceGate("some-blog-i-found", p);
      expect(g.allowed, p).toBe(false);
      if (!g.allowed) expect(g.code).toBe("NO_LICENCE_ASSESSMENT");
    }
  });

  it("says what would unblock it rather than only refusing", () => {
    const g = checkSourceGate("unknown-source", "rag_ingestion");
    if (g.allowed) throw new Error("expected refusal");
    expect(g.conditions[0]).toContain("Create a licence assessment");
  });
});

describe("the 511 Alberta risk table, row by row", () => {
  const rows: [IngestionPurpose, boolean, string][] = [
    ["link_only", true, "Link to 511 Alberta"],
    ["metadata_only", true, "Store title/source metadata"],
    ["api_dev_testing", true, "Live API experimentation in non-production dev"],
    ["api_production", false, "Commercial live API use"],
    ["rag_ingestion", false, "Bulk ingest carrier course into RAG"],
    ["model_training", false, "Fine-tune AI on course/site content"],
    ["commercial_redisplay", false, "Redisplay API responses to paying customers"],
  ];

  for (const [purpose, allowed, label] of rows) {
    it(`${allowed ? "allows" : "blocks"}: ${label}`, () => {
      expect(checkSourceGate(AB_511.source_id, purpose).allowed, label).toBe(allowed);
    });
  }

  it("blocks commercial uses as commercial, not as a generic refusal", () => {
    for (const p of ["api_production", "commercial_redisplay", "rag_ingestion"] as IngestionPurpose[]) {
      const g = checkSourceGate(AB_511.source_id, p);
      if (g.allowed) throw new Error(`expected ${p} blocked`);
      expect(g.code).toBe("COMMERCIAL_USE_UNAUTHORIZED");
    }
  });

  it("carries the assessment's reasons into the refusal", () => {
    const g = checkSourceGate(AB_511.source_id, "rag_ingestion");
    if (g.allowed) throw new Error("expected refusal");
    expect(g.conditions).toContain("Store written permission or explicit licence covering LeaseOS commercial use.");
  });

  it("records the assessment rather than a summary of it", () => {
    expect(AB_511.reasons).toHaveLength(4);
    expect(AB_511.reasons.join(" ")).toContain("not intended to be reproduced or sold for commercial purposes");
    expect(AB_511.sources).toContain("https://511.alberta.ca/developers/doc");
  });
});

describe("nothing leaves quarantine without the gate", () => {
  it("rejects a blocked purpose at the transition", () => {
    const r = advance("QUARANTINED", AB_511.source_id, "rag_ingestion");
    expect(r.to).toBe("REJECTED");
    expect(r.reason).toContain("commercial");
  });

  it("lets an authorized purpose through to the licence-checked state", () => {
    const r = advance("QUARANTINED", AB_511.source_id, "link_only");
    expect(r.to).toBe("LICENCE_CHECKED");
    expect(r.reason).toContain(AB_511.assessment_id);
  });

  it("has no path to PUBLISHED that skips the licence check", () => {
    // Walk the whole lifecycle from quarantine. The only first step is the gate.
    let state = advance("QUARANTINED", AB_511.source_id, "rag_ingestion").to;
    expect(state).toBe("REJECTED");
    // And a rejected job is terminal.
    expect(advance("REJECTED", AB_511.source_id, "rag_ingestion").to).toBe("REJECTED");
  });

  it("reaches PUBLISHED only after the full chain for an allowed purpose", () => {
    const seen: string[] = ["QUARANTINED"];
    let state = "QUARANTINED" as ReturnType<typeof advance>["to"];
    for (let i = 0; i < 6; i++) {
      state = advance(state, AB_511.source_id, "link_only").to;
      seen.push(state);
      if (state === "PUBLISHED") break;
    }
    expect(seen).toEqual(["QUARANTINED", "LICENCE_CHECKED", "PARSED", "CLASSIFIED", "VERIFIED", "PUBLISHED"]);
  });
});

describe("commercial use cannot be flipped without a letter", () => {
  it("refuses authorization with no permission document", () => {
    const r = authorizeCommercialUse(AB_511, { documentId: "", scope: ["api_production"], recordedByUserId: 5 });
    expect(r.authorized).toBe(false);
    if (!r.authorized) expect(r.reason).toContain("no other way to authorize");
  });

  it("refuses authorization nobody recorded", () => {
    expect(authorizeCommercialUse(AB_511, { documentId: "PERM-1", scope: ["api_production"], recordedByUserId: 0 }).authorized).toBe(false);
  });

  it("refuses a permission that names no uses", () => {
    expect(authorizeCommercialUse(AB_511, { documentId: "PERM-1", scope: [], recordedByUserId: 5 }).authorized).toBe(false);
  });

  it("grants only the uses the permission actually covers", () => {
    // A letter about the API is not a licence for the course.
    const r = authorizeCommercialUse(AB_511, {
      documentId: "PERM-AB-2026-11", scope: ["api_production"], recordedByUserId: 5,
    });
    expect(r.authorized).toBe(true);
    if (!r.authorized) return;
    expect(r.record.api_production_authorized).toBe(true);
    expect(r.record.rag_ingestion_authorized).toBe(false);
    expect(r.record.model_training_authorized).toBe(false);
    expect(r.record.commercial_reuse_authorized).toBe(false);
    expect(r.record.permission_document_id).toBe("PERM-AB-2026-11");
  });

  it("leaves the stored record untouched", () => {
    authorizeCommercialUse(AB_511, { documentId: "PERM-X", scope: ["rag_ingestion"], recordedByUserId: 1 });
    // The registry entry is not mutated by an authorization attempt.
    expect(licenceFor(AB_511.source_id)?.commercial_reuse_authorized).toBe(false);
    expect(licenceFor(AB_511.source_id)?.permission_document_id).toBeNull();
  });
});

describe("the licence record drives the answer gate", () => {
  it("gives 511 search but not answering, quoting or training", () => {
    const uses = allowedUsesFrom(AB_511);
    expect(uses).toEqual({ search: true, aiAnswer: false, training: false, reproduce: false });
  });

  it("makes a 511 passage reference-only in a real answer plan", () => {
    const authority = authorityFrom(AB_511, {
      authorityLevel: "official_guidance",
      sourceTitle: "Alberta Carrier Education Course",
      contentHash: "abc123def456",
      sourceUrl: "https://commercial-driver-training.511.alberta.ca/",
    });

    const plan = planAnswer([{ authority, content: "Module 7 explains the daily limit" }], NOW);
    // Cited and linked, never quoted — the assessment's ALLOW and BLOCK rows
    // arriving intact at the point an answer is composed.
    expect(plan.usable).toHaveLength(0);
    expect(plan.referenceOnly).toHaveLength(1);
    expect(plan.advisoryOnly).toBe(true);
    expect(admit(authority, "chunk", NOW).admitted).toBe(false);
    expect(admit(authority, "index", NOW).admitted).toBe(true);
  });

  it("marks the licence status as permission_required, not unknown", () => {
    const a = authorityFrom(AB_511, { authorityLevel: "official_guidance", sourceTitle: "x", contentHash: "y" });
    // Assessed and refused is a different state from never looked at.
    expect(a.licenceStatus).toBe("permission_required");
    expect(a.issuingAuthority).toContain("Alberta");
  });

  it("opens answering only once a permission covers both reuse and ingestion", () => {
    const granted = authorizeCommercialUse(AB_511, {
      documentId: "PERM-FULL", scope: ["rag_ingestion", "commercial_redisplay"], recordedByUserId: 9,
    });
    if (!granted.authorized) throw new Error("expected authorization");
    expect(allowedUsesFrom(granted.record)).toMatchObject({ aiAnswer: true, reproduce: true });
    // Still not training — that was not in scope.
    expect(allowedUsesFrom(granted.record).training).toBe(false);
  });
});

describe("one blocked source is not a blocked government", () => {
  it("registers sources individually", () => {
    expect(registeredSources()).toEqual(["gov-ab-511"]);
    // Alberta's Open Government program licenses other material separately, so
    // a second Alberta source gets its own assessment rather than inheriting
    // this one.
    expect(licenceFor("gov-ab-open-data")).toBeNull();
  });

  it("refuses an unassessed Alberta source rather than reusing the 511 decision", () => {
    const g = checkSourceGate("gov-ab-open-data", "rag_ingestion");
    if (g.allowed) throw new Error("expected refusal");
    expect(g.code).toBe("NO_LICENCE_ASSESSMENT");
  });
});

describe("the record shape matches the stored assessment", () => {
  it("keeps the critical stored state exactly", () => {
    const critical: Partial<SourceLicenceRecord> = {
      source_id: "gov-ab-511",
      status: "blocked_pending_written_permission",
      commercial_reuse_authorized: false,
      api_production_authorized: false,
      rag_ingestion_authorized: false,
      model_training_authorized: false,
      linking_authorized: true,
      metadata_only_authorized: true,
    };
    expect(AB_511).toMatchObject(critical);
  });
});

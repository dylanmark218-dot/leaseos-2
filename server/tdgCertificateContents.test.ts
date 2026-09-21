import { describe, it, expect } from "vitest";
import {
  TDG_6_2_TOPICS, TDG_ROAD_TOPIC_CODES, TDG_EXPIRY_LABEL_EN, TDG_EXPIRY_LABEL_FR,
  deriveTrainingAspects, certificateContentDecision, renderExpiryLine,
  type Tdg62TopicCode, type CertificateContents,
} from "./_core/tdgCertificateContents";

const ROAD = [...TDG_ROAD_TOPIC_CODES] as Tdg62TopicCode[];

function derive(over: Partial<Parameters<typeof deriveTrainingAspects>[0]> = {}) {
  return deriveTrainingAspects({
    courseVersionRef: "CV-TDG-ROAD-2026.1",
    coveredTopicCodes: ROAD,
    dangerousGoodsScope: "Class 3, Flammable Liquids",
    mode: "road",
    ...over,
  });
}

describe("s.6.2 topic list", () => {
  it("carries all thirteen paragraphs, (a) through (m)", () => {
    expect(TDG_6_2_TOPICS.length).toBe(13);
    expect(TDG_6_2_TOPICS[0]!.ref).toBe("6.2(a)");
    expect(TDG_6_2_TOPICS[12]!.ref).toBe("6.2(m)");
  });
  it("excludes the air and marine topics from the road set", () => {
    expect(ROAD.includes("air" as Tdg62TopicCode)).toBe(false);
    expect(ROAD.includes("marine" as Tdg62TopicCode)).toBe(false);
    expect(ROAD.length).toBe(11);
  });
});

describe("deriveTrainingAspects", () => {
  it("builds a statement in Transport Canada's own form", () => {
    const r = derive();
    expect(r.blockers.length).toBe(0);
    expect(r.aspects!.statement).toBe("All aspects of handling and transporting Class 3, Flammable Liquids by road vehicle");
  });
  it("ties the aspects to the course version they came from", () => {
    expect(derive().aspects!.courseVersionRef).toBe("CV-TDG-ROAD-2026.1");
  });
  it("blocks an empty or whitespace scope", () => {
    expect(derive({ dangerousGoodsScope: "" }).aspects).toBe(null);
    expect(derive({ dangerousGoodsScope: "   " }).blockers[0]).toContain("scope is required");
  });
  it("blocks a course version covering no s.6.2 topics", () => {
    const r = derive({ coveredTopicCodes: [] });
    expect(r.aspects).toBe(null);
    expect(r.blockers[0]).toContain("no s.6.2 topics");
  });
  it("blocks a scope claiming 'all' when the course misses core road topics", () => {
    const r = derive({ dangerousGoodsScope: "all dangerous goods", coveredTopicCodes: ["classification", "marks"] as Tdg62TopicCode[] });
    expect(r.aspects).toBe(null);
    expect(r.blockers[0]).toContain("does not cover");
  });
  it("allows a narrow scope on a partial course — s.6.2 scopes topics to the person's duties", () => {
    const r = derive({ dangerousGoodsScope: "Class 3 only", coveredTopicCodes: ["classification", "marks"] as Tdg62TopicCode[] });
    expect(r.blockers.length).toBe(0);
  });
  it("does not mistake a word merely starting with 'all' for an all-scope claim", () => {
    const r = derive({ dangerousGoodsScope: "Allied solvent products", coveredTopicCodes: ["classification"] as Tdg62TopicCode[] });
    expect(r.blockers.length).toBe(0);
  });
  it("uses the right verb and mode wording per mode", () => {
    expect(derive({ mode: "rail" }).aspects!.statement).toContain("by railway vehicle");
    expect(derive({ mode: "vessel", coveredTopicCodes: ["marine"] as Tdg62TopicCode[] }).aspects!.statement)
      .toContain("offering for transport");
  });
  // 6.2(l) and (m) are mode-conditional topics. An air certificate whose course
  // never covered the air topic is claiming aspects the training did not deliver.
  it("blocks an air certificate whose course does not cover the air topic", () => {
    const r = derive({ mode: "air", coveredTopicCodes: ROAD });
    expect(r.aspects).toBe(null);
  });
  it("blocks a vessel certificate whose course does not cover the marine topic", () => {
    const r = derive({ mode: "vessel", coveredTopicCodes: ROAD });
    expect(r.aspects).toBe(null);
  });
});

describe("s.6.3(1) content completeness", () => {
  const full: CertificateContents = {
    employerName: "Example Transport Ltd.",
    employerBusinessAddress: "123 Range Road, Grande Prairie AB",
    employeeName: "A. Driver",
    expiresAt: new Date("2029-09-11T00:00:00Z"),
    trainingAspects: derive().aspects,
  };
  const decide = (o: Partial<CertificateContents> = {}, boundary: "employer_certificate" | "company_certificate" = "employer_certificate") =>
    certificateContentDecision({ contents: { ...full, ...o }, credentialBoundary: boundary, regulated: true });

  it("permits a complete certificate and returns a content hash", () => {
    const r = decide();
    expect(r.permitted).toBe(true);
    expect(typeof r.contentHash).toBe("string");
  });
  it("names the paragraph for each missing item", () => {
    expect(decide({ employerName: null }).blockers[0]).toContain("6.3(1)(a)");
    expect(decide({ employerBusinessAddress: "  " }).blockers[0]).toContain("6.3(1)(a)");
    expect(decide({ employeeName: null }).blockers[0]).toContain("6.3(1)(b)");
    expect(decide({ expiresAt: null }).blockers[0]).toContain("6.3(1)(c)");
    expect(decide({ trainingAspects: null }).blockers[0]).toContain("6.3(1)(d)");
  });
  it("withholds the hash whenever anything is missing", () => {
    expect(decide({ employeeName: null }).contentHash).toBe(null);
    expect(decide({ employeeName: null }).permitted).toBe(false);
  });
  it("reports every missing item at once, not just the first", () => {
    expect(decide({ employerName: null, employeeName: null, expiresAt: null }).blockers.length).toBe(3);
  });
  it("does not gate a company certificate on statutory content", () => {
    expect(decide({ employerName: null }, "company_certificate").permitted).toBe(true);
  });
  it("binds the required expiry wording into the hash", () => {
    const a = decide().contentHash;
    const b = certificateContentDecision({ contents: { ...full, employeeName: "B. Driver" }, credentialBoundary: "employer_certificate", regulated: true }).contentHash;
    expect(a === b).toBe(false);
  });
});

describe("s.6.3(1)(c) expiry wording", () => {
  const d = new Date("2029-09-11T00:00:00Z");
  it("prefixes the date with the words the regulation specifies", () => {
    expect(renderExpiryLine(d)).toBe(`${TDG_EXPIRY_LABEL_EN} 2029-09-11`);
    expect(renderExpiryLine(d, "fr")).toBe(`${TDG_EXPIRY_LABEL_FR} 2029-09-11`);
  });
  it("never renders a bare date", () => {
    expect(renderExpiryLine(d).startsWith("2029")).toBe(false);
  });
});

describe("mode-conditional topics — 6.2(l) and 6.2(m)", () => {
  const base = [...TDG_ROAD_TOPIC_CODES] as Tdg62TopicCode[];
  const d = (mode: "road" | "rail" | "vessel" | "air", codes: Tdg62TopicCode[]) =>
    deriveTrainingAspects({ courseVersionRef: "CV-X", coveredTopicCodes: codes, dangerousGoodsScope: "Class 3", mode });

  it("air requires the air topic and names the paragraph when it is absent", () => {
    const r = d("air", base);
    expect(r.aspects).toBe(null);
    expect(r.blockers[0]).toContain("6.2(l)");
  });
  it("air passes once the course covers it", () => {
    expect(d("air", [...base, "air"] as Tdg62TopicCode[]).blockers.length).toBe(0);
  });
  it("vessel requires the marine topic", () => {
    expect(d("vessel", base).blockers[0]).toContain("6.2(m)");
    expect(d("vessel", [...base, "marine"] as Tdg62TopicCode[]).blockers.length).toBe(0);
  });
  it("road and rail require neither", () => {
    expect(d("road", base).blockers.length).toBe(0);
    expect(d("rail", base).blockers.length).toBe(0);
  });
  it("blocks a narrow air scope too — the statement still says 'by aircraft'", () => {
    // The old bug: coverage was only checked for road, and only when the scope
    // claimed "all". A narrow air scope on a road course passed.
    const r = deriveTrainingAspects({ courseVersionRef: "CV-X", coveredTopicCodes: ["classification"] as Tdg62TopicCode[], dangerousGoodsScope: "Class 3 only", mode: "air" });
    expect(r.aspects).toBe(null);
  });
});

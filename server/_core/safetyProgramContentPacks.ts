/**
 * The content packs the library can load. Each pack is one category of the
 * Alberta Commercial / Oilfield Safety Template Pack; categories are added one
 * at a time as their text is written. Loading never overwrites a template a
 * person has reviewed.
 */
import type { ContentPack } from "./safetyProgramContentTypes";
import { COMPANY_FOUNDATION } from "./safetyProgramContent/companyFoundation";
import { OHS } from "./safetyProgramContent/ohs";
import { NSC_TRUCKING } from "./safetyProgramContent/nscTrucking";
import { OILFIELD_INDUSTRIAL } from "./safetyProgramContent/oilfieldIndustrial";

export const CONTENT_PACKS: readonly ContentPack[] = [
  { packRef: "ab_commercial_oilfield_v1.company_foundation", title: "Alberta Commercial / Oilfield pack — Company foundation", moduleKey: "company_foundation", templates: COMPANY_FOUNDATION },
  { packRef: "ab_commercial_oilfield_v1.ohs", title: "Alberta Commercial / Oilfield pack — Occupational health and safety", moduleKey: "ohs", templates: OHS },
  { packRef: "ab_commercial_oilfield_v1.nsc_trucking", title: "Alberta Commercial / Oilfield pack — Commercial trucking / National Safety Code", moduleKey: "nsc_trucking", templates: NSC_TRUCKING },
  { packRef: "ab_commercial_oilfield_v1.oilfield_industrial", title: "Alberta Commercial / Oilfield pack — Oilfield and industrial operations", moduleKey: "oilfield_industrial", templates: OILFIELD_INDUSTRIAL },
];

export function contentForTemplate(templateKey: string) {
  for (const p of CONTENT_PACKS) { const t = p.templates.find(x => x.templateKey === templateKey); if (t) return { pack: p, template: t }; }
  return null;
}

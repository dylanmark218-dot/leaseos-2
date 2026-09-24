/**
 * The content packs the library can load. Each pack is one category of the
 * Alberta Commercial / Oilfield Safety Template Pack; categories are added one
 * at a time as their text is written. Loading never overwrites a template a
 * person has reviewed.
 */
import type { ContentPack } from "./safetyProgramContentTypes";
import { COMPANY_FOUNDATION } from "./safetyProgramContent/companyFoundation";

export const CONTENT_PACKS: readonly ContentPack[] = [
  { packRef: "ab_commercial_oilfield_v1.company_foundation", title: "Alberta Commercial / Oilfield pack — Company foundation", moduleKey: "company_foundation", templates: COMPANY_FOUNDATION },
];

export function contentForTemplate(templateKey: string) {
  for (const p of CONTENT_PACKS) { const t = p.templates.find(x => x.templateKey === templateKey); if (t) return { pack: p, template: t }; }
  return null;
}

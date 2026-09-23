/**
 * 0172 — optional employee development pathways.
 *
 * Pure. A visualization of where somebody is, not an eligibility decision.
 * Every step reads a fact LeaseOS actually has — a finished Academy course, a
 * competent practical sign-off, a credential the canonical rule counts as
 * held. Where the step depends on a government rule LeaseOS cannot prove from
 * verified evidence (age, driving record, provincial eligibility), the answer
 * is UNKNOWN / VERIFY WITH AUTHORITY, never "eligible".
 */
import { heldForWork, type WalletHolding } from "./credentialLifecycle";

export type PathwayStepKind = "role" | "study" | "external_credential" | "company_competency" | "authority_eligibility" | "experience";
export type PathwayStep = {
  code: string;
  title: string;
  kind: PathwayStepKind;
  /** study: Academy course code; external_credential: qualification code; company_competency: competency/qualification code. */
  ref: string | null;
  /** external_credential only: a holding with these restrictions does NOT complete the step (e.g. full Class 1). */
  mustNotHaveRestrictions?: string[];
  note?: string;
};
export type PathwayDefinition = { code: string; title: string; jurisdiction: string; steps: PathwayStep[]; disclaimer: string };

const DISCLAIMER = "A development view only. It does not decide regulatory eligibility; where LeaseOS cannot prove a government requirement from verified evidence it says so.";

export const CAREER_PATHWAYS: readonly PathwayDefinition[] = [
  {
    code: "SWAMPER-TO-DRIVER", title: "Swamper → active Class 3 driver", jurisdiction: "CA-AB", disclaimer: DISCLAIMER,
    steps: [
      { code: "ROLE", title: "Swamper / labourer on a crew", kind: "role", ref: null },
      { code: "FOUNDATION", title: "Commercial Driver Fundamentals (study)", kind: "study", ref: "AB-COMMERCIAL-FOUNDATION" },
      { code: "C3-STUDY", title: "Class 3 preparation (study)", kind: "study", ref: "CLASS3" },
      { code: "C3-ELIGIBLE", title: "Eligibility for Class 3 testing", kind: "authority_eligibility", ref: null, note: "Knowledge test, vision, medical and road test are administered by Alberta registries/examiners." },
      { code: "C3-LICENCE", title: "External Class 3 licence (verified)", kind: "external_credential", ref: "DRIVER_LICENCE_CLASS_3" },
      { code: "Q", title: "Air Brake Q endorsement where required (verified)", kind: "external_credential", ref: "AIR_BRAKE_Q" },
      { code: "EQUIPMENT", title: "Supervised company equipment training + practical sign-off", kind: "company_competency", ref: "LOAD_SECUREMENT_COMPETENT" },
      { code: "ACTIVE", title: "Active driver", kind: "role", ref: "driver" },
    ],
  },
  {
    code: "CLASS3-TO-CLASS1", title: "Experienced Class 3 driver → full Class 1", jurisdiction: "CA-AB", disclaimer: DISCLAIMER,
    steps: [
      { code: "C3", title: "Verified Class 3 licence", kind: "external_credential", ref: "DRIVER_LICENCE_CLASS_3" },
      { code: "C1-STUDY", title: "Class 1 preparation (supplementary study)", kind: "study", ref: "CLASS1" },
      { code: "C1LP", title: "Official Alberta Class 1 Learning Pathway (licensed driver training school)", kind: "authority_eligibility", ref: null, note: "LeaseOS tracks progress you report; the provincial program and school confirm it." },
      { code: "C1-RESTRICTED", title: "Class 1 licence (restricted where applicable)", kind: "external_credential", ref: "DRIVER_LICENCE_CLASS_1" },
      { code: "EXPERIENCE", title: "Experience and competence building", kind: "experience", ref: null },
      { code: "C1-FULL", title: "Unrestricted / interprovincial Class 1 (verified, no provincial restriction)", kind: "external_credential", ref: "DRIVER_LICENCE_CLASS_1", mustNotHaveRestrictions: ["PROVINCIAL_RESTRICTION", "AB_PROVINCIAL_RESTRICTION"] },
    ],
  },
];

export type StepState = "complete" | "in_progress" | "not_started" | "UNKNOWN_VERIFY_WITH_AUTHORITY";

export function evaluatePathway(args: {
  pathway: PathwayDefinition;
  roles: readonly string[];
  studied: readonly { courseCode: string; status: string }[];
  holdings: readonly WalletHolding[];
  competentCodes: readonly string[];
  at: Date;
}): { code: string; title: string; disclaimer: string; steps: (PathwayStep & { state: StepState; detail: string })[] } {
  const steps = args.pathway.steps.map(step => {
    switch (step.kind) {
      case "role": {
        const done = step.ref ? args.roles.includes(step.ref) : args.roles.length > 0;
        return { ...step, state: (done ? "complete" : "not_started") as StepState, detail: done ? "Role on record" : "Not in this role yet" };
      }
      case "study": {
        const a = args.studied.filter(s => s.courseCode === step.ref);
        const done = a.some(s => s.status === "completed" || s.status === "practical_pending");
        return { ...step, state: (done ? "complete" : a.length ? "in_progress" : "not_started") as StepState, detail: done ? "Study complete — preparation only, not a licence" : a.length ? "Study in progress" : "Not started" };
      }
      case "external_credential": {
        const v = heldForWork(args.holdings, step.ref!, args.at);
        if (!v.held) {
          const onFile = args.holdings.some(h => h.code === step.ref);
          return { ...step, state: (onFile ? "in_progress" : "not_started") as StepState, detail: v.reason };
        }
        if (step.mustNotHaveRestrictions?.length) {
          const current = args.holdings.filter(h => h.code === step.ref && h.verificationState === "verified" && !h.supersededByHoldingRef).sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0];
          if ((current?.restrictions ?? []).some(r => step.mustNotHaveRestrictions!.includes(r))) {
            return { ...step, state: "in_progress" as StepState, detail: "Verified licence carries a provincial restriction" };
          }
        }
        return { ...step, state: "complete" as StepState, detail: "Verified credential held" };
      }
      case "company_competency": {
        const done = args.competentCodes.includes(step.ref!) || heldForWork(args.holdings, step.ref!, args.at).held;
        return { ...step, state: (done ? "complete" : "not_started") as StepState, detail: done ? "Company competency verified" : "Practical sign-off by an authorized evaluator required" };
      }
      case "authority_eligibility":
      case "experience":
        return { ...step, state: "UNKNOWN_VERIFY_WITH_AUTHORITY" as StepState, detail: step.note ?? "Cannot be proven from verified evidence in LeaseOS — verify with the authority" };
    }
  });
  return { code: args.pathway.code, title: args.pathway.title, disclaimer: args.pathway.disclaimer, steps };
}

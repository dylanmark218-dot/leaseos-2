/**
 * v22.20 — a roadside stop, and what it is allowed to do on its own.
 *
 * Pure. No network, no database.
 *
 * **On licensed criteria.** The detailed out-of-service criteria are a
 * separately published and separately licensed product, updated annually. This
 * module stores LeaseOS's own violation identifiers, its own applicability
 * logic, and a *reference* to the official source — never the criteria text.
 * `sourceReference` is a citation, and there is no field here for the wording
 * it cites. Copying the handbook into the product is not a thing this design
 * can do by accident.
 *
 * Five invariants, each of which is a bug somebody has shipped before.
 *
 * **A citation is not an out-of-service order.** `if (ticket) unit.oos = true`
 * grounds a legal truck. The six consequences of a violation — citation,
 * out-of-service, defect, repair, court, dispatch block — are independent
 * booleans recorded from the document, never derived from one another.
 *
 * **`outOfService = true` is not a state.** A driver can be prohibited while
 * the truck is fine, and the truck can be prohibited while the driver is fine
 * and free to take another unit. Scope is part of the order.
 *
 * **Repair complete is not release.** A mechanic finishing the work and the
 * order's release condition being satisfied are two events with two actors. No
 * path here lets the first produce the second.
 *
 * **Unknown denies.** An inspection whose result nobody has established does
 * not read as a pass. It denies authorization while still permitting the field
 * to record everything it saw.
 *
 * **The order binds before the server hears about it.** The consequence is
 * computed from the order, so a device holding one it has not yet synced blocks
 * the unit locally. A truck placed out of service on a highway with no signal
 * is out of service.
 */

export type OosScope = "driver" | "vehicle" | "trailer" | "cargo" | "carrier";
export const OOS_SCOPES: readonly OosScope[] = ["driver", "vehicle", "trailer", "cargo", "carrier"];

export type InspectionResult = "pass" | "requires_attention" | "out_of_service" | "unknown";

/**
 * One violation as the document recorded it. Every consequence is its own
 * field, taken from the paperwork rather than inferred from a sibling.
 */
export type ViolationFacts = {
  violationRef: string;
  /** LeaseOS's own taxonomy — brakes, tires, hos, securement, placard… */
  system: string;
  /** LeaseOS's own identifier. Never a licensed criteria code reproduced verbatim. */
  ownCode: string;
  /** A citation of the official source. There is deliberately no field for its text. */
  sourceReference: string | null;
  citationIssued: boolean;
  outOfService: boolean;
  oosScope: OosScope | null;
  defectRequired: boolean;
  repairRequired: boolean;
  courtAction: boolean;
};

export type OosOrder = {
  orderRef: string;
  scope: OosScope;
  /** The unit, trailer, driver or load this prohibits. */
  subjectRef: string;
  issuedAt: Date;
  issuingAgency: string | null;
  /** What the order itself says must happen before the prohibition lifts. */
  releaseCondition: string;
  /** Set only by a release review, never by a repair. */
  releasedAt: Date | null;
  releasedByUserId: number | null;
  releaseEvidenceRef: string | null;
  /** A recorded order that turned out not to apply. Rescinded, never deleted. */
  rescindedAt: Date | null;
};

export const isActive = (o: OosOrder, at: Date): boolean =>
  !o.releasedAt && !o.rescindedAt && o.issuedAt.getTime() <= at.getTime();

/* ------------------------------------------------------------------ */
/* What a violation is allowed to cause                                 */
/* ------------------------------------------------------------------ */

export type ViolationConsequences = {
  violationRef: string;
  createsOosOrder: boolean;
  oosScope: OosScope | null;
  createsDefect: boolean;
  createsWorkOrder: boolean;
  createsCourtMatter: boolean;
  /** The one thing that is derived: a dispatch block follows an OOS, nothing else. */
  blocksDispatch: boolean;
  reasons: string[];
};

/**
 * Read the consequences off a violation. Nothing is inferred across fields:
 * a ticket with no out-of-service marking produces no prohibition, and an
 * out-of-service marking with no ticket still prohibits.
 */
export function consequencesOf(v: ViolationFacts): ViolationConsequences {
  const reasons: string[] = [];
  if (v.citationIssued && !v.outOfService) reasons.push(`${v.ownCode}: a citation was issued and the document records no out-of-service condition — this does not stop the vehicle`);
  if (v.outOfService && !v.citationIssued) reasons.push(`${v.ownCode}: placed out of service with no citation recorded`);
  if (v.outOfService && !v.oosScope) reasons.push(`${v.ownCode}: marked out of service and the document's scope was not established — treat as unknown and confirm with the inspector`);
  if (v.repairRequired && !v.defectRequired) reasons.push(`${v.ownCode}: repair required, so a defect is raised to carry it`);
  return {
    violationRef: v.violationRef,
    createsOosOrder: v.outOfService,
    oosScope: v.oosScope,
    createsDefect: v.defectRequired || v.repairRequired,
    createsWorkOrder: v.repairRequired,
    createsCourtMatter: v.courtAction,
    blocksDispatch: v.outOfService,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* What it means for dispatch                                           */
/* ------------------------------------------------------------------ */

export type SubjectAuthorization = {
  subjectRef: string;
  scope: OosScope;
  state: "permitted" | "prohibited" | "unknown";
  reasons: string[];
  activeOrderRefs: string[];
};

export type EnforcementReadiness = {
  /** Per subject, because one stop can prohibit the truck and clear the driver. */
  subjects: SubjectAuthorization[];
  verdict: "permitted" | "prohibited" | "unknown";
  blockers: { code: string; label: string; subjectRef: string; scope: OosScope }[];
  /** A driver prohibited while the unit is clear is a replaceable driver, and dispatch should be told so. */
  replaceableSubjects: OosScope[];
};

/**
 * Authorization for each subject of a stop.
 *
 * An inspection whose result is `unknown` denies authorization for the subjects
 * it covered. Nobody has established that it passed, and "we could not read the
 * document" is not a pass.
 */
export function enforcementReadiness(args: {
  subjects: readonly { subjectRef: string; scope: OosScope }[];
  orders: readonly OosOrder[];
  /** Inspections covering these subjects whose result is not yet established. */
  unresolvedInspections?: readonly { inspectionRef: string; coversSubjectRefs: readonly string[] }[];
  at: Date;
}): EnforcementReadiness {
  const subjects: SubjectAuthorization[] = args.subjects.map(s => {
    const active = args.orders.filter(o => o.subjectRef === s.subjectRef && o.scope === s.scope && isActive(o, args.at));
    if (active.length) {
      return {
        subjectRef: s.subjectRef, scope: s.scope, state: "prohibited",
        reasons: active.map(o => `${o.orderRef} — out of service since ${o.issuedAt.toISOString().slice(0, 16).replace("T", " ")}${o.issuingAgency ? ` (${o.issuingAgency})` : ""}. Release condition: ${o.releaseCondition}`),
        activeOrderRefs: active.map(o => o.orderRef),
      };
    }
    const unresolved = (args.unresolvedInspections ?? []).filter(i => i.coversSubjectRefs.includes(s.subjectRef));
    if (unresolved.length) {
      return {
        subjectRef: s.subjectRef, scope: s.scope, state: "unknown",
        reasons: unresolved.map(i => `${i.inspectionRef} — the result of this inspection is not established. Unknown is not a pass.`),
        activeOrderRefs: [],
      };
    }
    return { subjectRef: s.subjectRef, scope: s.scope, state: "permitted", reasons: ["No active out-of-service order and no unresolved inspection"], activeOrderRefs: [] };
  });

  const prohibited = subjects.filter(s => s.state === "prohibited");
  const unknown = subjects.filter(s => s.state === "unknown");
  const verdict = prohibited.length ? "prohibited" : unknown.length ? "unknown" : "permitted";

  return {
    subjects, verdict,
    blockers: prohibited.map(s => ({ code: `oos.${s.scope}`, label: s.reasons[0], subjectRef: s.subjectRef, scope: s.scope })),
    // A prohibited driver on a clear truck can be replaced; a prohibited truck cannot.
    replaceableSubjects: prohibited.filter(s => s.scope === "driver").map(s => s.scope),
  };
}

/* ------------------------------------------------------------------ */
/* Repair is not release                                                */
/* ------------------------------------------------------------------ */

export type RepairRecord = {
  workOrderRef: string;
  repairCompletedAt: Date | null;
  repairCompletedByUserId: number | null;
  functionalTestPassed: boolean;
  afterEvidenceRef: string | null;
};

export type ReleaseReadiness = {
  releasable: boolean;
  state: "not_repaired" | "repair_complete_pending_release" | "release_blocked" | "releasable" | "already_released";
  reasons: string[];
};

/**
 * Whether an order may now be released — which is a question for a release
 * review, not for the mechanic who finished the work.
 *
 * The gap between `repair_complete_pending_release` and `releasable` is the
 * point of this function. A truck whose brake chamber has been replaced is a
 * repaired truck; it becomes a permitted truck when somebody with the authority
 * to say so records that the order's own release condition is satisfied.
 */
export function releaseReadiness(args: {
  order: OosOrder;
  repairs: readonly RepairRecord[];
  /** Where the order requires it — a reinspection, a decal, an inspector's sign-off. */
  releaseConditionSatisfied: boolean | "unknown";
  at: Date;
}): ReleaseReadiness {
  if (args.order.releasedAt) return { releasable: false, state: "already_released", reasons: [`Released ${args.order.releasedAt.toISOString().slice(0, 16).replace("T", " ")}`] };

  const done = args.repairs.filter(r => r.repairCompletedAt);
  if (!done.length) return { releasable: false, state: "not_repaired", reasons: ["No completed repair is recorded against this order"] };

  const untested = done.filter(r => !r.functionalTestPassed);
  const unevidenced = done.filter(r => !r.afterEvidenceRef);
  const reasons: string[] = [];
  if (untested.length) reasons.push(`${untested.length} completed repair(s) with no passing functional test`);
  if (unevidenced.length) reasons.push(`${unevidenced.length} completed repair(s) with no after-repair evidence`);
  if (reasons.length) return { releasable: false, state: "release_blocked", reasons };

  if (args.releaseConditionSatisfied === "unknown") {
    return {
      releasable: false, state: "repair_complete_pending_release",
      reasons: [`The repair is complete and tested. The order's own release condition — "${args.order.releaseCondition}" — is not established, so the prohibition stands.`],
    };
  }
  if (args.releaseConditionSatisfied === false) {
    return { releasable: false, state: "release_blocked", reasons: [`The order's release condition is recorded as not satisfied: "${args.order.releaseCondition}"`] };
  }
  return {
    releasable: true, state: "releasable",
    reasons: [`Repair complete and tested, and the release condition "${args.order.releaseCondition}" is recorded satisfied. A release review may now lift this order.`],
  };
}

/* ------------------------------------------------------------------ */
/* What the scanner produced                                            */
/* ------------------------------------------------------------------ */

export type ExtractedField = { field: string; value: string | null; confidence: number };

export type ExtractionReview = {
  /** Always. An extraction is a proposal until the driver confirms it. */
  requiresConfirmation: true;
  extracted: number;
  /** Fields the driver is asked to look at first. */
  highlighted: ExtractedField[];
  /** Fields that must be present before this becomes an enforcement record. */
  missingRequired: string[];
  note: string;
};

/**
 * The result of scanning an enforcement document. Never an enforcement record:
 * an OCR pass that quietly set a compliance state would be the worst bug this
 * system could have.
 *
 * Inspection report numbers and citation numbers are separate fields on
 * purpose — they are separate identifiers on separate documents, and conflating
 * them makes a later challenge impossible to file.
 */
export const REQUIRED_ENFORCEMENT_FIELDS = ["agency", "jurisdiction", "occurredAt", "inspectionReportNumber"] as const;

export function reviewExtraction(fields: readonly ExtractedField[], lowConfidenceBelow = 0.85): ExtractionReview {
  const present = new Map(fields.map(f => [f.field, f]));
  const missingRequired = REQUIRED_ENFORCEMENT_FIELDS.filter(f => !present.get(f)?.value);
  const highlighted = fields.filter(f => f.value === null || f.confidence < lowConfidenceBelow);
  return {
    requiresConfirmation: true,
    extracted: fields.filter(f => f.value !== null).length,
    highlighted,
    missingRequired: [...missingRequired],
    note: "Extracted from the document and not yet confirmed. Nothing here changes a compliance state until a person reviews it.",
  };
}

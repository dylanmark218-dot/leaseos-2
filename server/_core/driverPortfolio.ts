/**
 * 0202 — Driver Portfolio and Credential Wallet: the model.
 *
 * Pure. No network, no database.
 *
 * The portfolio is not a new credential store. A driver's tickets were already
 * entering `complianceDocuments` (recorded by one person, verified by another),
 * and equipment already had `operatorEquipmentAuthorizations`. A third table of
 * "certificates" beside those would be a second answer to "does this person
 * hold H2S", and two answers are how dispatch and safety come to disagree.
 *
 * So this module reads those rows through the canonical validity rule
 * (`complianceDocumentValidity`) and adds what was missing:
 *
 *   A CATALOGUE     what H2S, First Aid, WHMIS and the rest are, which document
 *                   types satisfy each, and whether currency needs an expiry.
 *   REQUIREMENTS    a set of what a job needs, each one either mandatory or
 *                   informational. Only a mandatory requirement can produce a
 *                   blocker. A missing optional certificate never stops a truck.
 *   ONE EVALUATION  per requirement, a named state, and the blockers in B12's
 *                   own vocabulary. The composer merges them into
 *                   `evaluateDispatchReadiness()`. This module is not a second
 *                   gate and has no verdict dispatch can act on by itself.
 *   PROJECTIONS     the wallet (the driver's own, offline, with a time after
 *                   which it stops claiming READY), the dispatch view (ticks and
 *                   crosses, no HR file), the expiry dashboard, the history, and
 *                   what a one-credential share shows when it is redeemed.
 *
 * Three rules carry over unchanged: unknown is never satisfied; an expired or
 * missing mandatory credential is overridable by no one; and medical fitness is
 * not in this catalogue at all. It reaches dispatch only as "eligible", through
 * `medicalFitnessForDispatch`, and nothing here projects it.
 */

import { complianceDocumentValidity, type ComplianceDocumentRow } from "./complianceDocumentValidity";
import type { DispatchBlocker } from "./dispatchReadiness";
import { walletStatusAt, type WalletHeadline, type WalletStatus } from "../../shared/driverWallet";

/* ------------------------------------------------------------------ */
/* Catalogue                                                            */
/* ------------------------------------------------------------------ */

export type CredentialCategory = "licence" | "endorsement" | "safety_ticket" | "orientation" | "company_training";

export type CredentialType = {
  code: string;
  label: string;
  category: CredentialCategory;
  /** The `complianceDocuments.docType` values that satisfy it. The first is the one new records use. */
  docTypes: readonly string[];
  /**
   * True when currency cannot be established without a recorded expiry. A
   * verified H2S ticket with no expiry on it is `no_expiry_recorded`, which is
   * unknown, not satisfied. False for things that do not lapse by date (an air
   * brake endorsement, a completed orientation): verified is enough, and a
   * recorded expiry still governs when there is one.
   *
   * Deliberately no renewal interval. How long a ticket lasts is the
   * provider's statement on the certificate, not a number this file asserts.
   */
  expires: boolean;
  /** Shown as a card in the wallet whenever the driver holds one. */
  walletCard: boolean;
};

export const CREDENTIAL_CATALOG: readonly CredentialType[] = [
  { code: "driver_licence", label: "Driver licence", category: "licence", docTypes: ["driver_licence"], expires: true, walletCard: true },
  { code: "air_brake_endorsement", label: "Air brake endorsement", category: "endorsement", docTypes: ["air_brake_endorsement"], expires: false, walletCard: true },
  { code: "h2s_alive", label: "H2S Alive", category: "safety_ticket", docTypes: ["h2s_alive", "h2s_certificate"], expires: true, walletCard: true },
  { code: "first_aid_cpr", label: "First Aid / CPR", category: "safety_ticket", docTypes: ["first_aid_cpr", "first_aid"], expires: true, walletCard: true },
  { code: "tdg_certificate", label: "TDG", category: "safety_ticket", docTypes: ["tdg_certificate"], expires: true, walletCard: true },
  { code: "whmis", label: "WHMIS", category: "safety_ticket", docTypes: ["whmis"], expires: true, walletCard: true },
  { code: "csts", label: "CSO / CSTS", category: "safety_ticket", docTypes: ["csts", "cso"], expires: true, walletCard: true },
  { code: "ground_disturbance", label: "Ground Disturbance", category: "safety_ticket", docTypes: ["ground_disturbance"], expires: true, walletCard: true },
  { code: "confined_space", label: "Confined Space", category: "safety_ticket", docTypes: ["confined_space"], expires: true, walletCard: true },
  { code: "fall_protection", label: "Fall Protection", category: "safety_ticket", docTypes: ["fall_protection"], expires: true, walletCard: true },
  { code: "respirator_fit_test", label: "Respirator fit test", category: "safety_ticket", docTypes: ["respirator_fit_test"], expires: true, walletCard: true },
  { code: "defensive_driving", label: "Defensive driving", category: "company_training", docTypes: ["defensive_driving"], expires: false, walletCard: true },
  { code: "company_orientation", label: "Company orientation", category: "orientation", docTypes: ["company_orientation"], expires: false, walletCard: true },
];

/** Codes are compared the way academy binding codes are: case, spaces and hyphens do not matter. */
export const normalizeCode = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, "_");

const ORIENTATION = /^orientation:(client|site):([a-z0-9_.]+)$/;

/**
 * The type for a code, including the open-ended client and site orientations.
 *
 * An orientation is `orientation:client:<customer>` or `orientation:site:<site>`,
 * and the same string is its docType. There is one per customer and one per
 * site, so they cannot be enumerated here; the shape is what is fixed.
 * Anything else not in the catalogue is null, and a requirement naming it is
 * refused where it is created rather than evaluated as a guess.
 */
export function credentialType(code: string): CredentialType | null {
  const c = normalizeCode(code);
  const known = CREDENTIAL_CATALOG.find(t => t.code === c);
  if (known) return known;
  const m = ORIENTATION.exec(c);
  if (!m) return null;
  return { code: c, label: `${m[1] === "client" ? "Client" : "Site"} orientation — ${m[2]}`, category: "orientation", docTypes: [c], expires: false, walletCard: true };
}

/** The orientation code for a customer or site, as bindings and uploads should spell it. */
export const orientationCode = (scope: "client" | "site", key: string) => `orientation:${scope}:${normalizeCode(key).replace(/[^a-z0-9_.]/g, "")}`;

/* ------------------------------------------------------------------ */
/* Portfolio input                                                      */
/* ------------------------------------------------------------------ */

/** A `complianceDocuments` row owned by the operator, with the columns the wallet shows. */
export type PortfolioCredential = ComplianceDocumentRow & {
  identifier?: string | null;
  source?: string | null;
  verifiedByUserId?: number | null;
  verifiedAt?: Date | null;
  privateDetail?: boolean;
};

/** An `operatorEquipmentAuthorizations` row. */
export type EquipmentAuthorization = {
  equipmentType: string;
  status: "pending" | "authorized" | "suspended" | "revoked" | "expired";
  expiresAt: Date | null;
  authorizedAt: Date | null;
};

export type DriverPortfolio = {
  operatorId: number;
  name: string;
  /** From the operator record. The licence itself is evaluated by the base gate. */
  licenceClass: string | null;
  credentials: readonly PortfolioCredential[];
  equipment: readonly EquipmentAuthorization[];
};

/* ------------------------------------------------------------------ */
/* Requirements                                                         */
/* ------------------------------------------------------------------ */

export type RequirementKind = "credential" | "licence_class" | "equipment";
export type Enforcement = "mandatory" | "informational";
export type RequirementSource = "company" | "customer" | "site" | "job_type" | "equipment" | "job";

export type DriverRequirement = {
  kind: RequirementKind;
  /** Credential code, licence class ("1", "3"), or equipment type. */
  code: string;
  enforcement: Enforcement;
  source: RequirementSource;
  /** The binding that asked for it, so a blocker can say where it came from. */
  sourceRef: string | null;
  label?: string | null;
};

/**
 * One requirement per kind and code. Several bindings may ask for the same
 * ticket (the company and the client both want H2S); the strictest enforcement
 * wins, and every source is kept so the explanation names them all.
 */
export function consolidateRequirements(reqs: readonly DriverRequirement[]): (DriverRequirement & { sources: string[] })[] {
  const byKey = new Map<string, DriverRequirement & { sources: string[] }>();
  for (const r of reqs) {
    const code = r.kind === "licence_class" ? normalizeClass(r.code) : normalizeCode(r.code);
    const key = `${r.kind}|${code}`;
    const src = r.sourceRef ?? r.source;
    const prior = byKey.get(key);
    if (!prior) { byKey.set(key, { ...r, code, sources: [src] }); continue; }
    if (!prior.sources.includes(src)) prior.sources.push(src);
    if (r.enforcement === "mandatory") prior.enforcement = "mandatory";
    if (!prior.label && r.label) prior.label = r.label;
  }
  return Array.from(byKey.values());
}

/**
 * The facts a binding is matched against. Established by the server from the
 * job, the unit and the operator, never from the request, and never inferred
 * from free text: `site` is the job's location string compared whole.
 */
export type BindingFacts = {
  /** The organization whose work this is. NULL is the historical single tenant. */
  orgRef: string | null;
  customer: readonly string[];
  site: readonly string[];
  job_type: readonly string[];
  equipment: readonly string[];
  job: readonly string[];
};

export type RequirementBinding = {
  bindingRef: string;
  orgRef: string | null;
  subjectType: RequirementSource;
  subjectCode: string;
  requirementKind: RequirementKind;
  requirementCode: string;
  label: string | null;
  enforcement: Enforcement;
  active: boolean;
  effectiveAt: Date | null;
  expiresAt: Date | null;
};

/**
 * Whether a binding is in force and names this work. A company binding applies
 * to all of that organization's work, and to no other organization's.
 */
export function bindingApplies(b: RequirementBinding, facts: BindingFacts, at: Date): boolean {
  if ((b.orgRef ?? null) !== (facts.orgRef ?? null)) return false;
  if (!b.active) return false;
  if (b.effectiveAt && b.effectiveAt.getTime() > at.getTime()) return false;
  if (b.expiresAt && b.expiresAt.getTime() <= at.getTime()) return false;
  if (b.subjectType === "company") return true;
  return facts[b.subjectType].filter(Boolean).map(normalizeCode).includes(normalizeCode(b.subjectCode));
}

/** The requirement a binding asks for, carrying where it came from. */
export function requirementFromBinding(b: RequirementBinding): DriverRequirement {
  return {
    kind: b.requirementKind, code: b.requirementCode, enforcement: b.enforcement, source: b.subjectType, label: b.label,
    sourceRef: b.subjectType === "company" ? "company" : `${b.subjectType.replace(/_/g, " ")} ${b.subjectCode}`,
  };
}

/**
 * Refused at the point a binding is created, not discovered at dispatch: a
 * requirement for a credential the catalogue cannot name would only ever
 * evaluate as unknown.
 */
export function bindingProblem(b: Pick<RequirementBinding, "subjectType" | "subjectCode" | "requirementKind" | "requirementCode">): string | null {
  if (b.subjectType === "company" && b.subjectCode !== "*") return "A company binding applies to every job; its subject code is *";
  if (b.subjectType !== "company" && !b.subjectCode.trim()) return "Name the customer, site, job type, equipment or job this applies to";
  if (b.requirementKind === "credential" && !credentialType(b.requirementCode)) return `${b.requirementCode} is not a known credential — use a catalogue code or orientation:client:<key> / orientation:site:<key>`;
  if (b.requirementKind === "licence_class" && !/^(class\s*)?[1-6]$/i.test(b.requirementCode.trim())) return "A licence class is 1 to 6";
  if (b.requirementKind === "equipment" && !normalizeCode(b.requirementCode)) return "Name the equipment type";
  return null;
}

/* ------------------------------------------------------------------ */
/* Licence classes                                                      */
/* ------------------------------------------------------------------ */

const normalizeClass = (value: string) => value.trim().toLowerCase().replace(/^class\s*/, "");

/**
 * Alberta's operator licence classes, higher covering lower: a Class 1 holder
 * may drive what Classes 2 to 5 permit; 2 covers 3, 4 and 5; 3 and 4 each cover
 * 5. Motorcycle (6) is separate and covered by nothing here. A class string
 * that is not one of these is compared for equality only, never guessed at.
 */
const AB_CLASS_COVERS: Readonly<Record<string, readonly string[]>> = {
  "1": ["1", "2", "3", "4", "5"],
  "2": ["2", "3", "4", "5"],
  "3": ["3", "5"],
  "4": ["4", "5"],
  "5": ["5"],
  "6": ["6"],
};

export function licenceClassCovers(held: string, required: string): boolean {
  const h = normalizeClass(held), r = normalizeClass(required);
  const covers = AB_CLASS_COVERS[h];
  return covers ? covers.includes(r) : h === r;
}

/* ------------------------------------------------------------------ */
/* Expiry warnings                                                      */
/* ------------------------------------------------------------------ */

/** The driver's warnings, in days before expiry. */
export const EXPIRY_WARNING_DAYS = [90, 60, 30, 14, 7] as const;
export type WarningTier = (typeof EXPIRY_WARNING_DAYS)[number] | "expired";

/** The tightest threshold the credential has crossed, or null when it is further out than all of them. */
export function expiryWarningTier(daysRemaining: number | null): WarningTier | null {
  if (daysRemaining == null) return null;
  if (daysRemaining < 0) return "expired";
  let tier: WarningTier | null = null;
  for (const t of EXPIRY_WARNING_DAYS) if (daysRemaining <= t) tier = t;
  return tier;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                           */
/* ------------------------------------------------------------------ */

export type ItemState =
  | "satisfied"
  | "expired"
  | "expires_during_job"
  | "missing"
  | "unverified"
  | "rejected"
  | "no_expiry_recorded"
  | "class_unknown"
  | "insufficient_class"
  | "training_required"
  | "suspended"
  | "not_authorized"
  | "unknown_requirement";

export type ReadinessItem = {
  kind: RequirementKind;
  code: string;
  label: string;
  enforcement: Enforcement;
  sources: string[];
  state: ItemState;
  satisfied: boolean;
  expiresAt: Date | null;
  daysRemaining: number | null;
  warningTier: WarningTier | null;
  /** A newer upload is waiting for a second person to verify it. */
  pendingRenewal: boolean;
  /** The `complianceDocuments` row in force, when there is one. */
  credentialId: number | null;
  detail: string;
  /** What the driver or the office does about it. Null when nothing needs doing. */
  action: string | null;
};

export type DriverReadiness = {
  /** The same four words the gate uses, so nothing downstream has to translate. */
  verdict: "ready" | "review" | "unknown" | "blocked";
  items: ReadinessItem[];
  /** Mandatory items only, in B12's vocabulary, for the composer to merge. */
  blockers: DispatchBlocker[];
  /** Informational items that are not satisfied. Shown; never blocking. */
  notices: ReadinessItem[];
  evaluatedAt: Date;
};

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/** Rows of a type, presented under its code so the validity rule sees one type. */
function rowsFor(credentials: readonly PortfolioCredential[], type: CredentialType): PortfolioCredential[] {
  const accepted = new Set(type.docTypes.map(normalizeCode));
  return credentials.filter(c => accepted.has(normalizeCode(c.docType))).map(c => ({ ...c, docType: type.code }));
}

/** Which row the validity rule chose: it numbers rows by capture order, from 1. */
function rowForVersion(rows: readonly PortfolioCredential[], version: number | null): PortfolioCredential | null {
  if (version == null) return null;
  return rows.slice().sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())[version - 1] ?? null;
}

function evaluateCredential(
  req: DriverRequirement & { sources: string[] }, portfolio: DriverPortfolio, at: Date, validThrough: Date | null,
): ReadinessItem {
  const type = credentialType(req.code);
  const base = {
    kind: req.kind, code: req.code, enforcement: req.enforcement, sources: req.sources,
    expiresAt: null, daysRemaining: null, warningTier: null, pendingRenewal: false, credentialId: null,
  } as const;
  if (!type) {
    // A requirement for something the catalogue cannot name. Unknown, never satisfied.
    return { ...base, label: req.label ?? req.code, state: "unknown_requirement", satisfied: false, detail: `${req.code} is not a credential this system knows how to check`, action: "Correct the requirement" };
  }
  const label = req.label ?? type.label;
  const rows = rowsFor(portfolio.credentials, type);
  const v = complianceDocumentValidity(rows, type.code, at, EXPIRY_WARNING_DAYS[0]);
  const current = rowForVersion(rows, v.version);
  const pendingRenewal = rows.some(r => r.verificationStatus === "needs_review" && (!current || r.capturedAt.getTime() > current.capturedAt.getTime()));
  const common = { ...base, label, pendingRenewal, credentialId: current?.id ?? null, expiresAt: v.expiresAt, daysRemaining: v.daysRemaining };
  const renewalNote = pendingRenewal ? " — a renewal is uploaded and awaiting verification" : "";

  switch (v.state) {
    case "none":
      return { ...common, state: "missing", satisfied: false, detail: `${label} not on file`, action: `Upload ${label}, or assign another qualified operator` };
    case "rejected":
      return { ...common, state: "rejected", satisfied: false, detail: `${label} was reviewed and rejected`, action: `Upload a valid ${label}` };
    case "unverified":
      return { ...common, state: "unverified", satisfied: false, detail: `${label} is on file but not yet verified`, action: "Safety to verify against the certificate" };
    case "expired":
      return { ...common, state: "expired", satisfied: false, warningTier: "expired", detail: `${label} expired ${day(v.expiresAt!)}${renewalNote}`, action: pendingRenewal ? "Safety to verify the renewal" : `Renew ${label}, or assign another qualified operator` };
    default: {
      // in_force or expiring: verified and in force by the canonical rule.
      if (v.expiresAt == null) {
        if (type.expires) {
          return { ...common, state: "no_expiry_recorded", satisfied: false, detail: `${label} is verified but has no expiry recorded — currency cannot be established`, action: "Record the expiry from the certificate" };
        }
        return { ...common, state: "satisfied", satisfied: true, detail: `${label} verified`, action: null };
      }
      if (validThrough && v.expiresAt.getTime() < validThrough.getTime()) {
        return { ...common, state: "expires_during_job", satisfied: false, warningTier: expiryWarningTier(v.daysRemaining), detail: `${label} expires ${day(v.expiresAt)}, before the work ends ${day(validThrough)}${renewalNote}`, action: `Renew ${label} before the job, or assign another qualified operator` };
      }
      const tier = expiryWarningTier(v.daysRemaining);
      return { ...common, state: "satisfied", satisfied: true, warningTier: tier, detail: tier == null ? `${label} valid until ${day(v.expiresAt)}` : `${label} valid, expires in ${v.daysRemaining} day(s) (${day(v.expiresAt)})`, action: tier == null || pendingRenewal ? null : `Renew ${label} before ${day(v.expiresAt)}` };
    }
  }
}

function evaluateLicenceClass(req: DriverRequirement & { sources: string[] }, portfolio: DriverPortfolio): ReadinessItem {
  const label = req.label ?? `Class ${req.code} licence`;
  const base = {
    kind: req.kind, code: req.code, label, enforcement: req.enforcement, sources: req.sources,
    expiresAt: null, daysRemaining: null, warningTier: null, pendingRenewal: false, credentialId: null,
  } as const;
  if (!portfolio.licenceClass?.trim()) {
    return { ...base, state: "class_unknown", satisfied: false, detail: "Licence class not recorded", action: "Record the licence class from the licence" };
  }
  if (licenceClassCovers(portfolio.licenceClass, req.code)) {
    return { ...base, state: "satisfied", satisfied: true, detail: `Holds Class ${normalizeClass(portfolio.licenceClass)}`, action: null };
  }
  return { ...base, state: "insufficient_class", satisfied: false, detail: `Holds Class ${normalizeClass(portfolio.licenceClass)}; the work needs Class ${req.code}`, action: "Assign an operator with the required class" };
}

function evaluateEquipment(req: DriverRequirement & { sources: string[] }, portfolio: DriverPortfolio, at: Date): ReadinessItem {
  const label = req.label ?? `${req.code.replace(/_/g, " ")} operator`;
  const base = {
    kind: req.kind, code: req.code, label, enforcement: req.enforcement, sources: req.sources,
    pendingRenewal: false, credentialId: null,
  } as const;
  const auths = portfolio.equipment.filter(a => normalizeCode(a.equipmentType) === req.code);
  const live = auths.filter(a => a.status === "authorized" && (!a.expiresAt || a.expiresAt.getTime() > at.getTime()))
    .sort((a, b) => (b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER))[0];
  if (live) {
    const days = live.expiresAt ? daysBetween(at, live.expiresAt) : null;
    const tier = expiryWarningTier(days);
    return { ...base, expiresAt: live.expiresAt, daysRemaining: days, warningTier: tier, state: "satisfied", satisfied: true, detail: `Qualified on ${label}`, action: tier == null ? null : `Renew ${label} authorization before ${day(live.expiresAt!)}` };
  }
  const none = { ...base, expiresAt: null, daysRemaining: null, warningTier: null };
  // Worst standing first: a suspension is a decision about this person, a pending one is training to finish.
  if (auths.some(a => a.status === "suspended")) return { ...none, state: "suspended", satisfied: false, detail: `${label} authorization suspended`, action: "Assign another qualified operator" };
  if (auths.some(a => a.status === "revoked")) return { ...none, state: "not_authorized", satisfied: false, detail: `${label} authorization revoked`, action: "Assign another qualified operator" };
  const lapsed = auths.filter(a => a.status === "expired" || (a.status === "authorized" && a.expiresAt && a.expiresAt.getTime() <= at.getTime()))
    .sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
  if (lapsed) return { ...none, expiresAt: lapsed.expiresAt, warningTier: "expired", state: "expired", satisfied: false, detail: `${label} authorization expired${lapsed.expiresAt ? ` ${day(lapsed.expiresAt)}` : ""}`, action: "Re-authorize, or assign another qualified operator" };
  if (auths.some(a => a.status === "pending")) return { ...none, state: "training_required", satisfied: false, detail: `${label}: training or competency sign-off not complete`, action: "Complete the authorization, or assign another qualified operator" };
  return { ...none, state: "not_authorized", satisfied: false, detail: `Not authorized on ${label}`, action: "Assign another qualified operator" };
}

/** What a mandatory item that is not satisfied does to dispatch. Informational items do nothing to it. */
function blockerFor(item: ReadinessItem): DispatchBlocker | null {
  if (item.enforcement !== "mandatory" || item.satisfied) return null;
  // The code is the requirement's own and never derived from the label, so an override or a report
  // keyed to it survives somebody rewording the label.
  const code = `driver_${item.kind}_${item.code}_${item.state}`.replace(/[^a-z0-9_]+/g, "_").slice(0, 80);
  const from = item.sources.length ? ` (required by ${item.sources.join(", ")})` : "";
  const label = `${item.detail}${from}`;
  switch (item.state) {
    case "unverified":
    case "no_expiry_recorded":
    case "class_unknown":
    case "unknown_requirement":
      // Unknown, not blocking: the fact may be fine and nobody has established it. A manager may
      // override with a reason, which is the same authority the base gate gives an unknown expiry.
      return { code, label, severity: "unknown", subject: "operator", overridable: true, overrideAuthority: "manager" };
    default:
      // Missing, rejected, expired, expiring mid-job, the wrong class, not authorized on the equipment:
      // the condition has to be fixed or the operator changed. No role overrides it.
      return { code, label, severity: "blocking", subject: "operator", overridable: false };
  }
}

export function evaluateDriverReadiness(args: {
  portfolio: DriverPortfolio;
  requirements: readonly DriverRequirement[];
  at: Date;
  /** When the work ends. A mandatory ticket that lapses before then does not cover the job. */
  validThrough?: Date | null;
}): DriverReadiness {
  const items = consolidateRequirements(args.requirements).map(r =>
    r.kind === "credential" ? evaluateCredential(r, args.portfolio, args.at, args.validThrough ?? null)
      : r.kind === "licence_class" ? evaluateLicenceClass(r, args.portfolio)
      : evaluateEquipment(r, args.portfolio, args.at));
  const blockers = items.map(blockerFor).filter((b): b is DispatchBlocker => b !== null);
  const verdict: DriverReadiness["verdict"] = blockers.some(b => b.severity === "blocking") ? "blocked"
    : blockers.some(b => b.severity === "unknown") ? "unknown"
    : blockers.length ? "review" : "ready";
  return {
    verdict, items, blockers,
    notices: items.filter(i => i.enforcement === "informational" && !i.satisfied),
    evaluatedAt: args.at,
  };
}

/* ------------------------------------------------------------------ */
/* Projections                                                          */
/* ------------------------------------------------------------------ */

export type WalletCard = {
  /** What kind of requirement this card is, and its stable code: the requirement's identity. */
  kind: RequirementKind;
  code: string;
  label: string;
  category: CredentialCategory | "equipment";
  state: ItemState;
  satisfied: boolean;
  /** Whether the company baseline requires it. A card the driver simply holds is `optional`. */
  required: Enforcement | "optional";
  expiresAt: Date | null;
  daysRemaining: number | null;
  warningTier: WarningTier | null;
  verification: "verified" | "awaiting_verification" | "rejected" | "none";
  credentialId: number | null;
  /** The certificate number. The driver's own view; never in the dispatch view. */
  identifier: string | null;
  /** Why it is not satisfied, when it is not. */
  reason: string | null;
  action: string | null;
};

export type Wallet = {
  operatorId: number;
  headline: WalletHeadline;
  /** Against the company baseline. A particular job may need more; the dispatch check is where that is decided. */
  scope: "company_baseline";
  verdict: DriverReadiness["verdict"];
  cards: WalletCard[];
  generatedAt: Date;
  /**
   * The wallet works offline, so it has to say how long its answer is good for.
   * The earlier of the offline allowance and the first expiry of a required
   * credential that is currently satisfied: a phone that has not reconnected
   * cannot keep saying READY past the moment a ticket lapses.
   */
  validUntil: Date;
  /** What set `validUntil`: the offline allowance, or a required credential's expiry (named). */
  freshness: {
    offlineAllowanceHours: number;
    limitedBy: "offline_allowance" | "credential_expiry";
    limitingCredential: { kind: RequirementKind; code: string; label: string; expiresAt: Date } | null;
  };
};

export const WALLET_OFFLINE_HOURS = 24;

const verificationOf = (item: ReadinessItem): WalletCard["verification"] =>
  item.state === "missing" ? "none"
    : item.state === "rejected" ? "rejected"
    : item.state === "unverified" ? "awaiting_verification"
    : item.kind === "credential" ? "verified"
    : "none";

export function walletView(args: {
  portfolio: DriverPortfolio;
  /** The requirements that apply to every job this driver does. */
  baseline: readonly DriverRequirement[];
  at: Date;
  offlineHours?: number;
}): Wallet {
  const { portfolio, at } = args;
  const baseline = evaluateDriverReadiness({ portfolio, requirements: args.baseline, at });
  const required = new Map(baseline.items.map(i => [`${i.kind}|${i.code}`, i]));

  // Everything the driver holds, as optional cards, so a ticket nobody requires still shows.
  const heldCodes = new Set<string>();
  for (const c of portfolio.credentials) {
    const code = normalizeCode(c.docType);
    const type = CREDENTIAL_CATALOG.find(t => t.docTypes.map(normalizeCode).includes(code)) ?? credentialType(code);
    if (type?.walletCard) heldCodes.add(type.code);
  }
  const held = evaluateDriverReadiness({
    portfolio, at,
    requirements: [
      ...Array.from(heldCodes).filter(code => !required.has(`credential|${code}`)).map(code => ({ kind: "credential" as const, code, enforcement: "informational" as const, source: "company" as const, sourceRef: null })),
      ...Array.from(new Set(portfolio.equipment.map(e => normalizeCode(e.equipmentType)))).filter(code => !required.has(`equipment|${code}`)).map(code => ({ kind: "equipment" as const, code, enforcement: "informational" as const, source: "company" as const, sourceRef: null })),
    ],
  });

  const identifierOf = (id: number | null) => (id == null ? null : portfolio.credentials.find(c => c.id === id)?.identifier ?? null);
  const card = (i: ReadinessItem, requiredAs: WalletCard["required"]): WalletCard => ({
    kind: i.kind, code: i.code, label: i.label,
    category: i.kind === "equipment" ? "equipment" : i.kind === "licence_class" ? "licence" : credentialType(i.code)?.category ?? "company_training",
    state: i.state, satisfied: i.satisfied, required: requiredAs,
    expiresAt: i.expiresAt, daysRemaining: i.daysRemaining, warningTier: i.warningTier,
    verification: verificationOf(i),
    credentialId: i.credentialId, identifier: identifierOf(i.credentialId),
    reason: i.satisfied ? null : i.detail, action: i.action,
  });
  const REQUIRED_ORDER: Record<WalletCard["required"], number> = { mandatory: 0, informational: 1, optional: 2 };
  const CATEGORY_ORDER: Record<WalletCard["category"], number> = { licence: 0, endorsement: 1, safety_ticket: 2, orientation: 3, company_training: 4, equipment: 5 };
  const cards = [
    ...baseline.items.map(i => card(i, i.enforcement)),
    ...held.items.map(i => card(i, "optional")),
  ].sort((a, b) =>
    // What stops work first: unsatisfied before satisfied, and among those, mandatory before informational before optional.
    Number(a.satisfied) - Number(b.satisfied) || REQUIRED_ORDER[a.required] - REQUIRED_ORDER[b.required]
    || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.label.localeCompare(b.label));

  const offlineHours = args.offlineHours ?? WALLET_OFFLINE_HOURS;
  const offline = new Date(at.getTime() + offlineHours * 3_600_000);
  const firstLapse = baseline.items
    .filter(i => i.enforcement === "mandatory" && i.satisfied && i.expiresAt && i.expiresAt.getTime() > at.getTime())
    .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())[0];
  const limitedByCredential = firstLapse != null && firstLapse.expiresAt!.getTime() < offline.getTime();
  const validUntil = limitedByCredential ? firstLapse.expiresAt! : offline;

  return {
    operatorId: portfolio.operatorId,
    headline: baseline.verdict === "blocked" ? "NOT READY" : baseline.verdict === "ready" ? "READY FOR WORK" : "ACTION REQUIRED",
    scope: "company_baseline",
    verdict: baseline.verdict,
    cards, generatedAt: at, validUntil,
    freshness: {
      offlineAllowanceHours: offlineHours,
      limitedBy: limitedByCredential ? "credential_expiry" : "offline_allowance",
      limitingCredential: limitedByCredential ? { kind: firstLapse.kind, code: firstLapse.code, label: firstLapse.label, expiresAt: firstLapse.expiresAt! } : null,
    },
  };
}

/**
 * What a cached wallet may say now: the shared rule the phone runs too. Past
 * `validUntil` a READY becomes STALE, because the answer was only ever good
 * until then and nobody has confirmed it since.
 */
export function walletHeadlineAt(wallet: Pick<Wallet, "headline" | "validUntil">, at: Date): WalletStatus {
  return walletStatusAt(wallet, at);
}

/**
 * What dispatch sees: a tick or a cross per requirement and why. No
 * certificate numbers, no providers, no documents, no HR file. The expiry date
 * appears only where it is the reason (lapsed, lapsing, or lapsing mid-job).
 */
export type DispatchLine = { label: string; ok: boolean; mandatory: boolean; state: ItemState; reason: string | null; expiresOn: string | null };

export function dispatchView(readiness: DriverReadiness): { verdict: DriverReadiness["verdict"]; lines: DispatchLine[] } {
  return {
    verdict: readiness.verdict,
    lines: readiness.items.map(i => ({
      label: i.label,
      ok: i.satisfied,
      mandatory: i.enforcement === "mandatory",
      state: i.state,
      reason: i.satisfied ? null : i.detail,
      expiresOn: i.expiresAt && (!i.satisfied || i.warningTier != null) ? day(i.expiresAt) : null,
    })),
  };
}

/** One row of the company-wide expiration dashboard. */
export type ExpiryAlert = {
  operatorId: number;
  name: string;
  code: string;
  label: string;
  expiresAt: Date;
  daysRemaining: number;
  tier: WarningTier;
  pendingRenewal: boolean;
  /**
   * `verified`: the credential in force is lapsing. `unverified`: nothing of this
   * type is verified, and the upload awaiting review is itself lapsing, so
   * verifying it will not help for long.
   */
  verification: "verified" | "unverified";
  /** The row the alert is about. */
  credentialId: number | null;
};

/**
 * Every current credential across the fleet that has lapsed or is within the
 * warning window, soonest first. Current, by the canonical rule: an expired
 * ticket already replaced by a verified renewal is history, not an alert.
 */
export function expiryAlerts(portfolios: readonly DriverPortfolio[], at: Date): ExpiryAlert[] {
  const out: ExpiryAlert[] = [];
  for (const p of portfolios) {
    const codes = new Set<string>();
    for (const c of p.credentials) {
      const code = normalizeCode(c.docType);
      const type = CREDENTIAL_CATALOG.find(t => t.docTypes.map(normalizeCode).includes(code)) ?? credentialType(code);
      if (type) codes.add(type.code);
    }
    const r = evaluateDriverReadiness({
      portfolio: p, at,
      requirements: [
        ...Array.from(codes).map(code => ({ kind: "credential" as const, code, enforcement: "informational" as const, source: "company" as const, sourceRef: null })),
        ...Array.from(new Set(p.equipment.map(e => normalizeCode(e.equipmentType)))).map(code => ({ kind: "equipment" as const, code, enforcement: "informational" as const, source: "company" as const, sourceRef: null })),
      ],
    });
    for (const i of r.items) {
      if (i.state === "unverified" && i.kind === "credential") {
        const type = credentialType(i.code)!;
        const newest = rowsFor(p.credentials, type).filter(c => c.verificationStatus === "needs_review" && c.expiresAt)
          .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0];
        const tier = newest ? expiryWarningTier(daysBetween(at, newest.expiresAt!)) : null;
        if (newest && tier != null) out.push({ operatorId: p.operatorId, name: p.name, code: i.code, label: i.label, expiresAt: newest.expiresAt!, daysRemaining: daysBetween(at, newest.expiresAt!), tier, pendingRenewal: false, verification: "unverified", credentialId: newest.id });
        continue;
      }
      if (!i.expiresAt || i.warningTier == null) continue;
      out.push({ operatorId: p.operatorId, name: p.name, code: i.code, label: i.label, expiresAt: i.expiresAt, daysRemaining: daysBetween(at, i.expiresAt), tier: i.warningTier, pendingRenewal: i.pendingRenewal, verification: "verified", credentialId: i.credentialId });
    }
  }
  return out.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.name.localeCompare(b.name));
}

/**
 * A credential's whole record: the one in force, and everything before it.
 * Nothing is removed when a ticket expires or is replaced; it moves here, with
 * the reason it is no longer current, because an audit asks what was held on
 * the day of the incident and not only what is held today.
 */
export type HistoryReason = "superseded" | "expired" | "rejected" | "awaiting_verification";

export function credentialHistory(credentials: readonly PortfolioCredential[], code: string, at: Date): {
  current: PortfolioCredential | null;
  history: { credential: PortfolioCredential; reason: HistoryReason }[];
} {
  const type = credentialType(code);
  if (!type) return { current: null, history: [] };
  const rows = rowsFor(credentials, type);
  const v = complianceDocumentValidity(rows, type.code, at);
  const chosen = rowForVersion(rows, v.version);
  const inForce = chosen && chosen.verificationStatus === "verified" && v.state !== "expired" ? chosen : null;
  const original = (r: PortfolioCredential) => credentials.find(c => c.id === r.id)!;
  const history = rows
    .filter(r => r.id !== inForce?.id)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
    .map(r => ({
      credential: original(r),
      reason: (r.verificationStatus === "rejected" ? "rejected"
        : r.verificationStatus === "needs_review" ? "awaiting_verification"
        : r.expiresAt && r.expiresAt.getTime() < at.getTime() ? "expired"
        : "superseded") as HistoryReason,
    }));
  return { current: inForce ? original(inForce) : null, history };
}

/* ------------------------------------------------------------------ */
/* Sharing one credential                                               */
/* ------------------------------------------------------------------ */

/**
 * A share lets an authorized person at a gate or a site check ONE credential
 * without being given the driver's portfolio. The token itself is the
 * repository's invitation token (`newToken()`: 32 random bytes, stored only as
 * its SHA-256), held server-side with its expiry and revocation, so this module
 * decides only two things: how long a share may last, and what redeeming one
 * shows.
 */
export const SHARE_MAX_HOURS = 7 * 24;
export const SHARE_DEFAULT_HOURS = 24;

/** The lifetime a share gets: the default when none is asked for, never longer than seven days. */
export function shareLifetimeHours(requested: number | null | undefined): number {
  if (requested == null) return SHARE_DEFAULT_HOURS;
  if (!Number.isFinite(requested) || requested <= 0) throw new RangeError("A share must last a positive number of hours");
  if (requested > SHARE_MAX_HOURS) throw new RangeError(`A share may last at most ${SHARE_MAX_HOURS} hours (7 days)`);
  return requested;
}

export type SharedCredentialView = {
  holderName: string;
  label: string;
  /** `superseded` when a newer verified credential of the same type has replaced the one shared. */
  state: ItemState | "superseded";
  valid: boolean;
  expiresOn: string | null;
  verifiedOn: string | null;
  identifier: string | null;
};

/**
 * What the person scanning the QR is shown. Evaluated now, not when the share
 * was made: a ticket rejected, lapsed or replaced since then reads as what it
 * is. No document, no storage reference, no other credential. A private
 * credential, and anything outside the catalogue (medical fitness among them),
 * is never shown, whatever was shared.
 */
export function sharedCredentialView(args: {
  credentialId: number;
  code: string;
  holderName: string;
  /** Every credential the operator holds, so a replacement can be recognised. */
  credentials: readonly PortfolioCredential[];
  at: Date;
}): SharedCredentialView | null {
  const row = args.credentials.find(c => c.id === args.credentialId);
  if (!row || row.privateDetail) return null;
  const type = credentialType(args.code);
  if (!type || !type.docTypes.map(normalizeCode).includes(normalizeCode(row.docType))) return null;
  const base = {
    holderName: args.holderName, label: type.label,
    expiresOn: row.expiresAt ? day(row.expiresAt) : null,
    verifiedOn: row.verificationStatus === "verified" && row.verifiedAt ? day(row.verifiedAt) : null,
    identifier: row.identifier ?? null,
  };
  const all = rowsFor(args.credentials, type);
  const inForce = rowForVersion(all, complianceDocumentValidity(all, type.code, args.at).version);
  if (row.verificationStatus === "verified" && inForce && inForce.id !== row.id && inForce.verificationStatus === "verified") {
    return { ...base, state: "superseded", valid: false };
  }
  const r = evaluateDriverReadiness({
    portfolio: { operatorId: 0, name: args.holderName, licenceClass: null, credentials: [row], equipment: [] },
    requirements: [{ kind: "credential", code: type.code, enforcement: "mandatory", source: "company", sourceRef: null }],
    at: args.at,
  }).items[0]!;
  return { ...base, state: r.state, valid: r.satisfied };
}

/**
 * Portal composition.
 *
 * LeaseOS is not one interface with hundreds of menu items. It is one
 * operational record with several role-specific portals in front of it, and a
 * person's portal is COMPOSED from the roles they hold rather than picked from a
 * job-title dropdown. An operator who is also the crew's safety representative
 * gets the Field Workforce portal and the Safety portal — not a third,
 * hand-built "operator-safety" screen.
 *
 * Three rules:
 *
 *   Portals are windows, not data. A portal never grants a permission. The
 *   permission engine decides what a call may do; the portal only decides what
 *   is worth showing. A surface listed here for a role the user does not hold
 *   is simply absent — and if it were somehow rendered, the API behind it would
 *   still refuse.
 *
 *   Knowledge panels are attached to portals, not to people. The funding and
 *   tax-opportunity panels appear on the surfaces where they are useful — the
 *   fleet manager sees equipment financing, HR sees training grants, the worker
 *   sees their own tool-expense organizer — because "financial gain most people
 *   don't know about" only helps when it arrives in the right place.
 *
 *   Transparency is a surface too. Every worker can see what LeaseOS holds
 *   about them, why, who can reach it and how long it is kept. Trust is a
 *   product feature, and it is composed here like any other panel.
 */

import type { ActingScope } from "./actingScope";
import { AmbiguousOrganization } from "./actingScope";
import type { DomainRole, Permission } from "./recordsAuthorization";

export type PortalKey =
  | "field_workforce"
  | "field_leadership"
  | "safety_compliance"
  | "dispatch_operations"
  | "office_administration"
  | "finance_billing"
  | "fleet_maintenance"
  | "sales_customer"
  | "management"
  | "executive"
  | "hr_workforce"
  | "worker_self_service"
  | "customer"
  | "vendor_facility"
  | "auditor_regulator"
  | "incident_emergency";

export type KnowledgePanelKey =
  | "training_funding"
  | "hiring_subsidies"
  | "equipment_financing"
  | "clean_equipment_incentives"
  | "agriculture_programs"
  | "rd_innovation"
  | "tax_opportunities"
  | "grant_compliance"
  | "funding_pipeline"
  | "worker_expense_organizer"
  | "tradesperson_tools"
  | "remote_work_records"
  | "safety_improvement_funding"
  | "data_transparency";

export type PortalSurface = {
  portal: PortalKey;
  displayName: string;
  purpose: string;
  /** Roles that compose this portal into a user's session. */
  composedFrom: readonly DomainRole[];
  /**
   * Permissions the surface is *built around*. Informational — the API enforces
   * these independently. Listed so a screen can be audited against the gate.
   */
  builtAround: readonly Permission[];
  knowledgePanels: readonly KnowledgePanelKey[];
};

/**
 * The portal registry. Deliberately data, so a test can assert that every role
 * reaches at least one portal, no portal lists a role that does not exist, and
 * the knowledge panels are distributed rather than dumped everywhere.
 */
export const PORTALS: readonly PortalSurface[] = [
  {
    portal: "field_workforce",
    displayName: "Field Workforce",
    purpose: "Perform daily work — assignments, inspections, loads, tickets, evidence",
    composedFrom: ["driver"],
    builtAround: [
      "job.read", "trip.write", "load.write", "manifest.write",
      "inspection.write", "evidence.seal", "evidence.send",
      "incident.create", "roadside.open", "hos.write",
      "maintenance.write_defect", "compliance.sign", "safety.write",
      "assistant.use",
    ],
    knowledgePanels: ["training_funding", "remote_work_records"],
  },
  {
    portal: "worker_self_service",
    displayName: "My LeaseOS",
    purpose: "Personal employment, expense, training and work-history tools",
    // Every person with any role is a person. Composed from all of them.
    composedFrom: [
      "driver", "dispatcher", "mechanic", "shop_lead", "safety", "office",
      "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin",
      "tax_preparer", "controller",
    ],
    builtAround: [
      "payroll.read_own", "payroll.time.submit_own", "payroll.dispute.raise_own",
      "tax.read_personal_own", "tax.expense.create", "evidence.read_own",
    ],
    knowledgePanels: [
      "worker_expense_organizer", "tradesperson_tools",
      "remote_work_records", "training_funding", "data_transparency",
    ],
  },
  {
    portal: "field_leadership",
    displayName: "Field Leadership",
    purpose: "Coordinate people, equipment and work on location",
    // No dedicated supervisor role exists yet; leadership composes from the
    // roles that currently coordinate a crew. A `supervisor` role is a
    // forward addition and would slot in here.
    composedFrom: ["dispatcher", "safety", "management"],
    builtAround: ["job.read", "trip.read", "dispatch.read", "inspection.read", "incident.read_summary"],
    knowledgePanels: ["training_funding", "safety_improvement_funding"],
  },
  {
    portal: "safety_compliance",
    displayName: "Safety & Compliance",
    purpose: "Protect workers and maintain regulatory compliance",
    composedFrom: ["safety"],
    builtAround: [
      "incident.review", "incident.read_investigation", "compliance.review",
      "safety.write", "inspection.write", "evidence.read_safety_summary",
    ],
    knowledgePanels: ["safety_improvement_funding", "training_funding"],
  },
  {
    portal: "dispatch_operations",
    displayName: "Dispatch & Operations",
    purpose: "Control jobs, assignments, units and schedules",
    composedFrom: ["dispatcher"],
    builtAround: [
      "job.write", "dispatch.assign", "trip.write", "fleet.read",
      "personnel.read", "compliance.read", "route.read", "route.write",
    ],
    knowledgePanels: ["training_funding"],
  },
  {
    portal: "office_administration",
    displayName: "Office Administration",
    purpose: "Resolve the exception queue — records, documents, reconciliation",
    composedFrom: ["office"],
    builtAround: [
      "evidence.verify", "evidence.amend", "compliance.write",
      "gps.confirm", "assistant.review", "assistant.commit", "job.write",
    ],
    knowledgePanels: ["grant_compliance"],
  },
  {
    portal: "finance_billing",
    displayName: "Finance, Payroll & Billing",
    purpose: "Convert verified operational facts into financial records",
    composedFrom: ["bookkeeper", "payroll_admin", "controller", "tax_preparer"],
    builtAround: [
      "billing.read", "billing.write", "payroll.run", "payroll.approve",
      "tax.read_business", "tax.expense.review", "tax.year_end.read",
      "banking.reconcile",
    ],
    knowledgePanels: ["tax_opportunities", "grant_compliance", "funding_pipeline", "rd_innovation", "agriculture_programs"],
  },
  {
    portal: "fleet_maintenance",
    displayName: "Fleet & Maintenance",
    purpose: "Maintain units and equipment; release back to service",
    composedFrom: ["mechanic", "shop_lead"],
    builtAround: [
      "maintenance.read_defect", "maintenance.write_work_order",
      "maintenance.record_release", "fleet.read", "inspection.write",
      "evidence.read_maintenance",
    ],
    knowledgePanels: ["equipment_financing", "clean_equipment_incentives"],
  },
  {
    portal: "sales_customer",
    displayName: "Sales & Customer Management",
    purpose: "Customers, quotes, rate cards and opportunities",
    // No sales role exists yet. Composes from the roles that currently touch
    // rates and customers; a `sales` role is a forward addition.
    composedFrom: ["office", "management"],
    builtAround: ["billing.read", "job.read", "reference.write"],
    knowledgePanels: [],
  },
  {
    portal: "management",
    displayName: "Management",
    purpose: "Performance and exceptions, with drill-down to source records",
    composedFrom: ["management"],
    builtAround: [
      "job.read", "billing.read", "incident.read_investigation",
      "maintenance.revoke_release", "roles.grant", "legal_hold.place",
      "route.decide",
    ],
    knowledgePanels: ["funding_pipeline", "equipment_financing", "training_funding", "grant_compliance", "agriculture_programs"],
  },
  {
    portal: "executive",
    displayName: "Executive / Owner",
    purpose: "Enterprise-wide health and decision support",
    // Executive is a lens on management, not a separate role. Its distinct
    // shape is what is aggregated, not what is permitted.
    composedFrom: ["management", "controller"],
    builtAround: ["billing.read", "tax.read_business", "tax.year_end.read"],
    knowledgePanels: ["funding_pipeline", "tax_opportunities"],
  },
  {
    portal: "hr_workforce",
    displayName: "HR, Training & Workforce",
    purpose: "Workers, qualifications, training and workforce readiness",
    composedFrom: ["hr"],
    builtAround: [
      "personnel.read", "personnel.write", "payroll.read_employee",
      "payroll.profile.write", "hos.read",
    ],
    knowledgePanels: ["training_funding", "hiring_subsidies"],
  },
  {
    portal: "customer",
    displayName: "Customer",
    purpose: "Request, monitor, approve and reconcile purchased services",
    // No customer role exists in the domain model yet. External portals are
    // deliberately empty until an external-identity model with resource- and
    // date-limited grants lands — an external party must never get broader
    // access merely because they have an account.
    composedFrom: [],
    builtAround: [],
    knowledgePanels: [],
  },
  {
    portal: "vendor_facility",
    displayName: "Vendor / Facility",
    purpose: "Narrow record exchange — disposal receipt, repair invoice, subcontract",
    composedFrom: [],
    builtAround: [],
    knowledgePanels: [],
  },
  {
    portal: "auditor_regulator",
    displayName: "Auditor / Regulator",
    purpose: "Controlled read-only evidence access",
    composedFrom: ["auditor", "external_accountant", "legal"],
    builtAround: [
      "evidence.export", "evidence.read_job_operational",
      "evidence.read_safety_summary", "compliance.read", "tax.read_business",
    ],
    knowledgePanels: [],
  },
  {
    portal: "incident_emergency",
    displayName: "Incident / Emergency",
    purpose: "Coordinate emergency response and incident documentation",
    composedFrom: ["safety", "dispatcher", "management"],
    builtAround: ["incident.create", "incident.read_summary", "incident.review"],
    knowledgePanels: [],
  },
];

/* ------------------------------------------------------------------ */
/* Composition                                                          */
/* ------------------------------------------------------------------ */

export type ComposedSession = {
  roles: DomainRole[];
  portals: PortalSurface[];
  /** Union of panels across the composed portals, deduplicated. */
  knowledgePanels: KnowledgePanelKey[];
  /**
   * Portals that exist but this session does not reach. Listed so a screen can
   * explain absence ("you don't hold a role that opens Safety") rather than
   * leaving a gap.
   */
  notReached: PortalKey[];
};

/**
 * Compose a session from the roles a person holds. Purely additive — holding a
 * second role never removes a portal the first one opened.
 */
export function composeSession(roles: readonly DomainRole[]): ComposedSession {
  const held = new Set(roles);
  const portals = PORTALS.filter(p => p.composedFrom.some(r => held.has(r)));
  const panels = new Set<KnowledgePanelKey>();
  for (const p of portals) for (const k of p.knowledgePanels) panels.add(k);

  return {
    roles: Array.from(held),
    portals,
    knowledgePanels: Array.from(panels).sort(),
    notReached: PORTALS.filter(p => !portals.includes(p)).map(p => p.portal),
  };
}

/**
 * Which organization a session is acting for, as a state rather than an outcome.
 *
 * `resolveActingScope` throws `AmbiguousOrganization` for a user with two live
 * memberships, and it is right to: its header explains that "picking one would
 * silently decide which company a request writes into." But a thrown query
 * reaches a screen as a fault, indistinguishable from a server that fell over,
 * so the screen renders an error where it should render a decision. This turns
 * that one refusal into a value and leaves every other error alone.
 *
 * `defaultWorkspace` travels with it, and travels **unvalidated**. It is a
 * `varchar(60)` that nothing checks on write, so it is a preference and never a
 * grant: `resolveSessionContext` (workspaceAccess.ts) checks it against the
 * workspaces the session actually holds, and a stale or hostile value opens nothing.
 *
 * Nothing here names a portal or a permission. The moment this carries either,
 * it has started deciding access, and access is the permission engine's.
 */
export type OrganizationState =
  | {
      state: "resolved";
      orgRef: string;
      membershipRef: string;
      /** Unvalidated. A preference, checked against held portals at use. */
      defaultWorkspace: string | null;
    }
  | { state: "single_tenant_fallback"; defaultWorkspace: string | null }
  | { state: "ambiguous"; detail: string }
  /**
   * The question could not be asked — no database is configured. Distinct from
   * `single_tenant_fallback`, which is a real answer meaning "this deployment
   * has no organizations yet". Reporting the fallback here would claim a
   * tenancy answer nothing established, which is the "missing is not the same
   * as none" collapse the rest of this system refuses to make.
   */
  | { state: "unresolved"; reason: string };

export function organizationStateFrom(
  args:
    | { scope: ActingScope; defaultWorkspace: string | null }
    | { error: unknown }
    | { unresolved: string }
): OrganizationState {
  if ("unresolved" in args) {
    return { state: "unresolved", reason: args.unresolved };
  }
  if ("error" in args) {
    // Only the ambiguity is a decision. Anything else is a fault and stays one.
    if (args.error instanceof AmbiguousOrganization) {
      return { state: "ambiguous", detail: args.error.message };
    }
    throw args.error;
  }

  const { scope, defaultWorkspace } = args;
  if (scope.derivedFrom === "membership" && scope.membershipRef) {
    return {
      state: "resolved",
      orgRef: scope.tenantId,
      membershipRef: scope.membershipRef,
      defaultWorkspace,
    };
  }
  return { state: "single_tenant_fallback", defaultWorkspace };
}

export function portalsForRole(role: DomainRole): PortalKey[] {
  return PORTALS.filter(p => p.composedFrom.includes(role)).map(p => p.portal);
}

/* ------------------------------------------------------------------ */
/* Knowledge panel distribution                                          */
/* ------------------------------------------------------------------ */

export type KnowledgePanel = {
  key: KnowledgePanelKey;
  title: string;
  /** What the panel is for, in the words a reader of that portal would use. */
  purpose: string;
  /** Which funding-program categories feed it. Empty means not funding-fed. */
  programCategories: readonly string[];
  /** Panels about a person's own records are private to that person. */
  personal: boolean;
};

export const KNOWLEDGE_PANELS: readonly KnowledgePanel[] = [
  { key: "training_funding", title: "Training funding", purpose: "Programs that may help pay for training already planned", programCategories: ["training", "workforce"], personal: false },
  { key: "hiring_subsidies", title: "Hiring subsidies", purpose: "Wage and hiring programs that may apply to a new hire", programCategories: ["wage_subsidy", "workforce"], personal: false },
  { key: "equipment_financing", title: "Finance my purchase", purpose: "Financing and cost-share programs for a planned asset purchase", programCategories: ["financing", "equipment"], personal: false },
  { key: "clean_equipment_incentives", title: "Clean equipment incentives", purpose: "Tax credits and programs for qualifying clean-technology property", programCategories: ["clean_technology"], personal: false },
  { key: "agriculture_programs", title: "Agriculture funding", purpose: "Agricultural program family, opened and closed per intake", programCategories: ["agriculture"], personal: false },
  { key: "rd_innovation", title: "R&D and innovation", purpose: "Research and innovation incentives, with the evidence ledger behind them", programCategories: ["rd_innovation"], personal: false },
  { key: "tax_opportunities", title: "Tax Opportunity Centre", purpose: "Potentially relevant tax treatments for accountant review — never a return", programCategories: ["tax"], personal: false },
  { key: "grant_compliance", title: "Grant compliance", purpose: "Approved funding, its conditions, evidence binders and reporting deadlines", programCategories: [], personal: false },
  { key: "funding_pipeline", title: "Financial opportunity pipeline", purpose: "Identified → applied → approved → received, each labelled for what it is", programCategories: [], personal: false },
  { key: "worker_expense_organizer", title: "My work expense organizer", purpose: "Work-related purchases and receipts, organized for year-end", programCategories: [], personal: true },
  { key: "tradesperson_tools", title: "My tools", purpose: "Tool purchases and receipts, with the employer certification that may be needed", programCategories: [], personal: true },
  { key: "remote_work_records", title: "My remote work", purpose: "Rotations, nights away and allowances — evidence, not a residency determination", programCategories: [], personal: true },
  { key: "safety_improvement_funding", title: "Safety improvement funding", purpose: "Programs that may fund equipment, training or corrective actions", programCategories: ["safety", "training"], personal: false },
  { key: "data_transparency", title: "What LeaseOS knows about me", purpose: "Categories held, why, who can reach them, how long they are kept", programCategories: [], personal: true },
];

export function panelsForPortal(portal: PortalKey): KnowledgePanel[] {
  const surface = PORTALS.find(p => p.portal === portal);
  if (!surface) return [];
  return KNOWLEDGE_PANELS.filter(k => surface.knowledgePanels.includes(k.key));
}

/* ------------------------------------------------------------------ */
/* Transparency                                                          */
/* ------------------------------------------------------------------ */

export type DataCategory = {
  category: string;
  whyCollected: string;
  /** Roles able to reach it. Derived from the permission model, not asserted. */
  reachableByRoles: readonly DomainRole[];
  retentionBasis: "company_policy" | "statutory_unverified" | "legal_hold";
  accessIsLogged: boolean;
};

/**
 * "What LeaseOS knows about me."
 *
 * The categories below are the ones the schema actually holds about a worker.
 * `reachableByRoles` is written from the permission model rather than from
 * what we would like to be true, and a test cross-checks it. Retention is
 * labelled `statutory_unverified` where no verified statutory period has been
 * loaded — the same honesty as the retention engine itself.
 */
export const WORKER_DATA_CATEGORIES: readonly DataCategory[] = [
  {
    category: "Position and trips (GPS breadcrumbs, zone events)",
    whyCollected: "Job arrival and departure evidence; billing and payroll time",
    reachableByRoles: ["driver", "dispatcher", "safety", "office", "management", "legal", "auditor"],
    retentionBasis: "company_policy",
    accessIsLogged: false,
  },
  {
    category: "Duty status and hours of service",
    whyCollected: "Compliance and payroll reconciliation",
    reachableByRoles: ["driver", "dispatcher", "safety", "office", "management", "hr", "legal", "auditor"],
    retentionBasis: "statutory_unverified",
    accessIsLogged: false,
  },
  {
    category: "Pay, rates and earnings",
    whyCollected: "Payroll",
    reachableByRoles: ["hr", "payroll_admin", "controller"],
    retentionBasis: "statutory_unverified",
    accessIsLogged: true,
  },
  {
    category: "Incident statements and investigations",
    whyCollected: "Safety, legal and workers' welfare",
    reachableByRoles: ["safety", "management", "hr", "legal"],
    retentionBasis: "legal_hold",
    accessIsLogged: true,
  },
  {
    category: "Personal tax documents",
    whyCollected: "Your own year-end organizer — never employer-visible unless you share",
    reachableByRoles: [],
    retentionBasis: "company_policy",
    accessIsLogged: true,
  },
  {
    category: "Field evidence you sealed (tickets, photos, logs)",
    whyCollected: "Chain of custody, billing, audit",
    reachableByRoles: ["driver", "dispatcher", "safety", "office", "management", "auditor", "legal"],
    retentionBasis: "company_policy",
    accessIsLogged: true,
  },
];

/**
 * P5.3 — the real axe WCAG A/AA rules against our real components, at three widths.
 * See axeHarness.ts for what a renderer-free environment can and cannot decide.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NEEDS_A_RENDERER, VIEWPORTS, describeRun, runAxe, setViewport } from "./axeHarness";
import { DisposalFinderView, type DisposalFinderViewProps } from "../pages/DisposalFinderView";
import { CommercialOfficeView, type CommercialOfficeViewProps } from "../pages/CommercialOfficeView";
import { DispatchReadinessView, type DispatchReadinessViewProps } from "../dispatch/DispatchReadinessView";
import { DispatchJobDetailView, type DispatchJobDetailViewProps } from "../dispatch/DispatchJobDetailView";
import { FleetListView, type FleetListRow } from "../fleet/FleetListView";
import { FleetAssetDetailView, type Actions as FleetActions, type AssetDetail } from "../fleet/FleetAssetDetailView";
import { SourcedPanel } from "../showcase/SourcedPanel";
import { WidgetBoard } from "../widgets/WidgetBoard";
import { WidgetTileShell } from "../widgets/WidgetTileShell";
import { AddWidgetPicker } from "../widgets/AddWidgetPicker";
import { blocked, ok, unknown, type Provenance } from "../../../server/_core/widgetPayload";
import type { BoardTileView } from "../widgets/WidgetBoard";
import { listOfferable } from "../../../server/_core/widgetService";
import type { RoleActor } from "../../../server/_core/roleActor";
import { demonstration, fromQuery } from "../showcase/panelSource";
import { SignInView } from "../session/SignInView";
import { WorkspaceChooserView } from "../session/WorkspaceChooserView";
import { AccessDeniedView } from "../session/AccessDeniedView";
import { PeopleAccessView, type PeopleAccessViewProps } from "../people/PeopleAccessView";
import { CustomersView, type CustomerProfile, type CustomersViewProps } from "../pages/CustomersView";
import { ContractView, type ContractDetail, type ContractViewProps } from "../pages/ContractView";
import { RateSheetView, type RateSheetDetail, type RateSheetViewProps } from "../pages/RateSheetView";
import { BoardPanelView, type BoardPanelViewProps } from "../portal/panels/BoardPanelView";
import { presentOpenWork } from "../portal/boardModel";

/** 0205/0206 — the Board, read in a cab: conversations with a queued message, and an open-work card. */
function board(o: Partial<BoardPanelViewProps> = {}): BoardPanelViewProps {
  const at = new Date("2026-10-20T14:00:00Z");
  const channels = [{ channelRef: "CH-D", type: "dispatch", name: "Dispatch — North", unacknowledged: 0 }, { channelRef: "CH-S", type: "safety", name: "Safety", unacknowledged: 1 }];
  return {
    online: false, durableQueue: false, tab: "dispatch", onTab: () => {},
    channels: { kind: "loaded", value: channels }, visibleChannels: channels.slice(0, 1), selectedChannel: "CH-D", onSelectChannel: () => {},
    messages: { kind: "loaded", value: [{ messageRef: "MSG-1", authorLabel: "User 7", mine: false, priority: "urgent", body: "Road closed at KM 42", deviceCreatedAt: at, serverReceivedAt: at, requiresAcknowledgement: true, acknowledgedByMe: false, pendingAcknowledgement: null }] },
    pendingMessages: [{ localId: "L-1", body: "Leaving the lease now", state: "queued", lastError: null, capturedAt: at }],
    onSend: () => {}, onAcknowledge: () => {},
    work: { kind: "loaded", value: [{ postRef: "OS-1", title: "Hydrovac operator", requiredRole: "driver", startsAt: new Date("2026-10-21T06:00:00Z"), place: "Hinton area", overtime: true, myResponse: "interested" }] },
    selectedPost: null, onSelectPost: () => {}, card: { kind: "none" }, myResponse: null, pendingResponse: null, onRespond: () => {},
    offerAnswer: { kind: "idle" }, onAnswerOffer: () => {}, queueSummary: { waiting: 1, refused: 0 }, onRetry: () => {},
    ...o,
  };
}
const boardCard = presentOpenWork(
  { postRef: "OS-1", title: "Hydrovac operator", status: "open", requiredRole: "driver", requiredQualifications: ["H2S", "First Aid"], requiredEquipmentClass: "hydrovac",
    location: "Hinton area", regionCode: "HINTON", startsAt: new Date("2026-10-21T06:00:00Z"), endsAt: new Date("2026-10-21T18:00:00Z"), estimatedHours: 12, overtime: true, priority: "callout" },
  { verdict: "unknown", reasons: [{ code: "qualification_unknown", detail: "No First Aid on record — unknown is not satisfied" }], availability: "available", interestExpressed: true, readinessNotEvaluated: ["route restrictions"] },
  { offerRef: "OFF-1", status: "offered", expiresAt: null },
);

afterEach(cleanup);

const finder = (): DisposalFinderViewProps => ({
  lsd: "07-18-053-18 W5M", onLsdChange: () => {}, wasteCode: "", onWasteCodeChange: () => {}, wasteCodes: ["produced_water"], onFind: () => {}, finding: false,
  result: { outcome: "located", origin: { latitude: 53.5, longitude: -116.6, basis: "theoretical", descriptor: "07-18-053-18 W5M", note: "theoretical centroid" }, facilities: [{ facilityKey: "a", name: "Edson TRD", municipality: "Edson", province: "AB", facilityType: "trd", distanceKm: 1.4, coordinatePrecision: "approximate_site", routable: false, phone: "780-723-1912", dispatchPhone: null, afterHoursPhone: null, websiteUrl: null, commercialAccess: "commercial_preapproval_required", lifecycle: "operating", legalLocation: "07-18-053-18 W5M" }], note: "call ahead" },
  selectedKey: "a", onSelect: () => {},
  view: { facility: { name: "Edson TRD", coordinatePrecision: "approximate_site", routable: false, commercialAccess: "commercial_preapproval_required", lifecycle: "operating", legalLocation: "07-18-053-18 W5M", physicalAddress: null, regulatorRef: "WM 078", preapprovalRequired: null, manifestRequired: null, normAccepted: null, sourAccepted: null, twentyFourHourCallout: null }, contact: { phone: "780-723-1912", dispatchPhone: null, afterHoursPhone: null, email: null, websiteUrl: null, gateInstructions: null }, links: { call: "tel:7807231912", googleDirections: null, appleDirections: null, website: null }, warnings: ["Coordinates are not a verified entrance"], hoursToday: { state: "unknown", note: "No hours on file" }, currentWait: { state: "unknown", note: "No wait report" }, callAhead: { state: "none_valid", note: "No valid call-ahead" }, accepts: [] },
  viewLoading: false, onCallAhead: () => {}, callAheadBusy: false, onWaitReport: () => {}, waitBusy: false,
});

const office = (tab: CommercialOfficeViewProps["tab"]): CommercialOfficeViewProps => ({
  tab, onTab: () => {}, orgQuery: "", onOrgQuery: () => {},
  organizations: [{ orgRef: "ORG-1", name: "Fixture Energy", status: "active", roles: [{ roleKey: "client", commercialNumber: "CLI-000001" }] }],
  roleTypes: [{ roleKey: "client", label: "Client" }], onCreateOrganization: () => {}, creating: false, onAssignRole: () => {},
  candidateType: "vendor", onCandidateType: () => {}, candidates: [{ recordType: "vendor", recordId: 7, capturedName: "Big Iron", orgRef: "ORG-2", organizationName: "Big Iron", evidence: "exact_name_match", applied: false }], unlinkedCount: 1, onLink: () => {},
  docFilter: { documentType: "", recordType: "", recordRef: "", includeSuperseded: false }, onDocFilter: () => {},
  documents: [{ documentRef: "DOC-1", documentType: "invoice", title: "Invoice", version: 1, status: "current", contentHash: "a".repeat(64), counterpartyOrgRef: null, issuedAt: null, retentionClass: null }],
  selectedDoc: null, onSelectDoc: () => {},
  statements: [{ statementRef: "FST-1", facilityOrgRef: "ORG-9", periodStart: "2026-08-01", periodEnd: "2026-08-31", lineCount: 3, matchedCount: 1, varianceCount: 1, unmatchedCount: 0, ambiguousCount: 1, status: "open", openLines: 2 }],
  selectedStatement: "FST-1", onSelectStatement: () => {},
  lines: [{ lineNo: 2, facilityTicketNumber: null, matchOutcome: "ambiguous", resolution: null, variances: null, candidateTicketIds: [11, 12], quantity: 8, amountCents: 120000 }],
  onResolveLine: () => {}, resolving: false,
  entityId: "7", onEntityId: () => {}, period: { from: "2026-09-01", to: "2026-09-30" }, onPeriod: () => {},
  arAging: { organizations: [{ orgRef: "ORG-1", label: "Fixture Energy", buckets: {}, totalOutstandingCents: 350000 }], unlinked: [] },
  apAging: { organizations: [], unlinked: [] },
  glReadiness: { state: "BLOCKED", blockers: [{ reason: "revenue:disposal has no GL account" }] },
  profitability: { dimension: "job", derivable: "yes", rows: [{ key: "JOB-1", label: "JOB-1", marginCents: 120000 }] },
  profitDimension: "job", onProfitDimension: () => {},
});

/**
 * The dispatcher's readiness panel. Two states, because a blocked panel and a failed one are
 * different screens: the blocked one is a list of reasons, the failed one is an alert with a
 * retry and no verdict at all.
 */
const readinessPanel = (
  state: DispatchReadinessViewProps["state"],
  capabilities: DispatchReadinessViewProps["capabilities"] = null,
  capabilityVerdict: DispatchReadinessViewProps["capabilityVerdict"] = null,
): DispatchReadinessViewProps => ({
  jobId: 41, subject: { operatorId: 7, unitId: 12, trailerId: null }, state,
  capabilities, capabilityVerdict, onRefresh: () => {}, refreshing: false,
});
/** The P8.1 picture as the server sends it, with all five states on one screen. */
const readinessCapabilities: DispatchReadinessViewProps["capabilities"] = [
  { capability: "mechanic release", status: "BLOCKED", detail: "Open critical defect on this unit" },
  { capability: "unit inspection", status: "PASS" },
  { capability: "operator qualification", status: "REVIEW", detail: "Medical review due in 9 days" },
  { capability: "enforcement orders", status: "UNKNOWN", detail: "Inspection result not established" },
  { capability: "route restrictions", status: "NOT_EVALUATED", reason: "not_applicable" },
];
const readinessBlocked: DispatchReadinessViewProps["state"] = {
  kind: "loaded",
  result: {
    verdict: "blocked",
    explanation: "Two conditions must be corrected before this unit can be dispatched.",
    blockers: [
      { code: "critical_defect", label: "Open critical defect on this unit", severity: "blocking", subject: "truck", overridable: false },
      { code: "route_unapproved", label: "Route approval outstanding", severity: "review", subject: "route", overridable: true, overrideAuthority: "dispatcher" },
    ],
    contributions: [{ engine: "enforcement", finding: "Enforcement: blocked — 1 active order(s)" }],
  },
};

/**
 * The dispatch detail screen: a posting with one filled slot and one nobody is on — the shape that
 * exercises both the controls and the states that say less. A required slot left open is the case
 * the screen could not represent before the canonical slot model, so it belongs in the a11y sweep.
 */
const jobDetail = (o: Partial<DispatchJobDetailViewProps> = {}): DispatchJobDetailViewProps => ({
  jobId: 41,
  job: { kind: "loaded", job: {
    id: 41, jobCode: "WH-2291", type: "water_haul", mode: "transport", customer: "Northgate Energy",
    location: "04-12-052-09W5", status: "dispatched", progress: 0, eta: "14:30",
    vehicleText: "the blue vac", driverText: "Dana",
  } },
  slots: {
    kind: "loaded",
    rows: [
      { roleId: 900, postingId: 60, roleCode: "PRIMARY_UNIT", roleLabel: "Primary unit",
        displayName: "Primary unit", required: true, status: "assigned",
        operatorId: 77, operatorName: "J. Mercer", unitId: 512, unitName: "HV-0031",
        trailerId: 640, trailerName: "TR-640",
        requiredEquipmentClass: "vac_truck", requiredTrailerClass: null, lastEventId: 4100 },
      { roleId: 901, postingId: 60, roleCode: "SUPPORT_UNIT", roleLabel: "Support unit",
        displayName: "Support unit", required: true, status: "open",
        operatorId: null, operatorName: null, unitId: null, unitName: null,
        trailerId: null, trailerName: null,
        requiredEquipmentClass: null, requiredTrailerClass: null, lastEventId: null },
    ],
    staffing: { state: "partially_staffed", filled: 1, requiredTotal: 2,
      unfilledRoles: ["Support unit"],
      message: "1 of 2 required roles filled. Outstanding: Support unit." },
    planningState: "partially_staffed",
    history: [
      { id: 4100, roleId: 900, eventType: "assignment_created",
        fromOperatorId: null, fromUnitId: null, toOperatorId: 77, toUnitId: 512,
        reason: null, actorUserId: 3, occurredAt: new Date("2026-09-21T13:00:00Z") },
    ],
  },
  namesResolved: true,
  operatorChoices: [{ id: 77, label: "J. Mercer" }, { id: 78, label: "R. Okonkwo" }],
  unitChoices: [{ id: 512, label: "HV-0031" }, { id: 513, label: "HV-0032" }],
  mutation: { kind: "idle" },
  canAssign: true,
  readiness: <DispatchReadinessView {...readinessPanel(readinessBlocked)} as="panel" />,
  onAssign: () => {}, onUnassign: () => {},
  onRefresh: () => {}, refreshing: false, ...o,
});

const A11Y_NOW = new Date("2026-09-12T14:00:00Z");
const a11yProv: Provenance = { source: "measured", verification: "verified", exact: true, observedAt: A11Y_NOW };
const a11yTiles: BoardTileView[] = [
  { instanceRef: "a", widgetKey: "myDay", title: "My Day", variant: "list", payload: ok({ rows: [{ id: "1", primary: "3 stops" }] }, a11yProv), position: 0, spanColumns: 2, spanRows: 1, variants: ["list"] } as never,
  { instanceRef: "b", widgetKey: "exceptions", title: "Exception Centre", variant: "kpi", payload: { state: "not_permitted", permission: "surface.exceptions.read" }, position: 1, spanColumns: 1, spanRows: 1, variants: ["kpi"] } as never,
  { instanceRef: "c", widgetKey: "unitReadiness", title: "Unit Readiness", variant: "status", payload: blocked([{ code: "X", detail: "Annual inspection expired 2026-08-14" }]), position: 2, spanColumns: 1, spanRows: 1, variants: ["status"] } as never,
  { instanceRef: "d", widgetKey: "search", title: "Search", variant: "form", payload: unknown("no verified axle limit loaded"), position: 3 } as never,
];
const A11Y_DRIVER: RoleActor = { roles: ["driver"], permissions: [] } as never;

const PERSON = {
  userId: 123, displayName: "Dylan Hutchings", membershipStatus: "active" as const, membershipType: "employee",
  roles: ["driver"], workspaces: ["field_workforce"], defaultWorkspace: "field_workforce",
  effectiveFrom: "2026-01-04T00:00:00Z", effectiveTo: null, live: true,
};
const peopleProps = (over: Partial<PeopleAccessViewProps> = {}): PeopleAccessViewProps => ({
  organizationName: "ABC Transport",
  people: [PERSON, { ...PERSON, userId: 456, displayName: "Former Person", membershipStatus: "ended" as const, roles: [], workspaces: [], live: false, effectiveTo: "2026-08-01T00:00:00Z" }],
  invitations: [
    { invitationRef: "INV-1", emailHint: "new@example.test", displayNameHint: "R. Cardinal", roles: ["driver"], view: "pending" as const, expiresAt: "2027-10-01T00:00:00Z", invitedAt: "2026-01-02T00:00:00Z" },
    { invitationRef: "INV-2", emailHint: "old@example.test", displayNameHint: null, roles: ["office"], view: "expired" as const, expiresAt: "2026-01-01T00:00:00Z", invitedAt: "2026-08-01T00:00:00Z" },
  ],
  needsResolution: [{ legacyGrantId: 88, userId: 123, displayName: "Dylan Hutchings", role: "mechanic", grantedAt: "2025-03-02T00:00:00Z" }],
  roleCatalogue: [
    { role: "driver", description: "Field jobs, trips and field paperwork.", workspaces: [{ key: "field_workforce", label: "Field Workforce" }] },
    { role: "mechanic", description: "Maintenance work and work orders.", workspaces: [{ key: "fleet_maintenance", label: "Fleet Maintenance" }] },
  ],
  ...over,
});

/* v23.31 — the commercial screens: customers, one contract, one rate sheet, in the states a person meets. */
const a11yHistory = [{ id: 1, eventType: "customer_created", fromStatus: null, toStatus: "active", reason: null, actorUserId: 3, actorRole: "office", occurredAt: "2026-06-01T12:00:00Z", changesJson: '{"name":{"from":null,"to":"Bighorn Energy"}}' }];
const a11yProfile = (o: Partial<CustomerProfile> = {}): CustomerProfile => ({
  accountRef: "CUST-1", customerNumber: "CN-2026-000007", name: "Bighorn Energy", legalName: "Bighorn Energy Ltd.", tradeName: null, customerType: "producer_operator", status: "active", holdReason: null, province: "AB", archivedAt: null, paymentTermsDays: 45,
  taxStatus: "taxable", gstNumber: "123456789RT0001", defaultCurrency: "CAD", creditLimitCents: 25_000_000, requiresPurchaseOrder: true, requiresAfe: false, requiredReferenceKinds: ["cost_centre"], billingFrequency: "per_job", notes: null,
  billingAddress: { line1: "1 Main St", city: "Calgary", province: "AB", postalCode: "T2P 1A1" }, physicalAddress: null, country: "CA", rowVersion: 2, archiveReason: null, createdAt: "2026-06-01", updatedAt: "2026-06-02",
  contacts: [{ contactRef: "CT-1", displayName: "Kyle", title: "Company man", company: "Consultants Inc", phone: "403-555-0100", mobile: null, email: null, status: "active", roles: [{ roleKey: "site_contact", isPrimary: true, status: "active" }] }],
  contracts: [{ contractRef: "CTR-1", contractNumber: "MSA-2026-014", title: "Master service agreement", status: "active", effectiveFrom: "2026-06-01", effectiveTo: null, version: 1 }],
  rateSheets: [{ rateSheetRef: "RSH-1", name: "2026 hydrovac", sheetNumber: "RSHT-2026-000001", status: "active", currentVersion: { versionRef: "RSV-1", version: 1, effectiveFrom: "2026-06-01", effectiveTo: null }, pending: 0 }],
  purchaseOrders: [{ poRef: "PO-1", poNumber: "PO-4471", afeNumber: null, authorizedCents: 5_000_000, validFrom: "2026-06-01", validTo: null, status: "open" }],
  jobs: [{ snapshotRef: "JCS-1", jobId: 42, capturedAt: "2026-06-15", contractRef: "CTR-1", rateSheetVersionRef: "RSV-1", poNumber: "PO-4471", job: { jobCode: "JOB-2026-000042", status: "dispatched", type: "Hydrovac", location: "LSD 4-12" } }],
  ...o,
});
const customers = (o: Partial<CustomersViewProps> = {}): CustomersViewProps => ({
  offline: false, filter: { q: "", status: "", customerType: "", includeArchived: false }, onFilter: () => {},
  list: { kind: "loaded", data: [{ accountRef: "CUST-1", customerNumber: "CN-2026-000007", name: "Bighorn Energy", legalName: null, customerType: "producer_operator", status: "active", holdReason: null, province: "AB", archivedAt: null, paymentTermsDays: 45 }] },
  selected: "CUST-1", onSelect: () => {}, profile: { kind: "loaded", data: a11yProfile() }, tab: "overview", onTab: () => {},
  history: { kind: "loaded", data: a11yHistory }, documents: { kind: "loaded", data: [] }, canWrite: true, canArchive: true,
  onCreate: () => {}, creating: false, financialEntityId: "12", onFinancialEntityId: () => {}, onHold: () => {}, onArchive: () => {}, onReactivate: () => {}, onContactCreate: () => {},
  onOpenContract: () => {}, onOpenRateSheet: () => {}, onOpenJob: () => {}, ...o,
});
const a11yContract = (o: Partial<ContractDetail> = {}): ContractDetail => ({
  contractRef: "CTR-1", contractNumber: "MSA-2026-014", title: "Master service agreement", contractType: "msa", status: "active", version: 1, effectiveFrom: "2026-06-01", effectiveTo: "2027-05-31", poRequirement: "required", requiredReferenceKinds: [], customerReferences: { msa: "MSA-2026-014" },
  paymentTermsDays: 30, billingInstructions: "Attach the signed ticket", notes: null, renewalKind: "manual", renewalNoticeDays: 60, usedOperationallyAt: "2026-06-15", rowVersion: 3,
  submittedByUserId: 3, submittedAt: "2026-06-01", approvedByUserId: 4, approvedAt: "2026-06-02", approvalNote: "signed copy in the vault", suspensionReason: null, terminationReason: null,
  customer: { accountRef: "CUST-1", name: "Bighorn Energy", customerNumber: "CN-2026-000007" }, terms: null,
  rateSheets: [{ rateSheetRef: "RSH-1", name: "2026 hydrovac", sheetNumber: "RSHT-2026-000001", status: "active" }], documents: [{ documentRef: "DOC-1", documentType: "msa", title: "Signed MSA", version: 1, status: "current", registeredAt: "2026-06-01" }],
  jobs: [{ snapshotRef: "JCS-1", jobId: 42, status: "current", capturedAt: "2026-06-15", job: { jobCode: "JOB-2026-000042", status: "dispatched" } }], lineage: [], history: a11yHistory, renewal: { state: "in_term", daysRemaining: 240, noticeDue: "2027-04-01" }, ...o,
});
const contractProps = (o: Partial<ContractViewProps> = {}): ContractViewProps => ({ offline: false, contract: { kind: "loaded", data: a11yContract() }, canWrite: true, canApprove: true, canGovern: true, busy: false, onSubmit: () => {}, onDecide: () => {}, onStatus: () => {}, onSupersede: () => {}, onOpenCustomer: () => {}, onOpenRateSheet: () => {}, onOpenContract: () => {}, onOpenJob: () => {}, ...o });
const a11ySheet = (o: Partial<RateSheetDetail> = {}): RateSheetDetail => ({
  rateSheetRef: "RSH-1", name: "2026 hydrovac", sheetNumber: "RSHT-2026-000001", currency: "CAD", status: "active", notes: null, confidential: true, currentVersion: "RSV-1",
  customer: { accountRef: "CUST-1", name: "Bighorn Energy", customerNumber: "CN-2026-000007" }, contract: { contractRef: "CTR-1", contractNumber: "MSA-2026-014", title: "MSA", status: "active" },
  versions: [
    { versionRef: "RSV-2", version: 2, status: "draft", effectiveFrom: "2026-07-01", effectiveTo: null, contentHash: null, notes: null, submittedByUserId: null, approvedByUserId: null, approvedAt: null, rejectionReason: null, usedOperationallyAt: null, rowVersion: 1, jobs: [], lines: [{ definitionRef: "CHG-3", lineNo: 1, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", label: "Hydrovac truck", pricingMethod: "per_unit", unit: "hour", measurementBasis: "any", conditionKey: null, applicability: [], approvalStatus: "proposed", version: 1, sourceClause: null, effectiveFrom: "2026-07-01", effectiveTo: null, rateMillis: 215_000, flatCents: null, basisPoints: null, multiplierMillis: null, minimumQuantityMillis: 4000, minimumChargeCents: null, billingIncrementMillis: 250, roundingMode: "nearest", currency: "CAD" }] },
    { versionRef: "RSV-1", version: 1, status: "approved", effectiveFrom: "2026-06-01", effectiveTo: null, contentHash: "a".repeat(64), notes: null, submittedByUserId: 3, approvedByUserId: 4, approvedAt: "2026-06-02", rejectionReason: null, usedOperationallyAt: "2026-06-15", rowVersion: 3, jobs: [{ snapshotRef: "JCS-1", jobId: 42, status: "current", capturedAt: "2026-06-15", job: { jobCode: "JOB-2026-000042" } }], lines: [
      { definitionRef: "CHG-1", lineNo: 1, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", label: "Hydrovac truck", pricingMethod: "per_unit", unit: "hour", measurementBasis: "any", conditionKey: null, applicability: [], approvalStatus: "approved", version: 1, sourceClause: "§4.1", effectiveFrom: "2026-06-01", effectiveTo: null, rateMillis: 185_000, flatCents: null, basisPoints: null, multiplierMillis: null, minimumQuantityMillis: 4000, minimumChargeCents: null, billingIncrementMillis: 250, roundingMode: "nearest", currency: "CAD" },
      { definitionRef: "CHG-2", lineNo: 2, serviceCode: "hydrovac_hour", lineKind: "night_shift", label: "Night shift", pricingMethod: "per_unit", unit: "hour", measurementBasis: "any", conditionKey: null, applicability: [{ kind: "shift", op: "eq", value: "night" }], approvalStatus: "approved", version: 1, sourceClause: null, effectiveFrom: "2026-06-01", effectiveTo: null, rateMillis: 215_000, flatCents: null, basisPoints: null, multiplierMillis: null, minimumQuantityMillis: null, minimumChargeCents: null, billingIncrementMillis: null, roundingMode: "nearest", currency: "CAD" },
    ] },
  ],
  documents: [], history: a11yHistory, ...o,
});
const withheld = (): RateSheetDetail => { const s = a11ySheet({ confidential: false }); return { ...s, versions: s.versions.map(v => ({ ...v, lines: v.lines.map(({ rateMillis: _r, flatCents: _f, basisPoints: _b, multiplierMillis: _m, minimumQuantityMillis: _q, minimumChargeCents: _c, billingIncrementMillis: _i, roundingMode: _o, currency: _cu, ...rest }) => rest) })) }; };
const sheetProps = (o: Partial<RateSheetViewProps> = {}): RateSheetViewProps => ({ offline: false, sheet: { kind: "loaded", data: a11ySheet() }, selectedVersion: null, onSelectVersion: () => {}, canPropose: true, canApprove: true, busy: false, onVersionCreate: () => {}, onLineAdd: () => {}, onLineRemove: () => {}, onSubmit: () => {}, onDecide: () => {}, onOpenCustomer: () => {}, onOpenContract: () => {}, onOpenJob: () => {}, ...o });

/* ---- 0237: the Fleet portfolio's screens ---- */
const fleetFilters = { status: null, lifecycle: null, assetClass: null, q: "" };
const fleetRow = (o: Partial<FleetListRow>): FleetListRow => ({
  unitId: 1, unitNumber: "27", assetClass: "power_unit", assetType: "hydrovac", make: "Kenworth", model: "T880", modelYear: 2021, plate: "ABC 123",
  lifecycleStatus: "active", status: "available", activeHolds: 0, openCriticalDefects: 0, assignedOperatorName: null, ...o,
});
const fleetRows: FleetListRow[] = [fleetRow({ unitId: 1, unitNumber: "A1" }), fleetRow({ unitId: 2, unitNumber: "B2", status: "out_of_service", activeHolds: 1, assignedOperatorName: "D. Reid" }), fleetRow({ unitId: 3, unitNumber: "C3", status: "indeterminate", assetClass: null, assetType: null })];
const fleetDetail: AssetDetail = {
  identity: { unitId: 7, unitNumber: "27", assetClass: "power_unit", assetType: "hydrovac", assetSubtype: null, vehicleType: "hydrovac", vin: "1XK", serialNumber: null, plate: "ABC 123", plateJurisdiction: "AB", make: "Kenworth", model: "T880", modelYear: 2021, manufacturer: null, ownershipType: "owned", acquiredAt: null, homeTerminal: "Red Deer", assignedBranchRef: null, assignedDivision: null, regulatoryClass: null, companyAssetNumber: null, notes: null },
  lifecycle: { status: "active", changedAt: null, reason: null, retiredAt: null },
  state: { status: "out_of_service", reasons: [{ code: "hold_safety", status: "out_of_service", category: "safety", label: "Steering box leaking", source: { table: "unitHolds", ref: "HOLD-1" }, since: "2026-09-25T00:00:00Z", liftedBy: "fleet.holdRelease" }], restrictions: ["Yard moves only"], since: "2026-09-25T00:00:00Z", notEvaluated: [{ domain: "documents_and_insurance", reason: "decided at dispatch" }] },
  driverNotice: "Out of service — do not operate: Steering box leaking",
  readiness: { verdict: "blocked", findings: [{ code: "unit_hold_safety", label: "Unit 27 — safety hold", severity: "blocking", subject: "truck", overrideClass: "NEVER_OVERRIDABLE" }], notEvaluated: [{ axis: "operator", reason: "no driver" }, { axis: "job", reason: "no job" }, { axis: "route", reason: "no route" }] },
  assignment: { operatorName: "D. Reid", jobCode: "JOB-1" },
  holds: [{ holdRef: "HOLD-1", holdType: "safety", dispatchEffect: "out_of_service", reason: "Steering box leaking", status: "active", placedAt: "2026-09-25T00:00:00Z", placedByRole: "safety", sourceKind: "manual" }],
  components: [{ componentRef: "CMP-1", direction: "attached", otherUnitId: 9, otherUnitNumber: "VAC-9", relationship: "mounted", removable: false, installedAt: "2026-09-01T00:00:00Z", removedAt: null, criticalDefectOpen: true }],
  meters: [{ meterType: "odometer_km", trust: "trusted", current: { value: 100500, recordedAt: "2026-09-04T00:00:00Z", source: "trip" } }],
  documents: [{ id: 1, docType: "cvip_certificate", title: "CVIP 2026", identifier: "C-1", issuedAt: null, expiresAt: "2027-01-01T00:00:00Z", verificationStatus: "verified", validity: "in_force" }],
  insurance: { status: "coverage_verified", reason: "Policy P-1 in force" },
  defects: [{ id: 3, title: "Blower bearing seized", severity: "critical", status: "open", reportedAt: "2026-09-20T00:00:00Z" }], workOrders: [], inspections: [],
  events: [{ eventRef: "FPE-1", eventType: "hold_placed", subjectType: "hold", subjectRef: "HOLD-1", detail: "safety (manual): Steering box leaking", actorUserId: 5, actorRole: "safety", occurredAt: "2026-09-25T00:00:00Z" }],
};
const fleetActions = (o: Partial<FleetActions> = {}): FleetActions => ({ forbidden: {}, placeHold: () => {}, releaseHold: () => {}, setLifecycle: () => {}, detachComponent: () => {}, busy: null, lastError: null, ...o });

const surfaces = [
  { name: "customers — overview", render: () => render(<CustomersView {...customers()} />) },
  { name: "customers — contacts, with the add form", render: () => render(<CustomersView {...customers({ tab: "contacts" })} />) },
  { name: "customers — contracts and rate sheets", render: () => render(<CustomersView {...customers({ tab: "rate_sheets" })} />) },
  { name: "customers — jobs", render: () => render(<CustomersView {...customers({ tab: "jobs" })} />) },
  { name: "customers — billing settings and governance", render: () => render(<CustomersView {...customers({ tab: "billing" })} />) },
  { name: "customers — audit history", render: () => render(<CustomersView {...customers({ tab: "history" })} />) },
  { name: "customers — on hold, offline", render: () => render(<CustomersView {...customers({ offline: true, profile: { kind: "loaded", data: a11yProfile({ status: "on_hold", holdReason: "90 days overdue" }) } })} />) },
  { name: "customers — archived", render: () => render(<CustomersView {...customers({ tab: "billing", profile: { kind: "loaded", data: a11yProfile({ status: "inactive", archivedAt: "2026-08-01", archiveReason: "ceased trading" }) } })} />) },
  { name: "customers — empty list, nothing selected", render: () => render(<CustomersView {...customers({ selected: null, list: { kind: "empty", note: "No customer matches." } })} />) },
  { name: "customers — read refused", render: () => render(<CustomersView {...customers({ list: { kind: "unauthorized" }, profile: { kind: "unauthorized" } })} />) },
  { name: "customers — read failed", render: () => render(<CustomersView {...customers({ list: { kind: "failed", message: "Database unavailable" }, profile: { kind: "loading" } })} />) },
  { name: "contract — active, frozen by a job", render: () => render(<ContractView {...contractProps()} />) },
  { name: "contract — awaiting approval", render: () => render(<ContractView {...contractProps({ contract: { kind: "loaded", data: a11yContract({ status: "pending_approval", usedOperationallyAt: null, approvedAt: null, approvedByUserId: null, documents: [], jobs: [], rateSheets: [] }) } })} />) },
  { name: "contract — suspended", render: () => render(<ContractView {...contractProps({ contract: { kind: "loaded", data: a11yContract({ status: "suspended", suspensionReason: "insurance lapsed" }) } })} />) },
  { name: "contract — read failed", render: () => render(<ContractView {...contractProps({ contract: { kind: "failed", message: "Database unavailable" } })} />) },
  { name: "rate sheet — a draft version with the line form", render: () => render(<RateSheetView {...sheetProps({ selectedVersion: "RSV-2" })} />) },
  { name: "rate sheet — the approved version, frozen by a job", render: () => render(<RateSheetView {...sheetProps({ selectedVersion: "RSV-1" })} />) },
  { name: "rate sheet — prices withheld", render: () => render(<RateSheetView {...sheetProps({ sheet: { kind: "loaded", data: withheld() }, canPropose: false, canApprove: false })} />) },
  { name: "rate sheet — loading, offline", render: () => render(<RateSheetView {...sheetProps({ offline: true, sheet: { kind: "loading" } })} />) },
  { name: "disposal finder", render: () => render(<DisposalFinderView {...finder()} />) },
  { name: "dispatch readiness — blocked", render: () => render(<DispatchReadinessView {...readinessPanel(readinessBlocked)} />) },
  { name: "dispatch readiness — query failed", render: () => render(<DispatchReadinessView {...readinessPanel({ kind: "failed", message: "Database unavailable" })} />) },
  { name: "dispatch readiness — capability picture", render: () => render(<DispatchReadinessView {...readinessPanel(readinessBlocked, readinessCapabilities, { status: "BLOCKED", explanation: "1 capability blocked; 1 was not evaluated.", missingRequired: [] })} />) },
  { name: "dispatch detail — a filled slot and an open one", render: () => render(<DispatchJobDetailView {...jobDetail()} />) },
  // 0237 — the Fleet portfolio: the list in three states, the detail with a held unit and a refused control.
  { name: "fleet list — held, unestablished and operational units", render: () => render(<FleetListView state={{ kind: "loaded", rows: fleetRows, total: 3, cap: 100 }} filters={fleetFilters} onFilter={() => {}} onOpen={() => {}} />) },
  { name: "fleet list — empty answer", render: () => render(<FleetListView state={{ kind: "loaded", rows: [], total: 0, cap: 100 }} filters={fleetFilters} onFilter={() => {}} onOpen={() => {}} />) },
  { name: "fleet list — read failed", render: () => render(<FleetListView state={{ kind: "failed", message: "Database unavailable" }} filters={fleetFilters} onFilter={() => {}} onOpen={() => {}} />) },
  { name: "fleet asset — out of service, controls offered", render: () => render(<FleetAssetDetailView state={{ kind: "loaded", detail: fleetDetail }} actions={fleetActions()} />) },
  { name: "fleet asset — a refused control, with the reason", render: () => render(<FleetAssetDetailView state={{ kind: "loaded", detail: fleetDetail }} actions={fleetActions({ forbidden: { placeHold: "FORBIDDEN: fleet.hold.place", setLifecycle: "FORBIDDEN: fleet.lifecycle.set" }, lastError: "Hold HOLD-1 was released by someone else a moment ago" })} />) },
  { name: "fleet asset — equipment tab", render: () => render(<FleetAssetDetailView state={{ kind: "loaded", detail: fleetDetail }} actions={fleetActions()} initialTab="Equipment" />) },
  { name: "fleet asset — read failed", render: () => render(<FleetAssetDetailView state={{ kind: "failed", message: "Unit 99 not found" }} actions={fleetActions()} />) },
  { name: "dispatch detail — job with no posting", render: () => render(<DispatchJobDetailView {...jobDetail({ slots: { kind: "no_posting" } })} />) },
  // A refused write is an alert a screen reader must reach; it is the state most likely to be
  // styled into a corner and never announced.
  { name: "dispatch detail — a refused write", render: () => render(<DispatchJobDetailView {...jobDetail({ mutation: { kind: "conflict", roleId: 900, message: "This slot changed since you loaded it." } })} />) },
  { name: "dispatch detail — read-only dispatcher", render: () => render(<DispatchJobDetailView {...jobDetail({ canAssign: false })} />) },
  { name: "dispatch detail — job outside the readable window", render: () => render(<DispatchJobDetailView {...jobDetail({ job: { kind: "outside_window" } })} />) },
  { name: "commercial office — organizations", render: () => render(<CommercialOfficeView {...office("organizations")} />) },
  { name: "commercial office — documents", render: () => render(<CommercialOfficeView {...office("documents")} />) },
  { name: "commercial office — disposal", render: () => render(<CommercialOfficeView {...office("disposal")} />) },
  { name: "commercial office — month close", render: () => render(<CommercialOfficeView {...office("month_close")} />) },
  { name: "showcase panel — records", render: () => render(<SourcedPanel title="Saved decisions" source={fromQuery("x.list", [{ id: 1 }])}><p>body</p></SourcedPanel>) },
  { name: "widget board", render: () => render(<WidgetBoard name="Yard mornings" seeded={false} deviceClass="desktop" tiles={a11yTiles} />) },
  { name: "widget tile — blocked", render: () => render(<WidgetTileShell title="Unit Readiness" variant="status" payload={blocked([{ code: "A", detail: "Annual inspection expired" }])} />) },
  { name: "widget tile — unknown", render: () => render(<WidgetTileShell title="Hours Remaining" variant="kpi" payload={unknown("no verified duty record loaded")} />) },
  { name: "add-widget picker", render: () => render(<AddWidgetPicker offers={listOfferable(A11Y_DRIVER)} alreadyAdded={[]} onAdd={() => {}} />) },
  { name: "showcase panel — demonstration", render: () => render(<SourcedPanel title="Route alternatives" source={demonstration("no routing engine result is read on this page")}><p>body</p></SourcedPanel>) },
  // v23.31 — the screens a person meets before anything else. A driver signs in
  // on a phone in a cab and a mechanic on a shop tablet with wet hands, so these
  // are the last surfaces in the product that may fail a contrast or a name-role
  // rule.
  { name: "sign in", render: () => render(<SignInView methods={[{ key: "leaseos", label: "Sign in to LeaseOS", detail: "LeaseOS uses your organization's single sign-on.", onSelect: () => {} }]} notice="Your session has ended. Sign in to continue." />) },
  { name: "sign in — refused", render: () => render(<SignInView methods={[{ key: "leaseos", label: "Sign in to LeaseOS", detail: "single sign-on", onSelect: () => {} }]} error="Sign-in could not be completed. Try again." intendedLabel="the page you were opening (/portal/field_workforce)" />) },
  { name: "workspace chooser", render: () => render(<WorkspaceChooserView displayName="Dana Reyes" workspaces={[{ key: "field_workforce", label: "Field", description: "Driver operations, jobs, routes and paperwork" }, { key: "fleet_maintenance", label: "Mechanic", description: "Work orders, repairs and vehicle maintenance" }]} activeWorkspace="field_workforce" onSelectWorkspace={() => {}} onSignOut={() => {}} />) },
  { name: "organization chooser", render: () => render(<WorkspaceChooserView organizations={[{ orgRef: "ORG-A", name: "ABC Transport", membershipType: "employee" }, { orgRef: "ORG-B", name: "Northern Hauling", membershipType: "contractor" }]} activeOrgRef={null} workspaces={[]} onSelectWorkspace={() => {}} onSelectOrganization={() => {}} />) },
  { name: "access denied — no workspace", render: () => render(<AccessDeniedView kind="no_workspace" onSignOut={() => {}} />) },
  { name: "access denied — workspace not open", render: () => render(<AccessDeniedView kind="workspace_not_open" onGoToWorkspace={() => {}} workspaceLabel="Field" onSignOut={() => {}} />) },

  // B23.2 — People & Access. An administrative screen, and a manager may reach
  // it from a phone in a yard, so all four sections and the person detail go
  // through the rules rather than only the one that happens to render first.
  { name: "people & access — active", render: () => render(<PeopleAccessView {...peopleProps()} />) },
  { name: "people & access — invitations", render: () => render(<PeopleAccessView {...peopleProps({ section: "invitations", issuedLink: { invitationRef: "INV-1", token: "tok" } })} />) },
  { name: "people & access — needs resolution", render: () => render(<PeopleAccessView {...peopleProps({ section: "resolution" })} />) },
  { name: "people & access — former", render: () => render(<PeopleAccessView {...peopleProps({ section: "former" })} />) },
  { name: "people & access — person detail", render: () => render(<PeopleAccessView {...peopleProps({ selected: { person: PERSON, workspaceOptions: [{ key: "field_workforce", label: "Field Workforce" }] } })} />) },
  { name: "people & access — refusal", render: () => render(<PeopleAccessView {...peopleProps({ error: "This is the last management access in ABC Transport." })} />) },

  // 0205/0206 — the Board, read in a cab: three states, the alert regions included.
  { name: "board — offline conversation with a queued message and a bulletin to acknowledge", render: () => render(<BoardPanelView {...board()} />) },
  { name: "board — a write the device refused and conversations that failed to load", render: () => render(<BoardPanelView {...board({ online: true, writeNotice: "Not signed in to an organization on this device — nothing was kept", channels: { kind: "failed", message: "Network down" }, visibleChannels: [] })} />) },
  { name: "board — open-work card with an offer", render: () => render(<BoardPanelView {...board({ online: true, tab: "open_work", selectedPost: "OS-1", card: { kind: "loaded", value: boardCard }, pendingResponse: { response: "interested", state: "queued", lastError: null } })} />) },
];

describe("WCAG A/AA, the rules a renderer-free environment can decide", () => {
  for (const v of VIEWPORTS) {
    for (const s of surfaces) {
      it(`${s.name} at ${v.name} (${v.width}px) has no violation`, async () => {
        setViewport(v);
        const { container } = s.render();
        const run = await runAxe(container);
        expect(run.violations, describeRun(run)).toEqual([]);
      }, 30_000);
    }
  }

  it("catches a real violation, so a green suite means the rules ran and not that they were inert", async () => {
    setViewport(VIEWPORTS[0]);
    const { container } = render(
      <div>
        <img src="x.png" />
        <input type="text" />
        <a href="#x" />
      </div>,
    );
    const run = await runAxe(container);
    const ids = run.violations.map(v => v.id);
    expect(ids, describeRun(run)).toEqual(expect.arrayContaining(["image-alt"]));
    expect(ids.length).toBeGreaterThanOrEqual(2);   // the unlabelled input and the empty link are found too
  }, 30_000);

  it("actually applies the rule set — a suite that checked nothing is not a pass", async () => {
    setViewport(VIEWPORTS[2]);
    const { container } = render(<CommercialOfficeView {...office("month_close")} />);
    const run = await runAxe(container);
    // A small fragment can legitimately match no rule; a full screen cannot. This is where the floor belongs.
    expect(run.passes, describeRun(run)).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it("says plainly which rules it did not evaluate, so a green run is not read as accessible", async () => {
    setViewport(VIEWPORTS[0]);
    const { container } = render(<SourcedPanel title="Any" source={demonstration("a panel to run the rules against")}><p>body</p></SourcedPanel>);
    const run = await runAxe(container);
    expect(run.notEvaluated).toEqual(NEEDS_A_RENDERER);
    expect(describeRun(run)).toContain("need a renderer and were not evaluated");
    expect(NEEDS_A_RENDERER).toContain("color-contrast");   // contrast is the one people assume is covered
    expect(NEEDS_A_RENDERER).toContain("target-size");
  });
});

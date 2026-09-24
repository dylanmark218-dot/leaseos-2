/**
 * P5.3 — the real axe WCAG A/AA rules against our real components, at three widths.
 * See axeHarness.ts for what a renderer-free environment can and cannot decide.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NEEDS_A_RENDERER, VIEWPORTS, describeRun, runAxe, setViewport } from "./axeHarness";
import { DisposalFinderView, type DisposalFinderViewProps } from "../pages/DisposalFinderView";
import { CommercialOfficeView, type CommercialOfficeViewProps } from "../pages/CommercialOfficeView";
import { DocumentControlView, type DocumentControlViewProps, type DocDetail as DcDocDetail, type DocRow as DcDocRow } from "../pages/DocumentControlView";
import { DispatchReadinessView, type DispatchReadinessViewProps } from "../dispatch/DispatchReadinessView";
import { DispatchJobDetailView, type DispatchJobDetailViewProps } from "../dispatch/DispatchJobDetailView";
import { SourcedPanel } from "../showcase/SourcedPanel";
import { WidgetBoard } from "../widgets/WidgetBoard";
import { WidgetTileShell } from "../widgets/WidgetTileShell";
import { AddWidgetPicker } from "../widgets/AddWidgetPicker";
import { blocked, ok, unknown, type Provenance } from "../../../server/_core/widgetPayload";
import type { BoardTileView } from "../widgets/WidgetBoard";
import { listOfferable } from "../../../server/_core/widgetService";
import type { RoleActor } from "../../../server/_core/roleActor";
import { demonstration, fromQuery } from "../showcase/panelSource";
import { LoginView } from "../pages/LoginView";
import { NoPortalAvailable, OrganizationSelectionRequired, PortalChooser } from "../portal/PortalChooser";

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

const a11yPortals = [
  { portal: "field_workforce", displayName: "Field Workforce", purpose: "Perform daily work — assignments, inspections, loads, tickets, evidence" },
  { portal: "fleet_maintenance", displayName: "Fleet Maintenance", purpose: "Work orders, defects and vehicle maintenance" },
];

const dcScan: DcDocRow = { documentRef: "DOC-2026-000418", title: "Facility ticket", definitionKey: "external_disposal_receipt", documentType: "external_disposal_receipt", originKind: "external_scanned", issuerKind: "facility", issuerName: "ACME Disposal", controlNumber: null, controlState: "confirmed", status: "current", version: 1, templateRevisionRef: null, registeredAt: "2026-09-20T18:30:00Z", issuedAt: null, provenance: "Scanned from paper; issued by ACME Disposal; no LeaseOS number." };
const dcInvoice: DcDocRow = { ...dcScan, documentRef: "DOC-2026-000419", title: "Invoice INV-2026-000031", definitionKey: "invoice", documentType: "invoice", originKind: "system_rendered", issuerKind: "tenant", issuerName: null, controlNumber: "INV-2026-000031", controlState: "issued", issuedAt: "2026-09-21T09:00:00Z", provenance: "Rendered by LeaseOS; issued by the tenant under INV-2026-000031." };
const dcDetail: DcDocDetail = {
  document: { ...dcScan, contentHash: "ab".repeat(32), byteLength: 48213, mimeType: "image/png", evidenceRecordId: 77, renderManifestHash: null, capturedByDeviceRef: "DEV-7", importChannel: "device_sync" },
  provenance: dcScan.provenance, retention: "UNCONFIGURED — retained indefinitely until a person assigns a policy",
  definition: { definitionKey: "waste_manifest_internal_record", displayName: "Waste manifest (internal record)", documentClass: "operational_form", numberingPolicy: "leaseos_series_optional", representationPolicy: "internal_record", representationNotice: "Internal record. Not the official EPA Uniform Hazardous Waste Manifest.", revisionPolicy: "amend_with_reason", primaryDomainOwner: "disposal" },
  links: [{ id: 1, recordType: "job", recordRef: "JOB-26-00481", recordId: 5, role: "subject", source: "human", confirmationStatus: "confirmed" }, { id: 2, recordType: "disposal_ticket", recordRef: "DSP-AI-1", recordId: 9, role: "source_document", source: "domain", confirmationStatus: "confirmed" }],
  references: [{ referenceRef: "XREF-1", referenceType: "facility_ticket_number", referenceValueRaw: "874399", issuerKind: "facility", issuerName: "ACME Disposal", source: "ocr_proposed", confirmationStatus: "confirmed", mirrorOfTable: "disposalTickets" }],
  versions: [{ documentRef: "DOC-2026-000418", version: 1, status: "current", controlState: "confirmed" }], amendments: [{ fieldKey: "issuerName", originalValue: "ACME", correctedValue: "ACME Disposal" }],
  derivatives: [{ derivativeRef: "DRV-1", derivativeKind: "ocr_text", producer: "device-ocr", producerVersion: "1.2", contentHash: "cd".repeat(32), sourceContentHash: "ab".repeat(32), mimeType: "text/plain", byteLength: 91, actorSource: "ai", createdAt: "2026-09-20T18:31:00Z" }],
  extractions: [{ extractionRef: "EXT-1", proposalId: "PROP-DC-1", ocrEngine: "device-ocr", proposedDocumentType: "external_disposal_receipt", classificationSource: "human", status: "committed", fieldCount: 9, askedCount: 0, humanOnlyCount: 4, extractedAt: "2026-09-20T18:31:00Z" }],
  timeline: [{ sequence: 1, eventType: "document.captured", actorUserId: 12, actorSource: "human", deviceRef: "DEV-7", previousState: null, newState: "captured", detail: null, occurredAt: "2026-09-20T18:30:00Z" }, { sequence: 2, eventType: "document.reprinted", actorUserId: 3, actorSource: "human", deviceRef: null, previousState: null, newState: null, detail: { copy: 2 }, occurredAt: "2026-09-22T08:00:00Z" }],
};
const dc = (tab: DocumentControlViewProps["tab"], o: Partial<DocumentControlViewProps> = {}): DocumentControlViewProps => ({
  tab, onTab: () => {}, filter: { q: "", definitionKey: "", originKind: "", controlState: "", recordType: "", recordRef: "" }, onFilter: () => {},
  documents: [dcScan, dcInvoice], selectedDoc: null, onSelectDoc: () => {}, loading: false, reviewQueue: [{ ...dcScan, controlState: "needs_classification", definitionKey: "unclassified_external_document" }],
  templates: [{ templateRef: "TPL-1", templateKey: "bill_of_lading", definitionKey: "bill_of_lading", name: "Bill of lading", sourceKind: "leaseos_standard", ownerKind: "leaseos", ownerName: null, status: "active", layer: "platform", currentRevision: { revisionRef: "TPLR-1-r2", revision: 2, layoutKind: "pdf_overlay", rendererKey: "pdf_overlay", renderable: false, releasedAt: "2026-09-23T00:00:00Z" } }],
  selectedTemplate: { template: { templateRef: "TPL-1", templateKey: "bill_of_lading", definitionKey: "bill_of_lading", name: "Bill of lading", sourceKind: "leaseos_standard", ownerKind: "leaseos", ownerName: null, status: "active", layer: "platform", currentRevision: null, orgRef: null }, revisions: [{ revisionRef: "TPLR-1-r2", revision: 2, status: "released", layoutKind: "pdf_overlay", rendererKey: "pdf_overlay", rendererVersion: "0", fieldMappingHash: "ff".repeat(32), releaseManifestHash: "ee".repeat(32), releasedAt: "2026-09-23T00:00:00Z", retiredAt: null }] }, onSelectTemplate: () => {},
  definitions: [{ definitionKey: "dot_fmcsa_registration_authority", displayName: "DOT/FMCSA registration and authority record", documentClass: "regulatory_record", primaryDomainOwner: "compliance", numberingPolicy: "leaseos_series_optional", numberSeriesType: "REG", externalReferencePolicy: "optional", representationPolicy: "internal_record", representationNotice: "Internal compliance record; not an agency-issued form.", jurisdictionPolicy: "configurable_verify_by_jurisdiction", status: "active", layer: "platform", label: "internal record" }],
  series: [{ sequenceType: "DOC", periodKey: "2026", branch: "", handedOut: 420, issued: 418, reserved: 1, voided: 1 }], gapQuery: { sequenceType: "DOC", periodKey: "2026" }, onGapQuery: () => {},
  gapReport: { scopeKey: "default", sequenceType: "DOC", periodKey: "2026", issued: 418, explained: 1, heldByDevice: 0, unexplained: 1, rows: [{ sequence: 7, state: "voided", formattedNumber: "DOC-2026-000007", reasonText: "printer jam, sheet destroyed" }, { sequence: 9, state: "unexplained", formattedNumber: "DOC-2026-000009" }] },
  ...o,
});

const surfaces = [
  { name: "disposal finder", render: () => render(<DisposalFinderView {...finder()} />) },
  { name: "dispatch readiness — blocked", render: () => render(<DispatchReadinessView {...readinessPanel(readinessBlocked)} />) },
  { name: "dispatch readiness — query failed", render: () => render(<DispatchReadinessView {...readinessPanel({ kind: "failed", message: "Database unavailable" })} />) },
  { name: "dispatch readiness — capability picture", render: () => render(<DispatchReadinessView {...readinessPanel(readinessBlocked, readinessCapabilities, { status: "BLOCKED", explanation: "1 capability blocked; 1 was not evaluated.", missingRequired: [] })} />) },
  { name: "dispatch detail — a filled slot and an open one", render: () => render(<DispatchJobDetailView {...jobDetail()} />) },
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
  { name: "document control — library", render: () => render(<DocumentControlView {...dc("library")} />) },
  { name: "document control — record detail with a representation notice", render: () => render(<DocumentControlView {...dc("library", { selectedDoc: dcDetail })} />) },
  { name: "document control — review queue", render: () => render(<DocumentControlView {...dc("review")} />) },
  { name: "document control — templates", render: () => render(<DocumentControlView {...dc("templates")} />) },
  { name: "document control — definitions", render: () => render(<DocumentControlView {...dc("definitions")} />) },
  { name: "document control — number series and gaps", render: () => render(<DocumentControlView {...dc("series")} />) },
  { name: "showcase panel — records", render: () => render(<SourcedPanel title="Saved decisions" source={fromQuery("x.list", [{ id: 1 }])}><p>body</p></SourcedPanel>) },
  { name: "widget board", render: () => render(<WidgetBoard name="Yard mornings" seeded={false} deviceClass="desktop" tiles={a11yTiles} />) },
  { name: "widget tile — blocked", render: () => render(<WidgetTileShell title="Unit Readiness" variant="status" payload={blocked([{ code: "A", detail: "Annual inspection expired" }])} />) },
  { name: "widget tile — unknown", render: () => render(<WidgetTileShell title="Hours Remaining" variant="kpi" payload={unknown("no verified duty record loaded")} />) },
  { name: "add-widget picker", render: () => render(<AddWidgetPicker offers={listOfferable(A11Y_DRIVER)} alreadyAdded={[]} onAdd={() => {}} />) },
  { name: "showcase panel — demonstration", render: () => render(<SourcedPanel title="Route alternatives" source={demonstration("no routing engine result is read on this page")}><p>body</p></SourcedPanel>) },
  // The sign-in and workspace-selection screens. Read in a cab and in a shop,
  // on a phone and on a desktop, which is exactly what the three viewports are
  // for. Each error state is run separately: the alert and status regions only
  // exist in those states, and a rule that never sees them has not checked them.
  { name: "login — first visit", render: () => render(<LoginView reason="unauthenticated" busy={false} onSignIn={() => {}} />) },
  { name: "login — session expired", render: () => render(<LoginView reason="expired" busy={false} detail="Signed out after inactivity" onSignIn={() => {}} />) },
  { name: "login — sign-in failed", render: () => render(<LoginView reason="auth_error" busy={false} detail="invalid oauth state" onSignIn={() => {}} />) },
  { name: "login — in flight", render: () => render(<LoginView reason="unauthenticated" busy onSignIn={() => {}} />) },
  { name: "workspace chooser", render: () => render(<PortalChooser options={a11yPortals} notReached={[{ portal: "executive", displayName: "Executive", purpose: "company-wide performance" }]} onChoose={() => {}} />) },
  { name: "workspace chooser — declined default and link", render: () => render(<PortalChooser options={a11yPortals} rejectedDefault="executive" rejectedRequest="executive" onChoose={() => {}} />) },
  { name: "no workspace available", render: () => render(<NoPortalAvailable notReached={a11yPortals} onSignOut={() => {}} />) },
  { name: "organization selection required", render: () => render(<OrganizationSelectionRequired detail="member of 2 organizations" />) },
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

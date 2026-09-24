/**
 * 0175 CP3 — the customer's view of a job is an explicit projection.
 *
 * Pure. Feeds the projections canonical-shaped inputs carrying every kind of private data a job
 * record can touch — internal notes, driver contact and licence, hours of service, payroll, cost,
 * safety-event titles, other jobs — and checks that none of it survives, while the customer-safe
 * fields do.
 */
import { describe, expect, it } from "vitest";
import { CUSTOMER_STATUSES, CUSTOMER_TIMELINE_STEPS, customerStatus, projectCustomerJob, projectLoads, projectLocation, projectOpenTicket, type CustomerJobInput } from "./_core/customerJobView";

const at = (hhmm: string, day = "2026-09-24") => new Date(`${day}T${hhmm}:00Z`);
const NOW = at("13:00");

describe("the customer status vocabulary", () => {
  const base = { jobStatus: "dispatched" as const, postingState: null, events: [], siteSigned: false, safety: [], now: NOW };
  it("maps an open ticket event to its step before any status column, and internal states to the smaller vocabulary", () => {
    expect(customerStatus({ ...base, events: [{ eventType: "site_work", occurredAt: at("07:30"), endedAt: null }] })).toMatchObject({ status: "In Progress" });
    expect(customerStatus({ ...base, events: [{ eventType: "customer_hold", occurredAt: at("07:30"), endedAt: null }] })).toMatchObject({ status: "On Hold" });
    expect(customerStatus({ ...base, events: [{ eventType: "travel_to_disposal", occurredAt: at("07:30"), endedAt: null }] })).toMatchObject({ status: "Transporting" });
    expect(customerStatus({ ...base, events: [{ eventType: "disposal_queue", occurredAt: at("07:30"), endedAt: null }] })).toMatchObject({ status: "At Disposal" });
    expect(customerStatus({ ...base, events: [{ eventType: "disposal", occurredAt: at("07:30"), endedAt: null }] })).toMatchObject({ status: "At Disposal" });
    expect(customerStatus({ ...base, events: [{ eventType: "return_travel", occurredAt: at("07:30"), endedAt: null }] })).toMatchObject({ status: "Returning" });
    // Between events with site work behind it: on location. Nothing more is guessed.
    expect(customerStatus({ ...base, events: [{ eventType: "site_work", occurredAt: at("07:30"), endedAt: at("12:00") }] })).toMatchObject({ status: "On Location" });
    // A job status column decides when no ticket event does.
    expect(customerStatus({ ...base, jobStatus: "in_transit" })).toMatchObject({ status: "En Route", basis: "Job status in transit" });
    expect(customerStatus({ ...base, jobStatus: "on_site" }).status).toBe("On Location");
    expect(customerStatus({ ...base, jobStatus: "loading" }).status).toBe("In Progress");
    expect(customerStatus({ ...base, jobStatus: "complete" }).status).toBe("Completed");
    // A job not yet dispatched reads from the posting.
    expect(customerStatus({ ...base, postingState: "staffed" })).toMatchObject({ status: "Scheduled", basis: "Dispatch planning: staffed" });
    expect(customerStatus({ ...base, postingState: "cancelled" }).status).toBe("Cancelled");
    expect(customerStatus({ ...base, postingState: "dispatched" }).status).toBe("Dispatched");
    // A signed site is complete even with an internal event open; an open safety event is Attention over everything.
    expect(customerStatus({ ...base, siteSigned: true, events: [{ eventType: "restock", occurredAt: at("20:00"), endedAt: null }] }).status).toBe("Completed");
    expect(customerStatus({ ...base, events: [{ eventType: "site_work", occurredAt: at("07:30"), endedAt: null }], safety: [{ eventType: "vehicle_defect", severity: "warning", status: "open", occurredAt: at("09:00") }] })).toMatchObject({ status: "Attention", basis: "An operational event is under review by the contractor" });
  });
  it("uses only the customer's words", () => {
    for (const s of CUSTOMER_STATUSES) expect(s).toMatch(/^[A-Z][a-z]+( [A-Z][a-z]+)?$/);
    expect(CUSTOMER_TIMELINE_STEPS).toEqual(["Scheduled", "Dispatched", "En Route", "On Location", "In Progress", "Transporting", "At Disposal", "Returning", "Completed"]);
  });
});

describe("the position a customer sees", () => {
  const fix = { latitude: 53.123456, longitude: -116.654321, recordedAt: at("12:55"), speedKmh: 82, headingDegrees: 270, accuracyMetres: 6, source: "gps" };
  it("shows nothing when sharing is off or live tracking has ended, an area when approximate, the fix when live", () => {
    expect(projectLocation({ mode: "none", live: true, fix, now: NOW })).toMatchObject({ position: null, note: expect.stringMatching(/off/) });
    expect(projectLocation({ mode: "live", live: false, fix, now: NOW })).toMatchObject({ position: null, note: expect.stringMatching(/ended/) });
    expect(projectLocation({ mode: "live", live: true, fix: null, now: NOW })).toMatchObject({ position: null, note: expect.stringMatching(/No position/) });
    const approx = projectLocation({ mode: "approximate", live: true, fix, now: NOW });
    expect(approx).toMatchObject({ position: { latitude: 53.12, longitude: -116.65, precision: "approximate" }, heading: null, speedKmh: null, stale: false, ageMinutes: 5 });
    const live = projectLocation({ mode: "live", live: true, fix, now: NOW });
    expect(live).toMatchObject({ position: { latitude: 53.123456, longitude: -116.654321, precision: "exact" }, heading: 270, speedKmh: 82, stale: false });
  });
  it("names a stale fix as stale, never as live", () => {
    const old = projectLocation({ mode: "live", live: true, fix: { ...fix, recordedAt: at("12:00") }, now: NOW });
    expect(old.stale).toBe(true);
    expect(old.ageMinutes).toBe(60);
    expect(old.note).toMatch(/60 minutes old — stale, not live/);
    expect(projectLocation({ mode: "live", live: true, fix: { ...fix, recordedAt: at("12:44") }, now: NOW }).stale).toBe(true);   // 16 min: older than the 15-minute threshold
    expect(projectLocation({ mode: "live", live: true, fix: { ...fix, recordedAt: at("12:45") }, now: NOW }).stale).toBe(false);  // exactly 15 min is the last fresh minute
  });
});

describe("loads", () => {
  it("keeps every load on its job in sequence with its ticket, destination, method and state", () => {
    const r = projectLoads({
      loads: [
        { id: 2, loadNumber: "LD-2", tripId: 20, material: "slurry", quantity: 11.8, quantityUnit: "m3", measurementMethod: "customer_stated", chainState: "in_transit", loadTicketNumber: null, createdAt: at("10:00") },
        { id: 1, loadNumber: "LD-1", tripId: 10, material: "produced water", quantity: 12.4, quantityUnit: "m3", measurementMethod: "scale", chainState: "disposal_verified", loadTicketNumber: "LT-1", createdAt: at("08:00") },
        { id: 3, loadNumber: "LD-3", tripId: null, material: null, quantity: null, quantityUnit: null, measurementMethod: "unknown", chainState: "created", loadTicketNumber: null, createdAt: at("12:00") },
      ],
      trips: [{ id: 10, tripNumber: "T-10", status: "complete", startedAt: at("08:10"), completedAt: at("09:30"), destinationFacilityId: 5 }, { id: 20, tripNumber: "T-20", status: "in_transit", startedAt: at("10:10"), completedAt: null, destinationFacilityId: 5 }],
      disposals: [{ id: 1, loadId: 1, ticketNumber: "DSP-1", facilityTicketNumber: "SEC-44821", facilityId: 5, scaleInAt: at("09:00"), quantity: 12.4, quantityUnit: "m3", verificationStatus: "verified" }],
      facilityNames: new Map([[5, "Edson TRD"]]),
    });
    expect(r).toMatchObject({ total: 3, completed: 1, active: 2 });
    expect(r.items.map(i => [i.sequence, i.loadNumber, i.status])).toEqual([[1, "LD-1", "completed"], [2, "LD-2", "in_transit"], [3, "LD-3", "in_progress"]]);
    expect(r.items[0]).toMatchObject({ destination: "Edson TRD", disposalTicketNumber: "SEC-44821", disposalVerified: true, measured: "scale", quantity: 12.4 });
    expect(r.items[1]).toMatchObject({ measured: "customer stated", disposalTicketNumber: null, disposalVerified: false, pickedUpAt: at("10:00") });
    expect(r.items[2]).toMatchObject({ pickedUpAt: null, destination: null, measured: "not recorded" });
  });
});

describe("the open ticket a customer sees", () => {
  const line = (o: Partial<Parameters<typeof projectOpenTicket>[0]["lines"][number]> = {}) => ({ id: 1, customerVisible: true, lineKind: "service", serviceCode: "VAC-HR", description: "Truck service", quantity: 4.5, quantityUnit: "h", disposition: "not_presented", amountCents: 83_250, priced: true, loadNumber: null, periodStartAt: null, periodEndAt: null, amendsLineId: null, ...o });
  const ticket = (billingState: string, extra: Partial<Parameters<typeof projectOpenTicket>[0]["ticket"]> = {}) => ({ ticketNumber: "FT-2026-000001", billingState, billingVersion: 4, customerPoNumber: "PO-4500123", completedAt: at("12:00"), finalizedAt: null, snapshotHash: "h".repeat(64), ...extra });
  it("hides internal-only lines, sums only priced visible lines as an estimate, and names unpriced ones", () => {
    const r = projectOpenTicket({ ticket: ticket("OPEN"), lines: [line(), line({ id: 2, description: "Standby", quantity: 1, amountCents: 18_500 }), line({ id: 3, description: "Internal fuel surcharge basis — cost 41.10/h", customerVisible: false, amountCents: 999_999 }), line({ id: 4, description: "Disposal fee", amountCents: null, priced: false, loadNumber: "LD-1" })], finalTotalCents: null, invoice: null });
    expect(r.lines.map(l => l.lineId)).toEqual([1, 2, 4]);
    expect(r.accrued).toEqual({ subtotalCents: 101_750, pricedLines: 2, unpricedLines: 1, hiddenLines: 1, label: "Estimated subtotal — accrued so far, before taxes; not an invoice", isFinal: false });
    expect(r.lines[2]).toMatchObject({ amountCents: null, priced: false, load: "LD-1", decision: "pending" });
    expect(JSON.stringify(r)).not.toContain("cost 41.10");
    expect(JSON.stringify(r)).not.toContain("999999");
    expect(r.finalized).toBeNull();
    expect(r.invoiced).toBeNull();
    expect(r.actions).toEqual({ acknowledge: true, approve: false, dispute: false, comment: true, sign: false });
  });
  it("distinguishes the estimate, the finalized total, and the invoiced amount with tax", () => {
    const fin = projectOpenTicket({ ticket: ticket("FINALIZED", { finalizedAt: at("14:00") }), lines: [line({ disposition: "accepted" })], finalTotalCents: 83_250, invoice: null });
    expect(fin.finalized).toEqual({ totalCents: 83_250, at: at("14:00"), label: "Finalized ticket total, before taxes" });
    expect(fin.accrued.label).toMatch(/see the finalized total/);
    expect(fin.actions).toEqual({ acknowledge: false, approve: false, dispute: false, comment: false, sign: false });
    const inv = projectOpenTicket({ ticket: ticket("INVOICED", { finalizedAt: at("14:00") }), lines: [line({ disposition: "accepted" })], finalTotalCents: 83_250, invoice: { invoiceNumber: "INV-2026-000009", status: "sent", subtotalCents: 83_250, taxCents: 4_163, totalCents: 87_413, issuedAt: at("15:00") } });
    expect(inv.invoiced).toMatchObject({ invoiceNumber: "INV-2026-000009", taxCents: 4_163, totalCents: 87_413 });
    const review = projectOpenTicket({ ticket: ticket("AWAITING_CUSTOMER_REVIEW"), lines: [line()], finalTotalCents: null, invoice: null });
    expect(review.actions).toEqual({ acknowledge: true, approve: true, dispute: true, comment: true, sign: true });
  });
});

describe("the job projection carries nothing private", () => {
  const input = (over: Partial<CustomerJobInput> = {}): CustomerJobInput => ({
    job: { jobCode: "260921-001", type: "Hydrovac excavation", mode: "hydrovac", location: "10-22-045-06-W5", status: "on_site", eta: "14:30", createdAt: at("06:00"), updatedAt: at("12:59") },
    posting: { planningState: "dispatched", scheduledStart: at("07:00") },
    customerReference: "PO-4500123",
    unit: { unitNumber: "142", vehicleType: "hydrovac" },
    operatorName: "Jane Marie Doe",
    tickets: [{ ticketNumber: "FT-2026-000001", events: [{ eventType: "site_work", occurredAt: at("07:31"), endedAt: null }], signedAt: null, completedAt: null }],
    safety: [],
    trips: [{ id: 10, tripNumber: "T-10", status: "in_transit", startedAt: at("06:40"), completedAt: null, destinationFacilityId: 5 }],
    destination: "Edson TRD",
    firstUnitJoinedAt: at("06:30"),
    fix: { latitude: 53.123456, longitude: -116.654321, recordedAt: at("12:55"), speedKmh: 82, headingDegrees: 270, accuracyMetres: 6, source: "gps" },
    visibility: { locationMode: "live", live: true, unit: true, operator: true },
    now: NOW,
    ...over,
  });
  it("projects the customer-safe fields", () => {
    const v = projectCustomerJob(input());
    expect(v).toMatchObject({ jobReference: "260921-001", customerReference: "PO-4500123", serviceType: "Hydrovac excavation (hydrovac)", origin: "10-22-045-06-W5", destination: "Edson TRD", status: { label: "In Progress" }, unit: { unitNumber: "142" }, operatorDisplayName: "Jane", eta: "14:30", scheduledAt: at("07:00"), dispatchedAt: at("06:30"), arrivedAt: at("07:31"), completedAt: null, ticketNumbers: ["FT-2026-000001"] });
    expect(v.timeline.filter(s => s.reached).map(s => s.step)).toEqual(["Scheduled", "Dispatched", "En Route", "On Location", "In Progress"]);
    expect(v.timeline.find(s => s.step === "En Route")!.at).toEqual(at("06:40"));
    expect(v.timeline.find(s => s.step === "Completed")).toEqual({ step: "Completed", reached: false, at: null });
    expect(v.location.position).toEqual({ latitude: 53.123456, longitude: -116.654321, precision: "exact" });
  });
  it("honours the identity and location settings", () => {
    const v = projectCustomerJob(input({ visibility: { locationMode: "approximate", live: true, unit: false, operator: false } }));
    expect(v.unit).toBeNull();
    expect(v.operatorDisplayName).toBeNull();
    expect(v.location.position).toEqual({ latitude: 53.12, longitude: -116.65, precision: "approximate" });
    const ended = projectCustomerJob(input({ visibility: { locationMode: "live", live: false, unit: true, operator: true } }));
    expect(ended.location.position).toBeNull();
    expect(ended.eta).toBeNull();
  });
  it("carries no internal notes, driver contact, licence, HOS, payroll, cost or other job — even when the inputs do", () => {
    // The projection's INPUT type has no field for any of these; the object below smuggles them in anyway.
    const smuggled = {
      ...input({ operatorName: "Jane Doe", safety: [{ eventType: "vehicle_defect", severity: "warning", status: "open", occurredAt: at("09:00") } as never] }),
      internalNotes: "customer is slow to pay; watch the PO",
      driver: { name: "Jane Doe", phone: "780-555-0100", licenseNumber: "AB-12345-XYZ", emergencyContact: "John Doe 780-555-0101", restrictions: "corrective lenses" },
      hos: { drivingMinutesToday: 412, dutyStatus: "on_duty_driving", cycleRemaining: 1830 },
      payroll: { hourlyRate: 42.5, overtimeMinutes: 90 },
      cost: { fuelPerHour: 41.1, vendorRate: 165 },
      otherJobs: ["260921-002", "260921-003"],
      safetyDetail: "Hydraulic hose blew on J. Smith; operator reports wrist pain",
    } as unknown as CustomerJobInput;
    const text = JSON.stringify(projectCustomerJob(smuggled));
    for (const forbidden of ["slow to pay", "780-555", "AB-12345", "John Doe", "corrective", "412", "on_duty", "1830", "42.5", "overtime", "41.1", "165", "260921-002", "260921-003", "Hydraulic", "Smith", "wrist", "Doe"]) expect(text, forbidden).not.toContain(forbidden);
    expect(text).toContain('"operatorDisplayName":"Jane"');
    expect(text).toContain('"label":"Attention"');
  });
});

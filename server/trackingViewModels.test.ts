/**
 * 0175 CP4 — the tracking page's view-models, tested in Node.
 */
import { describe, expect, it } from "vitest";
import { loadRows, loadsSummary, locationLine, money, refusalMessage, routeLine, ticketView, timelineRows, toneOf } from "../client/src/tracking/trackingViewModels";

describe("the tracking page's view-models", () => {
  it("tones the customer statuses, formats money without inventing a zero, and reads the route line", () => {
    expect(["Scheduled", "En Route", "In Progress", "On Hold", "Attention", "Completed", "Unknown"].map(toneOf)).toEqual(["scheduled", "moving", "working", "hold", "attention", "done", "unknown"]);
    expect(money(101_750)).toBe("$1,017.50");
    expect(money(null)).toBe("—");
    expect(money(0)).toBe("$0.00");
    expect(routeLine({ serviceType: "Hydrovac", origin: "10-22-045-06-W5", destination: null })).toBe("Hydrovac · from 10-22-045-06-W5");
    expect(routeLine({ serviceType: "Hydrovac", origin: "10-22-045-06-W5", destination: "Edson TRD" })).toBe("Hydrovac · from 10-22-045-06-W5 · to Edson TRD");
  });
  it("marks the current step, and never marks one while the job is on hold or needs attention", () => {
    const tl = [{ step: "Scheduled", reached: true, at: "2026-09-24T07:00:00Z" }, { step: "Dispatched", reached: true, at: null }, { step: "En Route", reached: false, at: null }];
    expect(timelineRows(tl, "Dispatched").map(r => [r.step, r.reached, r.current])).toEqual([["Scheduled", true, false], ["Dispatched", true, true], ["En Route", false, false]]);
    expect(timelineRows(tl, "On Hold").every(r => !r.current)).toBe(true);
    expect(timelineRows(tl, "Attention").every(r => !r.current)).toBe(true);
    expect(timelineRows(tl, "Dispatched")[1]!.at).toBe("—");
  });
  it("says where the unit is in the mode given, names a stale fix, and shows the ETA when there is no position", () => {
    const base = { mode: "live", recordedAt: "2026-09-24T12:55:00Z", ageMinutes: 5, stale: false, note: "n" };
    expect(locationLine({ ...base, position: { latitude: 53.123456, longitude: -116.654321, precision: "exact" } }, "14:30")).toEqual({ headline: "Live position · 5 min ago", detail: "ETA 14:30", stale: false, coordinates: "53.12346, -116.65432" });
    expect(locationLine({ ...base, mode: "approximate", position: { latitude: 53.12, longitude: -116.65, precision: "approximate" } }, null).headline).toBe("Approximate area · 5 min ago");
    expect(locationLine({ ...base, ageMinutes: 60, stale: true, position: { latitude: 53.12, longitude: -116.65, precision: "approximate" } }, "14:30")).toMatchObject({ headline: "Last known position — stale (60 min ago)", stale: true });
    expect(locationLine({ ...base, mode: "none", position: null, note: "Location sharing is off for this link" }, "14:30")).toEqual({ headline: "ETA 14:30", detail: "Location sharing is off for this link", stale: false, coordinates: null });
    expect(locationLine({ ...base, mode: "none", position: null, note: "off" }, null).headline).toBe("Location not shared");
  });
  it("lists loads in the customer's words with their tickets and states", () => {
    const rows = loadRows([
      { sequence: 1, loadNumber: "LD-1", status: "completed", pickedUpAt: "2026-09-24T08:00:00Z", material: "produced water", quantity: 12.4, quantityUnit: "m3", measured: "scale", destination: "Edson TRD", disposalTicketNumber: "SEC-44821", disposalVerified: true },
      { sequence: 2, loadNumber: "LD-2", status: "in_transit", pickedUpAt: null, material: "slurry", quantity: null, quantityUnit: null, measured: "not recorded", destination: null, disposalTicketNumber: "DSP-9", disposalVerified: false },
      { sequence: 3, loadNumber: "LD-3", status: "in_progress", pickedUpAt: null, material: null, quantity: null, quantityUnit: null, measured: "not recorded", destination: null, disposalTicketNumber: null, disposalVerified: false },
    ]);
    expect(rows.map(r => [r.title, r.state, r.tone])).toEqual([["Load 1", "Completed", "done"], ["Load 2", "In transit", "moving"], ["Load 3", "In progress", "scheduled"]]);
    expect(rows[0]!.lines.slice(1)).toEqual(["12.4 m3 produced water (scale)", "To Edson TRD", "Disposal ticket SEC-44821 · verified"]);
    expect(rows[1]!.lines).toEqual(["slurry — quantity not recorded", "Disposal ticket DSP-9 · on file, not yet verified"]);
    expect(rows[2]!.lines).toEqual([]);
    expect(loadsSummary({ total: 3, completed: 1, active: 2 })).toBe("3 total · 1 completed · 2 active");
    expect(loadsSummary({ total: 0, completed: 0, active: 0 })).toBe("No loads yet");
  });
  it("reads the ticket with one labelled figure per stage, the estimate last and never called an invoice", () => {
    const v = ticketView({ ticketNumber: "FT-1", status: "AWAITING_CUSTOMER_REVIEW", customerPoNumber: null,
      lines: [{ description: "Truck service", quantity: 4.5, unit: "h", amountCents: 83_250, priced: true, decision: "pending", load: null, amendment: false }, { description: "Disposal fee", quantity: 2, unit: "load", amountCents: null, priced: false, decision: "disputed", load: "LD-2", amendment: true }],
      accrued: { subtotalCents: 83_250, pricedLines: 1, unpricedLines: 1, label: "Estimated subtotal — accrued so far, before taxes; not an invoice" },
      finalized: { totalCents: 83_250, at: "2026-09-24T14:00:00Z", label: "Finalized ticket total, before taxes" },
      invoiced: { invoiceNumber: "INV-9", status: "sent", subtotalCents: 83_250, taxCents: 4_163, totalCents: 87_413 },
      actions: { acknowledge: true, approve: true, dispute: true, comment: true, sign: false } });
    expect(v.status).toBe("Ready for your review");
    expect(v.lines).toEqual([
      { description: "Truck service", quantity: "4.5 h", amount: "$832.50", decision: "pending", detail: null },
      { description: "Amendment: Disposal fee", quantity: "2 load", amount: "not yet priced", decision: "disputed", detail: "Load LD-2" },
    ]);
    expect(v.figures.map(f => [f.kind, f.value])).toEqual([["invoice", "$874.13"], ["final", "$832.50"], ["estimate", "$832.50"]]);
    expect(v.figures[0]!.sub).toBe("Subtotal $832.50 · Tax $41.63");
    expect(v.figures[2]!.label).toMatch(/not an invoice/);
    expect(v.reviewable).toBe(true);
  });
  it("turns a refusal into the recipient's words without naming a job", () => {
    expect(refusalMessage("This tracking link has been revoked").headline).toBe("This link has been revoked");
    expect(refusalMessage("This tracking link has reached its access limit").headline).toBe("This link has reached its limit");
    expect(refusalMessage("This tracking link is disabled").headline).toBe("This link is paused");
    expect(refusalMessage("Unknown tracking link").headline).toBe("This link cannot be opened");
    expect(refusalMessage(null).detail).toMatch(/Ask the contractor/);
  });
});

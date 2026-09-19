/**
 * P3.6 — the clause the row had not met: resolve a number, then walk the chain it sits in.
 *
 * Found by auditing the DONE rows against their original definitions. The master search resolved
 * numbers across a dozen tables and returned flat records; somebody holding a number is almost
 * never asking "does this exist" — they are asking what it belongs to.
 */
import { describe, expect, it } from "vitest";
import { CHAIN_ORDER, walkEvidenceChain } from "./evidenceChainWalk";

const full = {
  customer: { ref: "Ridgeline Energy", id: 4 },
  job: { ref: "JOB-08421", id: 12, status: "active" },
  trip: { ref: "TRIP-2026-000812", id: 31, status: "closed" },
  load: { ref: "LOAD-000455", id: 77, status: "delivered" },
  manifest: { ref: "MF-2026-000311", id: 90 },
  disposal_ticket: { ref: "DSP-2026-000412", id: 51, status: "verified" },
  field_ticket: { ref: "FT-2026-000812", id: 66, status: "accepted" },
  billing_book: { ref: "BB-2026-000044", id: 70 },
  invoice: { ref: "INV-2026-001904", id: 81, status: "sent" },
};

describe("a number resolves to its place in the chain", () => {
  it("walks the whole chain in the order the work happens", () => {
    const w = walkEvidenceChain({ anchorKind: "disposal_ticket", found: full });
    expect(w.nodes.map(n => n.kind)).toEqual([...CHAIN_ORDER]);
    expect(w.gaps).toEqual([]);
    expect(w.explanation).toMatch(/chain complete/);
    expect(w.explanation).toMatch(/job JOB-08421 → trip TRIP-2026-000812 → load LOAD-000455/);
  });

  it("says how each hop connects, in words a person would use", () => {
    const w = walkEvidenceChain({ anchorKind: "invoice", found: full });
    expect(w.nodes.find(n => n.kind === "trip")!.via).toBe("trip of job JOB-08421");
    expect(w.nodes.find(n => n.kind === "customer")!.via).toBeNull();   // nothing precedes it
  });

  it("anchors on whatever number the person actually has", () => {
    for (const kind of ["load", "invoice", "field_ticket"] as const) {
      expect(walkEvidenceChain({ anchorKind: kind, found: full }).anchor.ref).toBe(full[kind].ref);
    }
  });
});

describe("a missing hop is named, never skipped", () => {
  it("names a load with no disposal ticket, which is the most interesting thing on the chain", () => {
    // A load nobody can bill. A walk that silently omitted it would present an incomplete chain as
    // a complete one, which is worse than not walking at all.
    const { disposal_ticket, ...rest } = full;
    const w = walkEvidenceChain({ anchorKind: "load", found: rest });
    expect(w.gaps.map(g => g.missing)).toContain("disposal_ticket");
    expect(w.gaps.find(g => g.missing === "disposal_ticket")!.note)
      .toMatch(/the load reads delivered but no disposal ticket is attached — the load cannot be billed as disposed/);
    expect(w.explanation).toMatch(/Not attached: disposal ticket/);
  });

  it("reads the same gap differently when the load has not got there yet", () => {
    // Position, not judgement: a load still loading legitimately has no disposal ticket.
    const { disposal_ticket, ...rest } = full;
    const w = walkEvidenceChain({ anchorKind: "load", found: { ...rest, load: { ref: "LOAD-000455", id: 77, status: "loading" } } });
    expect(w.gaps.find(g => g.missing === "disposal_ticket")!.note).toBe("no disposal ticket attached yet");
  });

  it("flags a closed trip with nothing presented to the customer", () => {
    const { field_ticket, invoice, ...rest } = full;
    const w = walkEvidenceChain({ anchorKind: "trip", found: rest });
    expect(w.gaps.find(g => g.missing === "field_ticket")!.note)
      .toMatch(/the trip reads closed with no field ticket — nothing has been presented to the customer/);
  });

  it("does not report a gap for a hop this chain cannot have", () => {
    // A standalone service event has no disposal; calling that a gap trains people to ignore gaps.
    const { disposal_ticket, manifest, ...rest } = full;
    const w = walkEvidenceChain({ anchorKind: "field_ticket", found: rest, notApplicable: ["disposal_ticket", "manifest"] });
    expect(w.gaps).toEqual([]);
    expect(w.nodes.map(n => n.kind)).not.toContain("disposal_ticket");
  });

  it("reports every gap after the last thing it found, not just the first", () => {
    const w = walkEvidenceChain({ anchorKind: "job", found: { customer: full.customer, job: full.job } });
    expect(w.gaps.map(g => g.missing)).toEqual(["trip", "load", "manifest", "disposal_ticket", "field_ticket", "billing_book", "invoice"]);
    expect(w.gaps.every(g => g.after === "job")).toBe(true);
  });

  it("still answers when only the anchor resolves", () => {
    const w = walkEvidenceChain({ anchorKind: "invoice", found: { invoice: full.invoice } });
    expect(w.anchor.ref).toBe("INV-2026-001904");
    expect(w.nodes.map(n => n.kind)).toEqual(["invoice"]);
    expect(w.gaps).toEqual([]);   // nothing precedes it that was looked for and missed
  });
});

import { describe, expect, it } from "vitest";
import {
  deriveSignatureStatus,
  reconcileJob,
  validateFieldTicketScope,
  type LineDisposition,
  type SignatureStatus,
} from "./fieldTicket";

const fields = (r: Parameters<typeof validateFieldTicketScope>[0]) =>
  validateFieldTicketScope(r).map(e => e.field);

describe("validateFieldTicketScope", () => {
  it("requires a job on every ticket, whatever the scope", () => {
    expect(fields({ scope: "job", jobId: null })).toContain("jobId");
    expect(fields({ scope: "service_event", jobId: undefined })).toContain(
      "jobId"
    );
  });

  it("accepts a job-scoped ticket with no trip or load", () => {
    expect(validateFieldTicketScope({ scope: "job", jobId: 1 })).toEqual([]);
  });

  it("rejects a job-scoped ticket that names a trip or load", () => {
    expect(fields({ scope: "job", jobId: 1, tripId: 5 })).toContain("tripId");
    expect(fields({ scope: "job", jobId: 1, loadId: 9 })).toContain("loadId");
  });

  it("requires a trip for a trip-scoped ticket and forbids a load", () => {
    expect(fields({ scope: "trip", jobId: 1 })).toContain("tripId");
    expect(
      validateFieldTicketScope({ scope: "trip", jobId: 1, tripId: 5 })
    ).toEqual([]);
    expect(fields({ scope: "trip", jobId: 1, tripId: 5, loadId: 9 })).toContain(
      "loadId"
    );
  });

  it("requires both trip and load for a load-scoped ticket", () => {
    expect(fields({ scope: "load", jobId: 1, tripId: 5 })).toContain("loadId");
    expect(fields({ scope: "load", jobId: 1, loadId: 9 })).toContain("tripId");
    expect(
      validateFieldTicketScope({
        scope: "load",
        jobId: 1,
        tripId: 5,
        loadId: 9,
      })
    ).toEqual([]);
  });

  it("lets a service event attach to anything or nothing", () => {
    expect(
      validateFieldTicketScope({ scope: "service_event", jobId: 1 })
    ).toEqual([]);
    expect(
      validateFieldTicketScope({ scope: "service_event", jobId: 1, tripId: 5 })
    ).toEqual([]);
    expect(
      validateFieldTicketScope({
        scope: "service_event",
        jobId: 1,
        tripId: 5,
        loadId: 9,
      })
    ).toEqual([]);
  });

  it("supports one ticket covering five loads at one site visit", () => {
    // Trip-scoped: the rep signs once for the visit, loads hang off the trip.
    expect(
      validateFieldTicketScope({ scope: "trip", jobId: 1842, tripId: 4821 })
    ).toEqual([]);
  });
});

describe("deriveSignatureStatus", () => {
  const d = (...v: LineDisposition[]) => v;

  it("is accepted when every line is accepted", () => {
    expect(deriveSignatureStatus(d("accepted", "accepted", "accepted"))).toBe(
      "accepted"
    );
  });

  it("is refused when every presented line is disputed", () => {
    expect(deriveSignatureStatus(d("disputed", "disputed"))).toBe("refused");
  });

  it("is partially accepted for the real-world case — signs the service, not the standby", () => {
    expect(deriveSignatureStatus(d("accepted", "accepted", "disputed"))).toBe(
      "partially_accepted"
    );
  });

  it("reports no representative regardless of line state", () => {
    expect(deriveSignatureStatus(d("accepted", "accepted"), false)).toBe(
      "no_representative"
    );
  });

  it("is unsigned when nothing has been presented", () => {
    expect(deriveSignatureStatus([])).toBe("unsigned");
    expect(deriveSignatureStatus(d("not_presented", "not_presented"))).toBe(
      "unsigned"
    );
  });
});

describe("reconcileJob", () => {
  const base = {
    trips: 6,
    loads: 8,
    fieldTickets: 8,
    disposalTickets: 8,
    manifests: 8,
  };

  it("matches the closeout summary office staff expect", () => {
    const statuses: SignatureStatus[] = [
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "partially_accepted",
    ];
    const r = reconcileJob({ ...base, signatureStatuses: statuses });
    expect(r.signed).toBe(7);
    expect(r.partiallyAccepted).toBe(1);
    expect(r.billingReady).toBe(7);
    expect(r.reviewRequired).toBe(1);
    expect(r.gaps).toEqual([]);
  });

  it("names each gap specifically instead of reporting a count", () => {
    const r = reconcileJob({
      ...base,
      fieldTickets: 6,
      disposalTickets: 7,
      signatureStatuses: ["accepted", "unsigned", "no_representative"],
    });
    expect(r.gaps).toContain("2 load(s) with no field ticket");
    expect(r.gaps).toContain("1 load(s) with no disposal ticket");
    expect(r.gaps).toContain("1 ticket(s) never presented for signature");
    expect(r.gaps).toContain("1 ticket(s) had no representative on site");
  });

  it("counts refusals as review, never as ready", () => {
    const r = reconcileJob({
      ...base,
      signatureStatuses: ["refused", "accepted"],
    });
    expect(r.billingReady).toBe(1);
    expect(r.reviewRequired).toBe(1);
  });
});

import type { ChargeLineSource } from "./billing";

/**
 * Trip → charge line sources.
 *
 * `billing.ts` already owns the arithmetic and the verified-only rule. What was
 * missing is the step before it: turning a completed trip's distance, billable
 * time and disposal tickets into the sources that rule operates on. This file is
 * that step, and nothing else — it prices nothing and posts nothing.
 *
 * The rule this file exists to enforce: a measurement becomes a billable
 * quantity only when a person stands behind it. Odometer readings a driver
 * entered are evidence; a GPS track is a proposal. Both are carried forward, but
 * only the confirmed one is marked `verified`, and `calculateChargeLines` will
 * drop the other.
 *
 * Two outputs, deliberately:
 *
 *   - `sources` feeds `calculateChargeLines` unchanged. Unconfirmed sources are
 *     included with `verified: false` so that function's own `excluded` list
 *     stays meaningful rather than being silently pre-filtered here.
 *   - `omissions` is what a human reads. Every one names the specific missing
 *     thing and the specific action that resolves it, because "incomplete" is
 *     not something an office clerk can act on.
 *
 * A missing rate is never a zero rate and never a guess. It is an omission with
 * the service code printed on it.
 */

export type RateUnit = "hour" | "day" | "km" | "m3" | "tonne" | "load" | "each";

export type RateLine = {
  serviceCode: string;
  description: string;
  unit: RateUnit;
  rateCents: number;
  minimumCents: number | null;
  effectiveFrom: Date;
  /** Null means open-ended. */
  effectiveTo: Date | null;
};

/**
 * How the distance was arrived at.
 *
 * `odometer` and `human_corrected` are measurements a person is accountable for.
 * `gps` and `system_inferred` are proposals, whatever their apparent precision.
 */
export type DistanceSource = "odometer" | "gps" | "system_inferred" | "human_corrected";

export type DistanceFact = {
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  /** Whatever the trip row carries, which may be GPS-derived. */
  distanceKm: number | null;
  source: DistanceSource;
  /** Null means nobody has confirmed the figure. */
  confirmedByUserId: number | null;
};

export type BillableStop = {
  tripStopId: number;
  stopType: "load" | "unload" | "fuel" | "checkpoint";
  billableMinutes: number | null;
  /** Mirrors delayEvents.billingClassification. `review_required` never bills on its own. */
  billingClassification: "billable" | "non_billable" | "review_required";
  confirmed: boolean;
  ticketNumber: string | null;
};

export type DisposalTicketFact = {
  ticketNumber: string;
  quantity: number | null;
  quantityUnit: RateUnit | null;
  /** Facility-verified or office-verified. Unverified tickets do not bill. */
  verified: boolean;
};

export type TripBillingInput = {
  tripId: number;
  tripNumber: string;
  /** Null means the trip has not completed; nothing projects from an open trip. */
  completedAt: Date | null;
  distance: DistanceFact | null;
  stops: BillableStop[];
  disposalTickets: DisposalTicketFact[];
  /** Null means no rate card is assigned to this customer. */
  rateCard: { rateCardId: number; lines: RateLine[] } | null;
  serviceCodes: { distance: string; billableTime: string; disposal: string };
  /** When rate effectiveness is judged. Defaults to `completedAt`. */
  at?: Date;
};

export type OmissionCode =
  | "trip_not_complete"
  | "no_rate_card"
  | "no_effective_rate"
  | "rate_conflict"
  | "no_distance"
  | "distance_unconfirmed"
  | "odometer_implausible"
  | "time_unconfirmed"
  | "time_needs_review"
  | "ticket_unverified"
  | "ticket_quantity_missing";

export type Omission = {
  code: OmissionCode;
  /** What did not bill. */
  subject: string;
  /** Why it did not. */
  reason: string;
  /** The specific action that resolves it. Office staff need the phone call, not a status. */
  needs: string;
};

export type TripBillingProjection = {
  tripId: number;
  tripNumber: string;
  sources: ChargeLineSource[];
  omissions: Omission[];
  /** True when nothing at all could be projected. Distinct from "projected nothing billable". */
  blocked: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Rate resolution                                                     */
/* ------------------------------------------------------------------ */

type RateResolution =
  | { outcome: "resolved"; line: RateLine }
  | { outcome: "none" }
  | { outcome: "conflict"; candidates: RateLine[] };

/**
 * Pick the rate in force for a service code at an instant.
 *
 * Two lines with the same `effectiveFrom` is a conflict, not a tie to break.
 * Choosing one would mean the invoice depends on row order.
 */
export function resolveRate(lines: RateLine[], serviceCode: string, at: Date): RateResolution {
  const inForce = lines.filter(
    l =>
      l.serviceCode === serviceCode &&
      l.effectiveFrom.getTime() <= at.getTime() &&
      (l.effectiveTo === null || l.effectiveTo.getTime() > at.getTime()),
  );
  if (inForce.length === 0) return { outcome: "none" };

  const newest = Math.max(...inForce.map(l => l.effectiveFrom.getTime()));
  const winners = inForce.filter(l => l.effectiveFrom.getTime() === newest);
  return winners.length === 1
    ? { outcome: "resolved", line: winners[0] }
    : { outcome: "conflict", candidates: winners };
}

function rateOmission(
  resolution: Exclude<RateResolution, { outcome: "resolved" }>,
  serviceCode: string,
  subject: string,
): Omission {
  return resolution.outcome === "none"
    ? {
      code: "no_effective_rate",
      subject,
      reason: `no rate line for service code ${serviceCode} was in force on this trip's completion date`,
      needs: `add an effective-dated rate for ${serviceCode} to the assigned rate card`,
    }
    : {
      code: "rate_conflict",
      subject,
      reason:
        `${resolution.candidates.length} rate lines for ${serviceCode} share the same effective date ` +
        `(${resolution.candidates[0].effectiveFrom.toISOString().slice(0, 10)})`,
      needs: `supersede or end-date all but one ${serviceCode} rate line before this trip can bill`,
    };
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

/**
 * Distance, preferring the odometer over the track.
 *
 * An odometer pair that runs backwards is reported as implausible rather than
 * taken as an absolute value — a truck does not drive negative kilometres, and
 * quietly flipping the sign would bill a typo.
 */
function projectDistance(
  input: TripBillingInput,
  at: Date,
): { source: ChargeLineSource | null; omissions: Omission[] } {
  const subject = "Trip distance";
  const d = input.distance;

  if (!d) {
    return {
      source: null,
      omissions: [{
        code: "no_distance",
        subject,
        reason: "the trip carries no distance and no odometer readings",
        needs: "record the start and end odometer for this trip",
      }],
    };
  }

  const hasPair = d.odometerStartKm !== null && d.odometerEndKm !== null;
  if (hasPair && (d.odometerEndKm as number) < (d.odometerStartKm as number)) {
    return {
      source: null,
      omissions: [{
        code: "odometer_implausible",
        subject,
        reason: `end odometer ${d.odometerEndKm} km is below start odometer ${d.odometerStartKm} km`,
        needs: "correct the odometer readings on this trip",
      }],
    };
  }

  const km = hasPair
    ? round2((d.odometerEndKm as number) - (d.odometerStartKm as number))
    : d.distanceKm !== null && d.distanceKm >= 0 ? round2(d.distanceKm) : null;

  if (km === null) {
    return {
      source: null,
      omissions: [{
        code: "no_distance",
        subject,
        reason: "no usable distance figure is present",
        needs: "record the start and end odometer for this trip",
      }],
    };
  }

  const basis = hasPair ? "odometer" : d.source;
  const confirmed = d.confirmedByUserId !== null;
  const measured = basis === "odometer" || basis === "human_corrected";
  const verified = confirmed && measured;

  if (!input.rateCard) {
    return { source: null, omissions: [noRateCardOmission(subject)] };
  }

  const resolution = resolveRate(input.rateCard.lines, input.serviceCodes.distance, at);
  if (resolution.outcome !== "resolved") {
    return { source: null, omissions: [rateOmission(resolution, input.serviceCodes.distance, subject)] };
  }

  const omissions: Omission[] = [];
  if (!verified) {
    omissions.push({
      code: "distance_unconfirmed",
      subject,
      reason: measured
        ? `${km} km read from the odometer but nobody has confirmed it`
        : `${km} km is ${basis}-derived, which is a proposal rather than a measurement`,
      needs: measured
        ? "have the driver or office confirm the odometer figure"
        : "record confirmed odometer readings, or have the office confirm the derived distance",
    });
  }

  return {
    source: {
      description: resolution.line.description,
      quantity: km,
      unit: resolution.line.unit,
      rateCents: resolution.line.rateCents,
      derivedFrom: `trip ${input.tripNumber} · distance basis ${basis}`,
      verified,
    },
    omissions,
  };
}

function noRateCardOmission(subject: string): Omission {
  return {
    code: "no_rate_card",
    subject,
    reason: "no rate card is assigned to this customer",
    needs: "assign an approved rate card to the customer account",
  };
}

function projectBillableTime(
  input: TripBillingInput,
  at: Date,
): { source: ChargeLineSource | null; omissions: Omission[] } {
  const omissions: Omission[] = [];

  const usable = input.stops.filter(s => s.billableMinutes !== null && (s.billableMinutes as number) > 0);

  for (const s of usable.filter(s => s.billingClassification === "review_required")) {
    omissions.push({
      code: "time_needs_review",
      subject: `Stop ${s.tripStopId} (${s.stopType})`,
      reason: `${s.billableMinutes} min is classified review_required, which does not bill on its own`,
      needs: "classify the time as billable or non-billable against the customer's contract terms",
    });
  }

  const billable = usable.filter(s => s.billingClassification === "billable");
  for (const s of billable.filter(s => !s.confirmed)) {
    omissions.push({
      code: "time_unconfirmed",
      subject: `Stop ${s.tripStopId} (${s.stopType})`,
      reason: `${s.billableMinutes} min has not been confirmed by the driver or the office`,
      needs: "confirm the stop timings",
    });
  }

  const confirmed = billable.filter(s => s.confirmed);
  const minutes = confirmed.reduce((sum, s) => sum + (s.billableMinutes as number), 0);
  if (minutes <= 0) return { source: null, omissions };

  if (!input.rateCard) return { source: null, omissions: [...omissions, noRateCardOmission("Billable time")] };

  const resolution = resolveRate(input.rateCard.lines, input.serviceCodes.billableTime, at);
  if (resolution.outcome !== "resolved") {
    return {
      source: null,
      omissions: [...omissions, rateOmission(resolution, input.serviceCodes.billableTime, "Billable time")],
    };
  }

  const hours = round2(minutes / 60);
  return {
    source: {
      description: resolution.line.description,
      quantity: resolution.line.unit === "hour" ? hours : minutes,
      unit: resolution.line.unit,
      rateCents: resolution.line.rateCents,
      derivedFrom:
        `trip ${input.tripNumber} · stops ${confirmed.map(s => s.tripStopId).join(", ")}` +
        ` · ${minutes} confirmed min`,
      verified: true,
    },
    omissions,
  };
}

function projectDisposal(
  input: TripBillingInput,
  at: Date,
): { sources: ChargeLineSource[]; omissions: Omission[] } {
  const sources: ChargeLineSource[] = [];
  const omissions: Omission[] = [];

  for (const t of input.disposalTickets) {
    const subject = `Disposal ticket ${t.ticketNumber}`;

    if (t.quantity === null || t.quantityUnit === null) {
      omissions.push({
        code: "ticket_quantity_missing",
        subject,
        reason: "the ticket carries no quantity or no unit",
        needs: "enter the disposed quantity and unit from the facility ticket",
      });
      continue;
    }

    if (!input.rateCard) { omissions.push(noRateCardOmission(subject)); continue; }

    const resolution = resolveRate(input.rateCard.lines, input.serviceCodes.disposal, at);
    if (resolution.outcome !== "resolved") {
      omissions.push(rateOmission(resolution, input.serviceCodes.disposal, subject));
      continue;
    }

    if (!t.verified) {
      omissions.push({
        code: "ticket_unverified",
        subject,
        reason: "the ticket has not been verified against the facility record",
        needs: "verify the ticket against the facility's own statement",
      });
    }

    sources.push({
      description: `${resolution.line.description} — ticket ${t.ticketNumber}`,
      quantity: round2(t.quantity),
      unit: t.quantityUnit,
      rateCents: resolution.line.rateCents,
      derivedFrom: `trip ${input.tripNumber} · disposal ticket ${t.ticketNumber}`,
      verified: t.verified,
    });
  }

  return { sources, omissions };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function projectTripChargeLines(input: TripBillingInput): TripBillingProjection {
  if (input.completedAt === null) {
    return {
      tripId: input.tripId,
      tripNumber: input.tripNumber,
      sources: [],
      omissions: [{
        code: "trip_not_complete",
        subject: `Trip ${input.tripNumber}`,
        reason: "the trip has no completion time, so no round trip has closed",
        needs: "complete the trip before projecting charges",
      }],
      blocked: true,
    };
  }

  const at = input.at ?? input.completedAt;

  const distance = projectDistance(input, at);
  const time = projectBillableTime(input, at);
  const disposal = projectDisposal(input, at);

  const sources = [distance.source, time.source, ...disposal.sources].filter(
    (s): s is ChargeLineSource => s !== null,
  );

  return {
    tripId: input.tripId,
    tripNumber: input.tripNumber,
    sources,
    omissions: [...distance.omissions, ...time.omissions, ...disposal.omissions],
    blocked: sources.length === 0,
  };
}

/**
 * S10.1 — whether LeaseOS may collect location from a driver's **personal phone**.
 *
 * `monitoringNotice.ts` deliberately stopped short of this: it establishes whether a person was
 * told what is collected and why, and its own comment says it does not block collection because
 * "whether unacknowledged monitoring blocks dispatch is owner policy." The owner decided it
 * (2026-09-19, §10.1), and this is that decision and nothing more.
 *
 * The decision in one line: **no acknowledgement, no personal-phone monitoring — which is not the
 * same as no work.**
 *
 * That distinction is the whole module. A driver who has not acknowledged a monitoring notice has
 * not committed an offence; they have not been told something, or have been told and not answered.
 * Stranding their truck for it would be a punishment dressed as a safety control, and it would put
 * pressure on the acknowledgement that makes the acknowledgement worthless — a person who taps
 * "I understand" to get their shift back has not understood anything.
 *
 * So the gate answers a narrow question — may this phone stream? — and a second, separate one: does
 * this job actually need a location stream from somewhere, and is one available? When the answer to
 * the second is no, that is a **missing operational capability**, reported as such, with the
 * driver's decision nowhere in the reason.
 */

import type { Coverage, MonitoringPurpose } from "./monitoringNotice";

/** Where a location stream can legitimately come from. */
export type LocationSource =
  /** The driver's own handset. Requires an acknowledged notice. */
  | "personal_phone"
  /** Hardware in the truck. The vehicle is the employer's; the phone is not. */
  | "truck_telematics"
  /** A tablet or handset the company owns and issues. */
  | "company_device";

export type PhoneLocationVerdict =
  | { activate: true; source: "personal_phone"; because: string }
  | { activate: false; code: "NO_ACKNOWLEDGED_NOTICE" | "NO_ACTIVE_TRIP" | "PURPOSE_WITHDRAWN"; because: string };

/**
 * May this phone collect location right now?
 *
 * Two conditions, and both are about the present rather than about the person. An acknowledged
 * notice for `vehicle_location`, and an active trip to collect for. `withdrawn` is called out
 * separately from never-acknowledged because they are different acts: one is a person changing
 * their mind, which a system should be able to say out loud.
 */
export function mayActivatePhoneLocation(args: {
  coverage: Coverage;
  hasActiveTrip: boolean;
}): PhoneLocationVerdict {
  if (!args.hasActiveTrip) {
    return {
      activate: false, code: "NO_ACTIVE_TRIP",
      because: "There is no active trip. Operational location collection belongs to a trip and ends when the trip closes; outside one there is nothing for it to be evidence of.",
    };
  }
  if (args.coverage.state === "withdrawn") {
    return {
      activate: false, code: "PURPOSE_WITHDRAWN",
      because: "The driver withdrew their acknowledgement for vehicle location. Withdrawal takes effect immediately and is not a lapse to be chased.",
    };
  }
  if (!args.coverage.covered) {
    return {
      activate: false, code: "NO_ACKNOWLEDGED_NOTICE",
      because: `Vehicle-location monitoring is ${args.coverage.state.replace(/_/g, " ")}. LeaseOS does not collect location from a personal phone until the person has been told what is collected and has said so.`,
    };
  }
  return {
    activate: true, source: "personal_phone",
    because: "Acknowledged notice for vehicle location, and an active trip to collect for.",
  };
}

/* ------------------------------------------------------------------ */
/* The separate question: does the JOB need a stream, and is one there? */
/* ------------------------------------------------------------------ */

export type CapabilityVerdict =
  | { status: "ready"; source: LocationSource; detail: string }
  | { status: "not_required"; detail: string }
  | { status: "unavailable"; detail: string; blockers: readonly string[] };

/**
 * Whether this assignment has the location stream it needs.
 *
 * The ordering matters and is deliberate: an authorized company source is preferred over the
 * personal phone wherever one exists. Not because the phone is worse data — it is often better —
 * but because a truck's telematics belongs to the employer and a driver's handset does not, and a
 * system that reaches for the personal device first will keep reaching for it.
 *
 * When nothing is available and the job genuinely requires a stream, the answer is `unavailable`
 * with the missing capability named. **The driver's monitoring decision is not in the reason**, and
 * that is not cosmetic: a blocker that reads "driver declined monitoring" turns a privacy choice
 * into a performance record.
 */
export function locationCapabilityFor(args: {
  jobRequiresLiveLocation: boolean;
  availableSources: readonly LocationSource[];
  phone: PhoneLocationVerdict;
}): CapabilityVerdict {
  const company = args.availableSources.find(s => s !== "personal_phone");
  if (company) {
    return { status: "ready", source: company, detail: `Location supplied by ${company.replace(/_/g, " ")}.` };
  }
  if (args.phone.activate) {
    return { status: "ready", source: "personal_phone", detail: "Location supplied by the driver's phone under an acknowledged notice." };
  }
  if (!args.jobRequiresLiveLocation) {
    return {
      status: "not_required",
      detail: "This assignment does not require a live location stream, so there is nothing to supply and nothing to block.",
    };
  }
  return {
    status: "unavailable",
    // Named as a capability, not as a person's choice.
    detail: "This assignment requires a live location stream and no authorized source is supplying one.",
    blockers: ["live_location_stream_unavailable"],
  };
}

/**
 * The reason text a readiness blocker may carry.
 *
 * A guard in the test file holds this to its promise: nothing that reaches dispatch may mention the
 * driver's acknowledgement, their consent, or their refusal. Dispatch needs to know a capability is
 * missing so somebody can fit a company device or reassign; it does not need to know who declined
 * what, and the moment it does, the decline becomes the thing being managed.
 */
export const CAPABILITY_BLOCKER_REASON =
  "No authorized live-location source is available for this assignment. Fit a company device, use truck telematics, or assign a unit that supplies one.";

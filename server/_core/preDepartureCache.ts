/**
 * P1.5 — what has to be on the device before the truck leaves coverage.
 *
 * The failure this exists to prevent is specific and ordinary: a driver accepts a job in the yard,
 * drives ninety minutes north, and finds the SDS for what he is hauling is a link to a server he
 * cannot reach. Nothing crashed. The record showed everything was fine. He simply cannot do the job
 * safely, and the system's contribution was a spinner.
 *
 * Two rules shape the whole thing:
 *
 *   **Missing is named, never counted.** "Cache 80% complete" tells a driver nothing he can act on.
 *   "The SDS for UN1267 is not on this device" tells him to wait ninety seconds before he leaves.
 *
 *   **Cached is not current.** An item on the device is an item that *was* true when it was fetched.
 *   Each entry carries how long it may be trusted, so a route cached on Monday cannot quietly
 *   authorise a Thursday trip. `UNKNOWN` staleness is not freshness: an item with no known age is
 *   reported as unverifiable rather than assumed good.
 */

export type CacheItemKind =
  | "job" | "trip" | "route" | "map_tiles" | "facility" | "permit" | "sds" | "emergency_plan"
  | "lease_location" | "communications"
  // SA2 — a document revision open for this driver's signature (or one they will witness), with its
  // fixed hash, fields and page images, so it can be signed where there is no signal (design §6.1).
  | "signable_document";

/**
 * Why an item is on the list. `required_to_depart` blocks; `required_on_site` does not block the
 * gate but will be needed where there is no signal; `useful` is neither. Keeping the three apart is
 * what stops the manifest becoming a wall of equally urgent red.
 */
export type CacheNecessity = "required_to_depart" | "required_on_site" | "useful";

export type CacheItem = {
  kind: CacheItemKind;
  /** What it is, in the words a driver would use. */
  label: string;
  /** The record it comes from, so the device knows what to fetch and the office what to fix. */
  ref: string;
  necessity: CacheNecessity;
  /** Why this job needs it. Never a generic string: the reason is the job's own fact. */
  because: string;
  /** How long a cached copy may be trusted. Null = it does not go stale (a completed record). */
  staleAfterMinutes: number | null;
};

export type CachedState =
  | { present: true; fetchedAt: Date }
  | { present: true; fetchedAt: null }   // on the device, age unknown — not the same as fresh
  | { present: false };

export type ItemStatus = "ready" | "missing" | "stale" | "age_unknown";

export type EvaluatedItem = CacheItem & { status: ItemStatus; detail: string };

export type DepartureVerdict = {
  /** Ready only when nothing required to depart is missing, stale or of unknown age. */
  mayDepart: boolean;
  items: readonly EvaluatedItem[];
  /** The named blockers, in the order a person should deal with them. */
  blocking: readonly EvaluatedItem[];
  /** Needed where there is no signal, but not a reason to hold the truck in the yard. */
  neededOnSite: readonly EvaluatedItem[];
  explanation: string;
};

/**
 * What this job needs, derived from the job's own facts.
 *
 * Deliberately not a fixed checklist. A hydrovac run to a lease with no dangerous goods does not
 * need an SDS, and putting one on its list teaches drivers that half the list is noise — after
 * which the half that matters is noise too.
 */
export function manifestFor(job: {
  jobCode: string;
  tripRef: string | null;
  routeApprovalRef: string | null;
  dangerousGoods: { unNumber: string; shippingName: string }[];
  destinationFacilities: { facilityRef: string; name: string }[];
  permits: { permitRef: string; kind: string }[];
  leaseLocation: string | null;
  /** True where the route crosses known dead zones, so the comms plan stops being optional. */
  hasCommunicationDeadZones: boolean;
  /** SA2 — open signing revisions this driver signs or witnesses on site (`attest.list` for the job's tickets). */
  signableDocuments?: { revisionRef: string; title: string; signerRole: string }[];
}): CacheItem[] {
  const items: CacheItem[] = [
    { kind: "job", label: `Job ${job.jobCode}`, ref: job.jobCode, necessity: "required_to_depart",
      because: "the scope of work, without which nothing else on the device means anything", staleAfterMinutes: 240 },
  ];
  if (job.tripRef) {
    items.push({ kind: "trip", label: `Trip ${job.tripRef}`, ref: job.tripRef, necessity: "required_to_depart",
      because: "the trip the driver records against; events queued without it have nothing to attach to", staleAfterMinutes: 240 });
  }
  if (job.routeApprovalRef) {
    items.push({ kind: "route", label: `Approved route ${job.routeApprovalRef}`, ref: job.routeApprovalRef, necessity: "required_to_depart",
      because: "the route was evaluated against this vehicle and load; driving an unevaluated one is the decision the evaluation exists to prevent", staleAfterMinutes: 720 });
    items.push({ kind: "map_tiles", label: "Map tiles along the route", ref: `tiles:${job.routeApprovalRef}`, necessity: "required_to_depart",
      because: "the route is unreadable off-line without them", staleAfterMinutes: 60 * 24 * 30 });
  }
  for (const dg of job.dangerousGoods) {
    items.push({ kind: "sds", label: `SDS — ${dg.shippingName} (${dg.unNumber})`, ref: `sds:${dg.unNumber}`, necessity: "required_to_depart",
      because: `this load carries ${dg.unNumber}; the safety data sheet has to be reachable at a roadside or a spill, which is exactly where there is no signal`, staleAfterMinutes: 60 * 24 * 90 });
    items.push({ kind: "emergency_plan", label: `Emergency response plan — ${dg.unNumber}`, ref: `erp:${dg.unNumber}`, necessity: "required_to_depart",
      because: `an ERP that cannot be opened during the emergency it covers is not a plan`, staleAfterMinutes: 60 * 24 * 90 });
  }
  for (const f of job.destinationFacilities) {
    items.push({ kind: "facility", label: `${f.name} — hours, access, contacts`, ref: f.facilityRef, necessity: "required_on_site",
      because: "arriving at a closed gate with no phone number is a wasted trip, and the yard is where that is cheap to prevent", staleAfterMinutes: 60 * 24 * 7 });
  }
  for (const p of job.permits) {
    items.push({ kind: "permit", label: `${p.kind} permit ${p.permitRef}`, ref: p.permitRef, necessity: "required_to_depart",
      because: "an officer asks for the permit, not for a description of it", staleAfterMinutes: 60 * 24 });
  }
  if (job.leaseLocation) {
    items.push({ kind: "lease_location", label: `Lease ${job.leaseLocation}`, ref: job.leaseLocation, necessity: "required_to_depart",
      because: "the last kilometres are lease road, and that is where the map ends and the signal went first", staleAfterMinutes: 60 * 24 * 30 });
  }
  if (job.hasCommunicationDeadZones) {
    items.push({ kind: "communications", label: "Radio channels and dead-zone map", ref: `comms:${job.jobCode}`, necessity: "required_to_depart",
      because: "this route crosses known dead zones; the channel to call on is not something to look up once you are in one", staleAfterMinutes: 60 * 24 * 7 });
  }
  for (const s of job.signableDocuments ?? []) {
    // Needed on site, not to depart: a ticket can be signed later, but a revision the device never
    // downloaded cannot be signed offline at all (§6.1), and the lease is where the signal is not.
    // Four hours, like the job: the hash is fixed, but the revision can be voided or superseded.
    items.push({ kind: "signable_document", label: `${s.title} — for ${s.signerRole} signature`, ref: s.revisionRef, necessity: "required_on_site",
      because: "it is signed at the lease, where there is no signal; a copy this device never downloaded cannot be signed there", staleAfterMinutes: 240 });
  }
  return items;
}

/** Evaluate what the device actually holds against what the job needs. */
export function evaluateDeparture(
  items: readonly CacheItem[],
  cached: (item: CacheItem) => CachedState,
  now: Date,
): DepartureVerdict {
  const evaluated: EvaluatedItem[] = items.map((item) => {
    const state = cached(item);
    if (!state.present) {
      return { ...item, status: "missing", detail: `Not on this device. ${item.because}.` };
    }
    if (state.fetchedAt == null) {
      // Present but undateable. Treating it as fresh would be the system deciding that an unknown
      // age is a young one, which is the assumption this project refuses everywhere else.
      return { ...item, status: "age_unknown", detail: "On the device, but its age is not recorded, so nothing here can say whether it is still true." };
    }
    if (item.staleAfterMinutes == null) {
      return { ...item, status: "ready", detail: "On the device. This record does not go stale." };
    }
    const ageMinutes = Math.floor((now.getTime() - state.fetchedAt.getTime()) / 60_000);
    if (ageMinutes > item.staleAfterMinutes) {
      return { ...item, status: "stale", detail: `Cached ${ageMinutes} minutes ago; trusted for ${item.staleAfterMinutes}. Fetch it again before leaving.` };
    }
    return { ...item, status: "ready", detail: `Cached ${ageMinutes} minutes ago.` };
  });

  const bad = (i: EvaluatedItem) => i.status !== "ready";
  const blocking = evaluated.filter(i => i.necessity === "required_to_depart" && bad(i));
  const neededOnSite = evaluated.filter(i => i.necessity === "required_on_site" && bad(i));

  return {
    mayDepart: blocking.length === 0,
    items: evaluated,
    blocking,
    neededOnSite,
    explanation: blocking.length === 0
      ? neededOnSite.length === 0
        ? "Everything this job needs is on the device."
        : `Ready to leave. ${neededOnSite.length} item(s) will be needed on site and are not cached: ${neededOnSite.map(i => i.label).join(", ")}.`
      // Named, never counted: a percentage tells a driver nothing he can act on.
      : `Not ready: ${blocking.map(i => `${i.label} (${i.status})`).join("; ")}.`,
  };
}

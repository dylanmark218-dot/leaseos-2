/**
 * v22.19 — The offline communication package.
 *
 * Pure. No network, no database.
 *
 * Everything built so far assumes a server the truck can reach. The product
 * premise is that it cannot: the road where the communication plan matters most
 * is the road where nothing can be fetched. So the plan is sealed before
 * departure and carried.
 *
 * A package is a snapshot, not a view. It is built once, hashed, and never
 * edited — because a driver 60 km up a resource road is acting on what they
 * downloaded this morning, and a record that quietly changed underneath them
 * would make the evidence trail a lie. When the world moves, the package does
 * not: it goes **stale**, by arithmetic, and dispatch can see who is carrying
 * which version.
 *
 * The other half of the design is what the package says about itself. A driver
 * offline cannot ask a question, so the package has to answer the obvious ones
 * before it leaves: which channels in here are unverified, which kilometres
 * have no channel at all, what was deliberately left out. A package that
 * presents 99 confident-looking frequencies without saying that none of them
 * has been checked against the regulator is worse than no package.
 */

import { createHash } from "node:crypto";
import type {
  AuthorityTier, CommunicationsPlan, CoverageObservation, RadioChannel,
  RoadRadioAssignment, TransmitStatus,
} from "./commRoute";

/* ------------------------------------------------------------------ */
/* Canonical hashing                                                    */
/* ------------------------------------------------------------------ */

/** Key order and dates normalized, so the same facts hash the same way twice. */
export function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export const hashOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/* ------------------------------------------------------------------ */
/* What a driver carries                                                */
/* ------------------------------------------------------------------ */

/** One channel, as it is usable with no server: enough to select it and nothing implied beyond that. */
export type PackagedChannel = {
  channelKey: string;
  alias: string;
  rxMHz: number | null;
  txMHz: number | null;
  toneRxHz: number | null;
  toneTxHz: number | null;
  systemType: string;
  serviceClass: string;
  licenceRequired: boolean;
  /** Copied verbatim so the caveat travels with the frequency, never apart from it. */
  verificationStatus: "unverified" | "verified" | "superseded";
  /** The company's transmit answer at seal time, and the reason, so offline it still says why. */
  transmit: TransmitStatus;
  transmitReasons: string[];
};

export type PackagedZone = {
  fromKm: number;
  toKm: number;
  roadName: string | null;
  channelKey: string | null;
  authorityTier: AuthorityTier | null;
  transmit: TransmitStatus;
  callDirectionLoaded: "increasing_km" | "decreasing_km" | null;
  callIntervalKm: number | null;
  mustCallKm: number[];
  unknownReason: string | null;
};

export type PackageContent = {
  formatVersion: 1;
  routeRef: string | null;
  totalKm: number;
  verdict: CommunicationsPlan["verdict"];
  zones: PackagedZone[];
  channels: PackagedChannel[];
  changes: { atKm: number; from: string | null; to: string | null; note: string }[];
  mustCall: { atKm: number; channelKey: string | null; roadName: string | null }[];
  coverage: CommunicationsPlan["coverage"];
  ladder: CommunicationsPlan["ladder"];
  /** What this package does not contain, in the words a driver can act on. */
  caveats: string[];
  /** The standing safety statement. A radio is not a substitute for safe driving. */
  standingNotice: string;
};

export const STANDING_NOTICE =
  "Radio-assisted road. The channel posted on the road governs over this package. Do not rely on radio communication alone for safe travel.";

export type SealInput = {
  plan: CommunicationsPlan;
  channels: readonly RadioChannel[];
  assignments: readonly RoadRadioAssignment[];
  coverage?: readonly CoverageObservation[];
  routeRef?: string | null;
};

export type SealedPackage = {
  content: PackageContent;
  manifestHash: string;
  counts: {
    zones: number;
    channels: number;
    unverifiedChannels: number;
    retiredExcluded: number;
    mustCall: number;
    zonesWithoutChannel: number;
  };
};

/**
 * Seal the package. Only the channels the route actually names are carried —
 * a driver does not need 99 frequencies to drive one road, and shipping the
 * whole bank invites selecting one that does not belong to the road they are on.
 *
 * A retired service is dropped rather than carried with a warning: there is no
 * circumstance in which a driver offline should be choosing it, and a warning
 * they can scroll past is weaker than its absence.
 */
export function sealCommunicationPackage(input: SealInput): SealedPackage {
  const byKey = new Map(input.channels.map(c => [c.channelKey, c]));
  const named = Array.from(new Set(input.plan.zones.map(z => z.channelKey).filter((k): k is string => !!k)));

  let retiredExcluded = 0;
  const channels: PackagedChannel[] = [];
  for (const key of named.sort()) {
    const c = byKey.get(key);
    if (!c) continue;
    if (c.serviceStatus === "retired") { retiredExcluded += 1; continue; }
    const zone = input.plan.zones.find(z => z.channelKey === key)!;
    channels.push({
      channelKey: c.channelKey, alias: c.alias, rxMHz: c.rxMHz, txMHz: c.txMHz,
      toneRxHz: c.toneRxHz ?? null, toneTxHz: c.toneTxHz ?? null,
      systemType: c.systemType, serviceClass: c.serviceClass, licenceRequired: c.licenceRequired,
      // All three states survive. A superseded record is not merely unverified —
      // it was once part of the record chain and has since been displaced, and
      // that distinction is the point of an audit product.
      verificationStatus: c.verificationStatus,
      transmit: zone.transmit, transmitReasons: zone.transmitReasons,
    });
  }

  const zones: PackagedZone[] = input.plan.zones.map(z => ({
    fromKm: z.fromKm, toKm: z.toKm, roadName: z.roadName, channelKey: z.channelKey,
    authorityTier: z.authorityTier, transmit: z.transmit,
    callDirectionLoaded: z.callDirectionLoaded, callIntervalKm: z.callIntervalKm,
    mustCallKm: [...z.mustCallKm], unknownReason: z.unknownReason,
  }));

  /* What is missing, said plainly, because offline nobody can be asked. */
  const caveats: string[] = [];
  const unverified = channels.filter(c => c.verificationStatus === "unverified");
  if (unverified.length) caveats.push(`${unverified.length} of ${channels.length} channel(s) in this package are unverified against the regulator's publication: ${unverified.map(c => c.channelKey).join(", ")}. Treat the posted sign as the answer.`);
  if (input.plan.unknownChannelKm > 0) caveats.push(`${input.plan.unknownChannelKm} km of this route has no channel on record. That is not "no radio needed" — it is not known.`);
  if (input.plan.noCommunicationKm > 0) caveats.push(`${input.plan.noCommunicationKm} km with no established communication of any kind.`);
  const cellUnknown = input.plan.coverage.find(c => c.medium === "cellular")?.unknownKm ?? 0;
  if (cellUnknown > 0) caveats.push(`${cellUnknown} km with no cellular coverage data. Absence of data is not absence of service, and it is not presence of service either.`);
  if (retiredExcluded > 0) caveats.push(`${retiredExcluded} channel(s) named by this route are retired services and were left out of this package.`);
  // `not_authorized` is not the only way a zone fails to be authorized, and
  // checking only for it let a route whose transmit answer was UNKNOWN fall
  // through to "Every channel on this route is verified, authorized and
  // carried" — a false statement, and exactly the shape of claim the
  // unknown-is-never-clear invariant exists to prevent.
  const notAuthorized = zones.filter(z => z.transmit === "not_authorized");
  const unknownTransmit = zones.filter(z => z.transmit === "unknown");
  const requiresPosted = zones.filter(z => z.transmit === "requires_posted_channel");
  if (notAuthorized.length) caveats.push(`${notAuthorized.length} zone(s) this company is not authorized to transmit on.`);
  if (unknownTransmit.length) caveats.push(`${unknownTransmit.length} zone(s) have UNKNOWN transmit authorization — not established, and not a permission.`);
  if (requiresPosted.length) caveats.push(`${requiresPosted.length} zone(s) require the channel to be confirmed from the posted road sign before transmitting.`);
  const everyZoneAuthorized = zones.length > 0 && zones.every(z => z.transmit === "authorized");
  if (!caveats.length && everyZoneAuthorized) caveats.push("Every channel on this route is verified, authorized and carried. The posted sign still governs.");
  else if (!caveats.length) caveats.push("This package makes no claim that its channels are authorized.");

  const content: PackageContent = {
    formatVersion: 1,
    routeRef: input.routeRef ?? null,
    totalKm: input.plan.totalKm,
    verdict: input.plan.verdict,
    zones, channels,
    changes: input.plan.changes,
    mustCall: input.plan.mustCall,
    coverage: input.plan.coverage,
    ladder: input.plan.ladder,
    caveats,
    standingNotice: STANDING_NOTICE,
  };

  return {
    content,
    manifestHash: hashOf(content),
    counts: {
      zones: zones.length,
      channels: channels.length,
      unverifiedChannels: unverified.length,
      retiredExcluded,
      mustCall: content.mustCall.length,
      zonesWithoutChannel: zones.filter(z => !z.channelKey).length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Staleness                                                            */
/* ------------------------------------------------------------------ */

/**
 * What the package stood on. Deliberately the same shape of idea as the route
 * approval's fingerprint: change any one part and the package is out of date by
 * arithmetic, not by somebody remembering to rebuild it.
 */
export type PackageDependencies = {
  /** The channel governing each segment, and who says so. */
  assignments: string;
  /** The channel records themselves — a frequency corrected is a different package. */
  channelRecords: string;
  /** Coverage evidence over those segments. */
  coverage: string;
  /** The segments the route runs over, in route order. */
  segments: string;
  /**
   * v22.20 — the physical geometry and jurisdiction those regulatory decisions
   * stood on. A survey correction moving a node from 53.5100N to 53.4900N flips
   * LAD-1 from authorized to excluded while the segment id, the assignment, the
   * frequency record and the coverage all stay identical — so without this the
   * arithmetic said CURRENT about a package whose radio answer had changed.
   */
  geography: string;
};

export const DEPENDENCY_LABELS: Record<keyof PackageDependencies, string> = {
  assignments: "the channels assigned to these roads",
  channelRecords: "the channel records themselves",
  coverage: "the coverage recorded for these roads",
  segments: "the route's ordered segments",
  geography: "the road geometry or jurisdiction used to evaluate radio authorization",
};

export function packageDependencies(args: {
  segmentIds: readonly string[];
  assignments: readonly RoadRadioAssignment[];
  channels: readonly RadioChannel[];
  coverage?: readonly CoverageObservation[];
  /**
   * The channel keys to hash records over. When recomputing for a sealed
   * package, pass the keys that package carried — otherwise a confirmed sign
   * changes which channels are named, and `channelRecords` fires too, telling a
   * dispatcher a frequency was corrected when none was. The two dependencies
   * answer different questions and must be able to move independently.
   */
  channelKeys?: readonly string[];
  /** From resolveRouteCommunicationGeography. Absent means no geography was resolved. */
  geographyHash?: string | null;
}): PackageDependencies {
  const named = new Set(args.channelKeys ?? args.assignments.map(a => a.channelKey));
  return {
    // Route order is part of the route. Sorting made an out-and-back and its
    // reverse the same dependency, which they are not.
    segments: hashOf([...args.segmentIds]),
    assignments: hashOf(args.assignments.map(a => ({ ref: a.assignmentRef, seg: a.segmentId, ch: a.channelKey, tier: a.authorityTier, from: a.effectiveFrom ?? null, to: a.effectiveTo ?? null, status: a.verificationStatus })).sort((x, y) => x.ref.localeCompare(y.ref))),
    channelRecords: hashOf(args.channels.filter(c => named.has(c.channelKey)).map(c => ({ key: c.channelKey, rx: c.rxMHz, tx: c.txMHz, tone: [c.toneRxHz ?? null, c.toneTxHz ?? null], status: c.verificationStatus, service: c.serviceStatus ?? "active" })).sort((x, y) => x.key.localeCompare(y.key))),
    // A package sealed before geography existed carries no hash, and must read
    // stale against any package built with one — never silently equivalent.
    geography: hashOf(args.geographyHash ?? null),
    coverage: hashOf((args.coverage ?? []).map(c => ({ seg: c.segmentId, medium: c.medium, state: c.state, tier: c.authorityTier, status: c.verificationStatus })).sort((x, y) => `${x.seg}${x.medium}`.localeCompare(`${y.seg}${y.medium}`))),
  };
}

export const dependencyHash = (d: PackageDependencies): string => hashOf(d);

export type PackageStaleness = {
  stale: boolean;
  changed: (keyof PackageDependencies)[];
  /** In a dispatcher's words, because this becomes "tomorrow's trip affected". */
  reasons: string[];
};

export function packageStaleness(sealed: PackageDependencies, current: PackageDependencies): PackageStaleness {
  const changed = (Object.keys(sealed) as (keyof PackageDependencies)[]).filter(k => sealed[k] !== current[k]);
  return {
    stale: changed.length > 0,
    changed,
    reasons: changed.map(k => `${DEPENDENCY_LABELS[k]} changed since this package was built`),
  };
}

/* ------------------------------------------------------------------ */
/* What is in the field                                                 */
/* ------------------------------------------------------------------ */

export type CarriedState = "current" | "behind" | "stale" | "none";

/**
 * What a driver is actually carrying, against what exists now. `behind` and
 * `stale` are different facts: behind means a newer package was built, stale
 * means the world moved under the one they hold. A driver can be current and
 * stale at the same time — nobody has rebuilt yet — and that is the case
 * dispatch most needs to see.
 */
export function carriedState(args: {
  carriedManifestHash: string | null;
  currentManifestHash: string | null;
  currentIsStale: boolean;
}): { state: CarriedState; note: string } {
  if (!args.carriedManifestHash) return { state: "none", note: "No communication package has been taken onto a device for this route" };
  if (args.carriedManifestHash !== args.currentManifestHash) return { state: "behind", note: "A newer package has been built — the device is carrying an earlier one" };
  if (args.currentIsStale) return { state: "stale", note: "The package on the device is the latest built, and the latest built is out of date — rebuild it before departure" };
  return { state: "current", note: "The device is carrying the current package" };
}

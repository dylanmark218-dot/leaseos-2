import { createHash } from "node:crypto";

/**
 * The trip passport package, assembled after a round trip closes.
 *
 * The rule this file exists to enforce: a package that cannot prove something
 * says so on its own cover. There is no state in which a missing manifest, an
 * unverified disposal ticket or an unanswered applicability question produces a
 * sealable package — the verdict degrades, the gap is named, and a person
 * decides whether to release it anyway.
 *
 * Applicability is the subtle case. "Does this trip need a weight record?" has
 * three answers, and the third is `unknown`. An unknown requirement is treated
 * as REQUIRED and reported as unresolved, because the alternative — quietly
 * classifying it not-applicable — is how a package comes to certify a trip
 * nobody actually checked.
 *
 * Staleness is detected, never repaired. A package is a snapshot of the inputs
 * at the moment it was built; when those inputs move, the package is marked
 * stale and somebody rebuilds it. Nothing rebuilds on its own, and no
 * notification reaches a driver who has already left.
 */

export type PackageItemKind =
  | "manifest"
  | "load_ticket"
  | "disposal_ticket"
  | "duty_record"
  | "pre_trip_inspection"
  | "field_ticket_signature"
  | "weight_record"
  | "route_approval";

/** Whether this trip needs the item at all. `unknown` is not a soft no. */
export type Applicability = "required" | "not_applicable" | "unknown";

export type ItemState =
  | "present_verified"
  | "present_unverified"
  | "missing"
  | "applicability_unresolved"
  | "not_applicable";

export type PackageItemInput = {
  kind: PackageItemKind;
  /**
   * Assigned by the caller from the trip's own structure — "disposal_ticket:stop-2",
   * never the artifact's reference. It exists whether or not the artifact does,
   * which is the point: a missing item still has to be nameable.
   */
  itemRef: string;
  applicability: Applicability;
  /** Why it applies — the rule or the fact, so a reader can check the call. */
  applicabilityBasis: string;
  /** Null when the artifact does not exist. */
  reference: string | null;
  verified: boolean;
  /** Last change to the underlying record; drives staleness. */
  updatedAt: Date | null;
};

export type PackageItem = {
  kind: PackageItemKind;
  /** The caller's slot identity, carried through so a reason can name which one. */
  itemRef: string;
  state: ItemState;
  applicability: Applicability;
  applicabilityBasis: string;
  reference: string | null;
  /** What has to happen for this item to stop blocking. Null when it does not block. */
  blocks: string | null;
};

export type PackageVerdict = "sealable" | "incomplete" | "unresolved";

export type TripPassportPackage = {
  tripId: number;
  tripNumber: string;
  verdict: PackageVerdict;
  items: PackageItem[];
  /** Named gaps, in the order an office would work them. */
  gaps: string[];
  builtAt: Date;
  /** Identity of the inputs this package was built from. */
  inputsHash: string;
  /** A package is only as current as its last rebuild. */
  status: "current" | "stale";
  staleReasons: string[];
};

const LABEL: Record<PackageItemKind, string> = {
  manifest: "Manifest",
  load_ticket: "Load ticket",
  disposal_ticket: "Disposal ticket",
  duty_record: "Duty record",
  pre_trip_inspection: "Pre-trip inspection",
  field_ticket_signature: "Field ticket signature",
  weight_record: "Weight record",
  route_approval: "Route approval",
};

/*
 * Sorted by `itemRef`, which is unique per package and therefore a total order.
 * Sorting by `kind` was not: `Array.prototype.sort` is stable, so two trips
 * carrying the same two disposal tickets in different input order hashed
 * differently and the package reported staleness that had not happened.
 */
function canonical(items: PackageItemInput[]): string {
  return JSON.stringify(
    [...items]
      .sort((a, b) => a.itemRef.localeCompare(b.itemRef))
      .map(i => [i.itemRef, i.kind, i.applicability, i.reference ?? "", i.verified, i.updatedAt?.toISOString() ?? ""]),
  );
}

export const hashInputs = (items: PackageItemInput[]) =>
  createHash("sha256").update(canonical(items)).digest("hex");

function classify(input: PackageItemInput): PackageItem {
  const label = LABEL[input.kind];

  if (input.applicability === "unknown") {
    return {
      kind: input.kind,
      itemRef: input.itemRef,
      state: "applicability_unresolved",
      applicability: "unknown",
      applicabilityBasis: input.applicabilityBasis,
      reference: input.reference,
      blocks: `decide whether ${label.toLowerCase()} is required for this trip — ${input.applicabilityBasis}`,
    };
  }

  if (input.applicability === "not_applicable") {
    return {
      kind: input.kind,
      itemRef: input.itemRef,
      state: "not_applicable",
      applicability: "not_applicable",
      applicabilityBasis: input.applicabilityBasis,
      reference: input.reference,
      blocks: null,
    };
  }

  if (input.reference === null) {
    return {
      kind: input.kind,
      itemRef: input.itemRef,
      state: "missing",
      applicability: "required",
      applicabilityBasis: input.applicabilityBasis,
      reference: null,
      blocks: `obtain the ${label.toLowerCase()} — ${input.applicabilityBasis}`,
    };
  }

  return input.verified
    ? {
      kind: input.kind,
      itemRef: input.itemRef,
      state: "present_verified",
      applicability: "required",
      applicabilityBasis: input.applicabilityBasis,
      reference: input.reference,
      blocks: null,
    }
    : {
      kind: input.kind,
      itemRef: input.itemRef,
      state: "present_unverified",
      applicability: "required",
      applicabilityBasis: input.applicabilityBasis,
      reference: input.reference,
      blocks: `verify ${label.toLowerCase()} ${input.reference}`,
    };
}

/**
 * Assemble the package.
 *
 * `completedAt === null` is not an error — it is an open trip, and an open trip
 * has no package. The caller gets an `unresolved` verdict naming that fact
 * rather than a half-built artifact.
 */
export function buildTripPassportPackage(args: {
  tripId: number;
  tripNumber: string;
  completedAt: Date | null;
  items: PackageItemInput[];
  builtAt?: Date;
}): TripPassportPackage {
  const builtAt = args.builtAt ?? new Date();

  /*
   * Duplicate slot identities are refused rather than assembled. Collapsing them
   * is the defect this identity exists to remove, and a build that quietly kept
   * the last of each would be a quieter version of the same bug — the package
   * would look complete while describing fewer artifacts than the trip carries.
   *
   * Checked BEFORE the open-trip branch below, deliberately. The two are not the
   * same kind of fact: an open trip is a legitimate state every trip passes
   * through, which recurs and resolves on its own, while a duplicate itemRef is
   * never legitimate — it is a fault in whatever assembled the input. A transient
   * state must not hide a permanent defect, and the masking would be worst-case
   * in timing: a trip is open for its whole duration, so the clash would stay
   * invisible until completion, which is exactly when the office is closing out
   * and the driver has gone. The verdict is `unresolved` either way, so all that
   * is really at stake is which gap somebody reads, and the clash is the one they
   * can act on.
   */
  const counts: Record<string, number> = {};
  for (const i of args.items) counts[i.itemRef] = (counts[i.itemRef] ?? 0) + 1;
  const duplicates = Object.keys(counts).filter(ref => counts[ref] > 1).sort();
  if (duplicates.length > 0) {
    return {
      tripId: args.tripId,
      tripNumber: args.tripNumber,
      verdict: "unresolved",
      items: [],
      gaps: duplicates.map(ref => `two or more inputs share the slot identity ${ref} — give each artifact its own itemRef before assembling`),
      builtAt,
      inputsHash: hashInputs(args.items),
      status: "current",
      staleReasons: [],
    };
  }

  if (args.completedAt === null) {
    return {
      tripId: args.tripId,
      tripNumber: args.tripNumber,
      verdict: "unresolved",
      items: [],
      gaps: [`Trip ${args.tripNumber} has not completed — no package is assembled from an open trip`],
      builtAt,
      inputsHash: hashInputs(args.items),
      status: "current",
      staleReasons: [],
    };
  }

  const items = args.items.map(classify);
  const gaps = items.filter(i => i.blocks !== null).map(i => i.blocks as string);

  const anyUnresolved = items.some(i => i.state === "applicability_unresolved");
  const anyIncomplete = items.some(i => i.state === "missing" || i.state === "present_unverified");

  const verdict: PackageVerdict = anyUnresolved ? "unresolved" : anyIncomplete ? "incomplete" : "sealable";

  return {
    tripId: args.tripId,
    tripNumber: args.tripNumber,
    verdict,
    items,
    gaps,
    builtAt,
    inputsHash: hashInputs(args.items),
    status: "current",
    staleReasons: [],
  };
}

/**
 * Re-check a built package against the inputs as they stand now.
 *
 * Returns the package marked stale with the specific items that moved. It does
 * not rebuild: a rebuilt package is a new artifact with a new hash, and the
 * decision to produce one belongs to a person.
 */
export function detectStaleness(
  built: TripPassportPackage,
  currentItems: PackageItemInput[],
): TripPassportPackage {
  const nowHash = hashInputs(currentItems);
  if (nowHash === built.inputsHash) return built;

  /*
   * Keyed on `itemRef`, not on `kind`. A trip carrying two disposal tickets has
   * two items of one kind, and a Map keyed on the kind kept only the last of
   * them — so both current tickets were compared against one prior row, which
   * reported reference changes that had not happened and could not say which
   * ticket a real change belonged to.
   */
  const before = new Map(built.items.map(i => [i.itemRef, i]));
  const reasons: string[] = [];
  const name = (i: { kind: PackageItemKind; itemRef: string }) => `${LABEL[i.kind]} ${i.itemRef}`;

  for (const item of currentItems) {
    const prior = before.get(item.itemRef);
    if (!prior) { reasons.push(`${name(item)} was added after this package was built`); continue; }
    if ((prior.reference ?? null) !== (item.reference ?? null)) {
      reasons.push(`${name(item)} reference changed (${prior.reference ?? "none"} → ${item.reference ?? "none"})`);
    }
    const wasVerified = prior.state === "present_verified";
    if (wasVerified !== item.verified) {
      reasons.push(`${name(item)} verification changed (${wasVerified ? "verified" : "unverified"} → ${item.verified ? "verified" : "unverified"})`);
    }
    if (prior.applicability !== item.applicability) {
      reasons.push(`${name(item)} applicability changed (${prior.applicability} → ${item.applicability})`);
    }
  }

  // Iterating `built.items` rather than `before.keys()`: a Map iterator needs
  // downlevelIteration under this repository's target, which sets no `target`
  // field and therefore compiles as ES5.
  for (const prior of built.items) {
    if (!currentItems.some(i => i.itemRef === prior.itemRef)) reasons.push(`${name(prior)} is no longer present among the inputs`);
  }

  return {
    ...built,
    status: "stale",
    staleReasons: reasons.length > 0 ? reasons : ["the package inputs changed after it was built"],
  };
}

/**
 * Whether a package may be released without an explicit acknowledgement of its
 * gaps. Only a sealable, current package may.
 */
export function mayReleaseWithoutAcknowledgement(pkg: TripPassportPackage): boolean {
  return pkg.verdict === "sealable" && pkg.status === "current";
}

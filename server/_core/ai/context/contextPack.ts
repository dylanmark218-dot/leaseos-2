/**
 * The small slice of the company a model is allowed to see.
 *
 * Code assembles this, not the model, and the shape is the whole point: every
 * item is an `{ id, kind, label, value }` projection, never a row. A model that
 * is handed rows can quote a column somebody forgot was in the select; a model
 * handed projections can only quote what was deliberately projected, and can
 * only cite an id that is in the pack — `server/ai/validate` rejects an
 * `evidenceRef` that is not.
 *
 * **What may never enter a pack.** The restricted records vault and driver
 * medical records are outside the operations perimeter, and a prompt is not a
 * place to find out whether that held. Eligibility is the only answer that
 * crosses: yes, no, or unknown, with no underlying fact attached. "This driver
 * may operate" is an operational fact. *Why* is a medical record, and the
 * Secretary has no business with it at any confidence level.
 *
 * That rule is enforced two ways, because a comment is not an enforcement.
 * `EligibilityAnswer` is a three-value union with nowhere to put a reason, and
 * `server/ai/contextPerimeter.test.ts` reads this file's source and fails if it
 * ever imports a restricted-vault or medical table. The second guard is the one
 * that survives somebody adding a field in good faith.
 *
 * **`unknown` is not `no`.** A capability that was never asked — because the
 * module is off, or no data source is loaded — is `unknown`, and the validator
 * turns that into `NOT_EVALUATED` rather than a fail. Collapsing the two is the
 * "missing ≠ expired" mistake the rest of this system refuses to make.
 */

/** Three values, and a reason has nowhere to live. That is deliberate. */
export type EligibilityAnswer = "yes" | "no" | "unknown";

export type ContextItemKind =
  | "trip"
  | "stop"
  | "open_ticket"
  | "unit"
  | "unit_capacity"
  | "facility"
  | "geofence_arrival"
  | "eligibility"
  | "form";

/**
 * One fact, with the id the model must cite to claim it inferred anything from
 * it. Ids are short and stable so a quote-check failure is readable.
 */
export type ContextItem = {
  id: string;
  kind: ContextItemKind;
  label: string;
  value: string | number | boolean | null;
};

export type ContextPack = {
  /** The form being filled. Nothing else is on offer. */
  formKey: string;
  formVersion: number;
  items: ContextItem[];
  /**
   * Whether the vehicle is moving right now. The dialogue machine holds
   * questions until it stops; it is here rather than in the dialogue state
   * because it is a fact about the world, not about the conversation.
   */
  vehicleMoving: boolean;
};

export type ContextPackInput = {
  formKey: string;
  formVersion: number;
  tripRef?: string | null;
  currentStopRef?: string | null;
  /** Ticket numbers currently open for this trip. Numbers only, never rows. */
  openTicketNumbers?: readonly string[];
  unitNumber?: string | null;
  /**
   * The unit's tank capacity in litres, when the fleet records one.
   *
   * The survey found that `units` has no capacity column — `capacityLitres`
   * belongs to `bulkFuelTanks`, which is a fuel depot, not a vacuum tank. So
   * this is optional and its absence is honest: the over-capacity check
   * reports NOT_EVALUATED rather than inventing a ceiling to pass against.
   */
  unitTankCapacityLitres?: number | null;
  facilityName?: string | null;
  /** A geofence arrival, when telematics saw one. Proposed, never applied. */
  geofenceArrivalLocal?: string | null;
  /** Operational eligibility only. Never the fact underneath it. */
  driverMayOperate?: EligibilityAnswer;
  vehicleMoving?: boolean;
};

/**
 * Build a pack. Pure: the caller does the reading and hands in projections,
 * which is why this file imports no schema, no database and no router.
 *
 * Keeping it pure is not tidiness. It means the perimeter test can read one
 * short file and prove a negative about it, and it means the pack a model saw
 * can be reconstructed exactly from a proposal's stored input hash.
 */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const items: ContextItem[] = [
    { id: "form", kind: "form", label: "Form", value: input.formKey },
  ];

  if (input.tripRef) {
    items.push({ id: "trip", kind: "trip", label: "Trip", value: input.tripRef });
  }
  if (input.currentStopRef) {
    items.push({ id: "stop", kind: "stop", label: "Current stop", value: input.currentStopRef });
  }
  if (input.unitNumber) {
    items.push({ id: "unit", kind: "unit", label: "Unit", value: input.unitNumber });
  }
  if (typeof input.unitTankCapacityLitres === "number") {
    items.push({
      id: "unit_capacity",
      kind: "unit_capacity",
      label: "Unit tank capacity (L)",
      value: input.unitTankCapacityLitres,
    });
  }
  if (input.facilityName) {
    items.push({ id: "facility", kind: "facility", label: "Facility", value: input.facilityName });
  }
  // A plain index loop: the project's tsconfig targets below ES2015, so
  // iterating an array iterator does not compile here.
  const tickets = input.openTicketNumbers ?? [];
  for (let i = 0; i < tickets.length; i++) {
    items.push({
      id: `open_ticket_${i + 1}`,
      kind: "open_ticket",
      label: "Open ticket",
      value: tickets[i],
    });
  }
  if (input.geofenceArrivalLocal) {
    items.push({
      id: "geofence_arrival",
      kind: "geofence_arrival",
      label: "Geofence arrival (local)",
      value: input.geofenceArrivalLocal,
    });
  }
  if (input.driverMayOperate) {
    items.push({
      id: "eligibility_operate",
      kind: "eligibility",
      label: "Driver may operate",
      value: input.driverMayOperate,
    });
  }

  return {
    formKey: input.formKey,
    formVersion: input.formVersion,
    items,
    vehicleMoving: input.vehicleMoving === true,
  };
}

/** The ids a model may cite. An `evidenceRef` outside this set is rejected. */
export const contextRefs = (pack: ContextPack): Set<string> =>
  new Set(pack.items.map(i => i.id));

/** Render the pack for a prompt. Plain, labelled, and nothing that reads as an order. */
export function renderContextPack(pack: ContextPack): string {
  return pack.items.map(i => `- ${i.id}: ${i.label} = ${String(i.value)}`).join("\n");
}

/** The capacity ceiling, if the fleet records one. `null` means NOT_EVALUATED. */
export function tankCapacityLitres(pack: ContextPack): number | null {
  const item = pack.items.find(i => i.kind === "unit_capacity");
  return typeof item?.value === "number" ? item.value : null;
}

/** Ticket numbers currently open, for the prefix and membership checks. */
export const openTicketNumbers = (pack: ContextPack): string[] =>
  pack.items
    .filter(i => i.kind === "open_ticket" && typeof i.value === "string")
    .map(i => String(i.value));

/** The geofence arrival, when telematics saw one. Proposed for confirmation. */
export function geofenceArrival(pack: ContextPack): string | null {
  const item = pack.items.find(i => i.kind === "geofence_arrival");
  return typeof item?.value === "string" ? item.value : null;
}

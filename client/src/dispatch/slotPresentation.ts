/**
 * The single place a slot's server status becomes a word on the screen.
 *
 * `readinessPresentation.ts` exists because a readiness verdict must not be restated by whoever is
 * drawing it. This is the same rule for the other half of the detail screen, and it matters more
 * here than styling usually does.
 *
 * Design §16 asks for three visibly distinct states: **Assigned** — this module — and **Ready** and
 * **Awarded**, which belong to the readiness panel and to the award. They are produced by different
 * subsystems and answer different questions: a slot can be filled by a crew who are blocked from
 * driving, and a posting can be staffed without having been awarded to anyone. The canonical
 * assignment subsystem exists because one procedure used to conflate assignment with award; a badge
 * reading "Awarded" or "Ready to go" over a filled slot would reintroduce exactly that conflation
 * in the one place nobody tests — so the vocabulary is asserted, not merely chosen.
 *
 * Nothing here computes. It maps a status to words, or admits it cannot.
 */

/** Exactly `dispatchRoles.status`, in the order the enum declares it. */
export const SLOT_STATUSES = ["open", "invited", "bid_received", "assigned", "cancelled"] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/**
 * How the slot stands as a container for a crew — deliberately not the status itself, because the
 * screen groups by whether somebody is bound and the status carries more detail than that.
 *
 * `withdrawn` is kept apart from `unfilled` on purpose: staffing excludes a cancelled slot and
 * counts an open one, so drawing them alike would misstate what the posting still needs.
 */
export type SlotFill = "unfilled" | "filled" | "withdrawn" | "unavailable";

export type PresentedSlot = {
  fill: SlotFill;
  label: string;
  meaning: string;
};

export const isSlotStatus = (s: string): s is SlotStatus =>
  (SLOT_STATUSES as readonly string[]).includes(s);

/**
 * A status this build has never heard of. Echoing the raw token would be noise a dispatcher cannot
 * act on, and guessing at it would be a fabrication, so the screen says it cannot say.
 */
export const UNAVAILABLE_SLOT: PresentedSlot = {
  fill: "unavailable",
  label: "Unavailable",
  meaning:
    "This build does not recognise the status the server sent for this slot, so it will not " +
    "describe it rather than guess at what it means.",
};

const SLOT: Record<SlotStatus, PresentedSlot> = {
  open: {
    fill: "unfilled",
    label: "Unfilled",
    meaning: "Nobody is bound to this slot. A dispatcher can bind a crew to it from here.",
  },
  invited: {
    fill: "unfilled",
    label: "Invited",
    meaning: "A carrier has been invited to this slot. Nobody is bound to it yet.",
  },
  bid_received: {
    fill: "unfilled",
    label: "Bid received",
    meaning:
      "A bid has arrived for this slot. Nobody is bound to it yet, and choosing between bids " +
      "happens elsewhere, not on this screen.",
  },
  assigned: {
    fill: "filled",
    label: "Filled",
    meaning:
      "A crew is bound to this slot. Whether they may be dispatched is a separate question, " +
      "which the readiness panel below answers on its own evidence.",
  },
  cancelled: {
    fill: "withdrawn",
    label: "Withdrawn",
    meaning:
      "This slot was withdrawn and is no longer part of what this posting needs. It is shown " +
      "because it happened, not because it is outstanding.",
  },
};

export function presentSlot(status: string): PresentedSlot {
  return isSlotStatus(status) ? SLOT[status] : UNAVAILABLE_SLOT;
}

/**
 * Required or optional — the staffing question, and separate from the fill on purpose.
 *
 * `assessStaffing` counts only required roles, so an optional slot left open is not a deficiency
 * and must not be worded as one. The two questions cross: a required slot can be unfilled and an
 * optional slot can be filled, and the screen has to be able to say each of the four.
 */
export function presentRequirement(required: boolean): { label: string; meaning: string } {
  return required
    ? {
        label: "Required",
        meaning: "This slot must be filled before the posting counts as fully staffed.",
      }
    : {
        label: "Optional",
        meaning: "Useful when filled, but the posting's staffing does not depend on it.",
      };
}

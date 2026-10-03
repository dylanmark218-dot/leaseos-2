/**
 * SPINE item 2 — the one definition of "is this resource already booked over this window?"
 *
 * Two production paths ask it, at different moments and for different reasons, and both are
 * legitimate:
 *
 *   - **open-shift eligibility** (`openShiftsRouter.personFacts` → `openShifts.shiftEligibility`)
 *     asks whether a person should even be shown a shift as one they could take;
 *   - **the award** (`dispatchTransaction.awardAssignment` → `dispatchAward.decideAward`) asks again,
 *     inside the transaction, immediately before it writes a booking. State can change between the
 *     two, so the award's re-check is a final revalidation, not a duplicate — and it must not be
 *     removed because eligibility ran earlier.
 *
 * What may not differ between them is the RULE. Before this module each carried its own copy: the
 * award's SQL, the open-shift router's SQL, and an in-memory `overlaps` in the engine. They agreed
 * by coincidence. Now all three come from here:
 *
 *   - a booking holds its resource only while it is `tentative` or `confirmed`
 *     (`released` and `cancelled` bookings hold nothing);
 *   - windows are half-open: one ending at 15:30 does not conflict with one starting at 15:30;
 *   - a resource is identified by type AND ref, so operator 5 never collides with unit 5.
 *
 * Which conflicts a caller then ignores is the caller's business, not the rule's: the award skips
 * a booking on the posting it is awarding (re-awarding its own slot is not a conflict).
 */
import { and, eq, gt, inArray, lt, type SQL } from "drizzle-orm";
import { resourceBookings } from "../../drizzle/schema";

/** The booking states that hold a resource. Every other state releases it. */
export const ACTIVE_BOOKING_STATES = ["tentative", "confirmed"] as const;

export type BookingWindow = { startsAt: Date; endsAt: Date };

/** Half-open overlap: touching windows do not conflict. */
export function windowsOverlap(a: BookingWindow, b: BookingWindow): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

/** Whether a booking in this state holds its resource. */
export function bookingHoldsResource(state: string): boolean {
  return (ACTIVE_BOOKING_STATES as readonly string[]).includes(state);
}

/** The pure rule, for a booking already in hand: same resource, holding it, and overlapping. */
export function bookingConflicts(
  booking: { resourceType: string; resourceRef: string; bookingState: string } & BookingWindow,
  resource: { type: string; ref: string },
  window: BookingWindow,
): boolean {
  return booking.resourceType === resource.type && booking.resourceRef === resource.ref
    && bookingHoldsResource(booking.bookingState) && windowsOverlap(booking, window);
}

/**
 * The same rule as a query predicate: the bookings of one resource that conflict with `window`.
 * `bookingConflicts` and this must select exactly the same rows; `bookingConflict.db.test.ts` holds
 * them to that.
 */
export function conflictingBookingsWhere(resource: { type: string; ref: string }, window: BookingWindow): SQL {
  return and(
    eq(resourceBookings.resourceType, resource.type as never),
    eq(resourceBookings.resourceRef, resource.ref),
    lt(resourceBookings.startsAt, window.endsAt),
    gt(resourceBookings.endsAt, window.startsAt),
    inArray(resourceBookings.bookingState, [...ACTIVE_BOOKING_STATES]),
  )!;
}

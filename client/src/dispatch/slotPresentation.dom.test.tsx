/**
 * The slot vocabulary, and the line it must not cross.
 *
 * Design §16 asks for three visibly distinct states on this screen: **Assigned** (a slot's own
 * `dispatchRoles.status`), **Ready** (the readiness verdict) and **Awarded** (the posting state plus
 * an award record). They answer different questions and are produced by different subsystems, and
 * the whole reason the canonical assignment subsystem exists is that one procedure used to conflate
 * the first and the third.
 *
 * A badge is where that conflation would come back. "Ready to go" on a filled slot reads as the
 * readiness verdict; "Won" reads as the award. Either would let a dispatcher act on a word this
 * screen is not entitled to say, so the vocabulary is a tested artifact rather than a styling
 * choice — `readinessPresentation.ts` is the same idea for the same reason.
 */
import { describe, expect, it } from "vitest";
import {
  SLOT_STATUSES,
  UNAVAILABLE_SLOT,
  isSlotStatus,
  presentRequirement,
  presentSlot,
  type PresentedSlot,
} from "./slotPresentation";

const everyPresentation = (): PresentedSlot[] => [...SLOT_STATUSES.map(presentSlot), UNAVAILABLE_SLOT];
const wordsOf = (p: PresentedSlot) => `${p.label} ${p.meaning}`;

/* ── I1a. every status the database can hold has a presentation ─────────────── */

describe("I1a — the mapping covers the column, and nothing beyond it", () => {
  it("names exactly the five statuses dispatchRoles.status can hold", () => {
    expect([...SLOT_STATUSES]).toEqual(["open", "invited", "bid_received", "assigned", "cancelled"]);
  });

  it("gives each status a distinct label", () => {
    const labels = SLOT_STATUSES.map(s => presentSlot(s).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /*
   * A status this build has never heard of is a server that moved ahead of this client. Showing the
   * raw token would be noise; guessing would be a fabrication. It says it cannot say.
   */
  it("presents an unrecognised status as unavailable rather than guessing or echoing it", () => {
    expect(presentSlot("teleported")).toEqual(UNAVAILABLE_SLOT);
    expect(wordsOf(presentSlot("teleported"))).not.toContain("teleported");
    expect(isSlotStatus("teleported")).toBe(false);
    expect(isSlotStatus("assigned")).toBe(true);
  });
});

/* ── I1b. fill is derived from the status, and only one status is filled ────── */

describe("I1b — only an assigned slot counts as filled", () => {
  it("marks exactly `assigned` as filled", () => {
    expect(SLOT_STATUSES.filter(s => presentSlot(s).fill === "filled")).toEqual(["assigned"]);
  });

  it("separates a withdrawn slot from an unfilled one, because they mean different things", () => {
    // `cancelled` is "we no longer need this", not "nobody has taken it yet". Staffing excludes the
    // first and counts the second, so the screen must not draw them the same way.
    expect(presentSlot("cancelled").fill).toBe("withdrawn");
    expect(presentSlot("open").fill).toBe("unfilled");
  });

  it("treats a slot that is merely being negotiated as not yet filled", () => {
    for (const s of ["invited", "bid_received"] as const) {
      expect(presentSlot(s).fill, `${s} binds nobody`).toBe("unfilled");
    }
  });

  it("says unavailable rather than claiming an unknown status is filled or empty", () => {
    expect(UNAVAILABLE_SLOT.fill).toBe("unavailable");
  });
});

/* ── I1c. the vocabulary does not borrow readiness's or the award's ─────────── */

describe("I1c — an assignment word never reads as readiness or as an award", () => {
  /*
   * The readiness panel owns these. A slot that is filled says nothing about whether the crew on it
   * may legally be dispatched — that is a separate evaluation with its own verdict and its own
   * fingerprint, and it can be `blocked` on a slot that is perfectly well filled.
   */
  it("uses none of readiness's words", () => {
    for (const p of everyPresentation()) {
      for (const word of [/\bready\b/i, /\beligible\b/i, /\bcleared\b/i, /\bgo\b/i, /\bsafe\b/i]) {
        expect(word.test(wordsOf(p)), `"${p.label}" must not borrow readiness's vocabulary`).toBe(false);
      }
    }
  });

  /*
   * And the award's. `jobUnits.create` became dangerous precisely because an assignment-shaped call
   * carried award meaning; a badge that says "Awarded" on a filled slot is the same mistake drawn
   * instead of executed.
   */
  it("uses none of the award's words", () => {
    for (const p of everyPresentation()) {
      for (const word of [/\bawarded?\b/i, /\bwon\b/i, /\bwinner\b/i, /\bbooked\b/i, /\bconfirmed\b/i]) {
        expect(word.test(wordsOf(p)), `"${p.label}" must not borrow the award's vocabulary`).toBe(false);
      }
    }
  });

  it("never says a record is unknown, because that is not what any of these mean", () => {
    for (const p of everyPresentation()) {
      expect(/\bunknown\b/i.test(wordsOf(p))).toBe(false);
    }
  });

  it("explains each status in its own words rather than leaving the meaning blank", () => {
    for (const p of everyPresentation()) {
      expect(p.meaning.length, `"${p.label}" needs a meaning a dispatcher can act on`).toBeGreaterThan(20);
    }
  });
});

/* ── I1d. required vs optional is the staffing question, kept separate ──────── */

describe("I1d — required is about staffing, not about the fill", () => {
  it("describes a required slot and an optional one distinguishably, without touching fill", () => {
    expect(presentRequirement(true).label).not.toBe(presentRequirement(false).label);
    // An optional slot left open is not a deficiency; the wording must not imply one.
    for (const word of [/\bmissing\b/i, /\boutstanding\b/i, /\bincomplete\b/i]) {
      expect(word.test(`${presentRequirement(false).label} ${presentRequirement(false).meaning}`)).toBe(false);
    }
  });
});

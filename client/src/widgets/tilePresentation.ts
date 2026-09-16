/**
 * B23 — what a tile looks like.
 *
 * Pure. No React, no DOM. The component is a shell over this.
 *
 * The state union is necessary and not sufficient. `ok` is not one appearance:
 * a scale ticket and a driver saying "about thirty-one five" both arrive as
 * `ok`, and if both render as a confident number in the same colour then the
 * union bought nothing. So provenance survives into the tone here, and `ok`
 * splits three ways — confirmed, provisional, approximate.
 *
 * Rules the tests pin:
 *
 * **Only `ok` and `stale` display a value.** Every other state displays words.
 * `unknown` renders its reason; it has no dash, no blank and no zero, because
 * an empty tile reads as "nothing to worry about" and that is the one thing
 * unknown does not mean.
 *
 * **No two appearances collide.** Every state, and each of the three `ok`
 * tones, has a distinct tone-and-badge pair, so a glance across a board
 * separates a verified number from an unverified one without reading either.
 *
 * **Unknown is not a warning.** It gets slate, not amber. Amber means somebody
 * needs to look at something; slate means nobody knows yet. Painting both
 * amber is the conflation the routing axes exist to prevent, moved into CSS.
 *
 * Colours are the product's existing console tokens, not new ones.
 */

import type { NamedBlocker, Provenance, WidgetPayload } from "../../../server/_core/widgetPayload";

/**
 * Tone maps to a token pair already in the prototype stylesheet:
 * `--verified`, `--amber`, `--blocked`, `--sand`, `--dim`, `--faint`.
 */
export type TileTone =
  | "confirmed"    // --verified   a verified, exact, current value
  | "provisional"  // --amber      a real value nobody has verified
  | "approximate"  // --sand       a value the source called inexact
  | "aged"         // --amber      past its freshness budget
  | "unknown"      // --dim        nobody knows
  | "blocked"      // --blocked    a determinate no, with names
  | "withheld"     // --faint      not permitted, and said so
  | "offline"      // --faint      no answer available without a connection
  | "fault";       // --blocked    a source is down

export type TilePresentation = {
  tone: TileTone;
  /** Two words at most, lower case. Sits beside the title, never instead of it. */
  badge: string;
  /** True only for `ok` and `stale`. */
  showsValue: boolean;
  /** Prefix for an inexact value. Empty when the value is exact. */
  valuePrefix: string;
  /** Always present and never empty: the sentence under the tile. */
  detail: string;
  /** Rows to list under the tile. Blockers, or nothing. */
  rows: readonly string[];
  /** What the person can do about it, when there is something. */
  action: { label: string; kind: "open" | "retry" | "none" };
  /** Safe to bill, dispatch or certify from. `confirmed` only. */
  actionable: boolean;
};

const sourceWords: Record<Provenance["source"], string> = {
  driver_stated: "driver stated",
  driver_voice: "driver voice",
  gps: "GPS",
  ocr: "scanned",
  imported: "imported",
  system_inferred: "inferred",
  authority_sourced: "authority",
  human_corrected: "corrected",
  measured: "measured",
};

const shortTime = (d: Date): string =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

const blockerLine = (b: NamedBlocker): string => b.detail;

/**
 * Describe a payload.
 *
 * `title` is the widget's own title and is never replaced by the badge — a
 * tile that says only "unknown" tells the reader nothing about what is unknown.
 */
export function presentTile(payload: WidgetPayload<unknown>, title: string): TilePresentation {
  switch (payload.state) {
    case "ok": {
      const p = payload.provenance;
      if (!p.exact) {
        return {
          tone: "approximate", badge: "approximate", showsValue: true, valuePrefix: "about ",
          detail: `${sourceWords[p.source]}, not measured`,
          rows: [], action: { label: `Confirm ${title.toLowerCase()}`, kind: "open" },
          actionable: false,
        };
      }
      if (p.verification !== "verified") {
        return {
          tone: "provisional", badge: "unverified", showsValue: true, valuePrefix: "",
          detail: `${sourceWords[p.source]}, awaiting confirmation`,
          rows: [], action: { label: "Review and confirm", kind: "open" },
          actionable: false,
        };
      }
      const by = p.verifiedAt ? ` at ${shortTime(p.verifiedAt)}` : "";
      return {
        tone: "confirmed", badge: "verified", showsValue: true, valuePrefix: "",
        detail: `${sourceWords[p.source]}, verified${by}`,
        rows: [], action: { label: "Open", kind: "open" },
        actionable: true,
      };
    }

    case "stale":
      return {
        tone: "aged", badge: "out of date", showsValue: true, valuePrefix: "",
        // The number is real, so it is shown; the time is what makes it honest.
        detail: `as of ${shortTime(payload.asOf)}, not refreshed since`,
        rows: [], action: { label: "Refresh", kind: "retry" },
        actionable: false,
      };

    case "unknown":
      return {
        tone: "unknown", badge: "unknown", showsValue: false, valuePrefix: "",
        // The reason is the content. A tile with an empty detail here would
        // read as an idle tile rather than a gap in what the company knows.
        detail: payload.reason,
        rows: [], action: { label: "What's missing", kind: "open" },
        actionable: false,
      };

    case "blocked":
      return {
        tone: "blocked", badge: "blocked", showsValue: false, valuePrefix: "",
        detail: payload.blockers.length === 1
          ? (payload.blockers[0] as NamedBlocker).detail
          : `${payload.blockers.length} blockers`,
        rows: payload.blockers.map(blockerLine),
        action: { label: "Resolve", kind: "open" },
        actionable: false,
      };

    case "not_permitted":
      return {
        tone: "withheld", badge: "withheld", showsValue: false, valuePrefix: "",
        // Named, not blanked. A board that quietly shrank would leave the
        // reader believing they had seen all of it.
        detail: `withheld — needs ${payload.permission}`,
        rows: [], action: { label: "Request access", kind: "open" },
        actionable: false,
      };

    case "offline":
      return {
        tone: "offline", badge: "offline", showsValue: false, valuePrefix: "",
        detail: payload.cachedAt
          ? `no connection; last held at ${shortTime(payload.cachedAt)}`
          : "no connection, and this one has no offline answer",
        rows: [], action: { label: "None", kind: "none" },
        actionable: false,
      };

    case "failed":
      return {
        tone: "fault", badge: "unavailable", showsValue: false, valuePrefix: "",
        detail: payload.reason,
        rows: [], action: { label: "Try again", kind: "retry" },
        actionable: false,
      };
  }
}

/**
 * Tone → the console tokens that carry it. Foreground, and its dim companion.
 *
 * Kept here rather than in the component because which colour a state gets is
 * an appearance decision, and appearance decisions have to be testable. Note
 * that nine tones share six colour families: `provisional`/`aged` are both
 * amber, `blocked`/`fault` both red, `withheld`/`offline` both faint. Colour
 * alone therefore does not separate all nine, and the badge carries the rest —
 * which is fine, because every pair that shares a colour shares a meaning too
 * ("look at this", "this is a no", "nothing here and not your fault").
 *
 * The one separation colour must carry on its own is confirmed from
 * unconfirmed. `--verified` belongs to `confirmed` and to nothing else, and
 * that is pinned by a test.
 */
export const TONE_TOKENS: Record<TileTone, { fg: string; bg: string }> = {
  confirmed: { fg: "var(--verified)", bg: "var(--verified-dim)" },
  provisional: { fg: "var(--amber)", bg: "var(--amber-dim)" },
  approximate: { fg: "var(--sand)", bg: "transparent" },
  aged: { fg: "var(--amber)", bg: "var(--amber-dim)" },
  unknown: { fg: "var(--dim)", bg: "transparent" },
  blocked: { fg: "var(--blocked)", bg: "var(--blocked-dim)" },
  withheld: { fg: "var(--faint)", bg: "transparent" },
  offline: { fg: "var(--faint)", bg: "transparent" },
  fault: { fg: "var(--blocked)", bg: "var(--blocked-dim)" },
};

/**
 * Every appearance this module can produce, for the collision test.
 *
 * Written out rather than derived from `presentTile`, so adding a tone without
 * deciding how it differs from the others fails the suite.
 */
export const APPEARANCES: readonly { tone: TileTone; badge: string }[] = [
  { tone: "confirmed", badge: "verified" },
  { tone: "provisional", badge: "unverified" },
  { tone: "approximate", badge: "approximate" },
  { tone: "aged", badge: "out of date" },
  { tone: "unknown", badge: "unknown" },
  { tone: "blocked", badge: "blocked" },
  { tone: "withheld", badge: "withheld" },
  { tone: "offline", badge: "offline" },
  { tone: "fault", badge: "unavailable" },
];

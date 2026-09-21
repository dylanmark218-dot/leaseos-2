/**
 * v23.28 — the capture quality gate.
 *
 * Shared by the server and, once the native shell exists, the device — for the reason
 * `printability` gives about printing: scanning happens in a cab with no signal, so the check that
 * sends somebody back to re-shoot has to run where the camera is. A re-shoot is free while the
 * paper is still in the driver's hand and impossible in the office three days later. The server
 * runs the same function again over the signals the device reported, so a device that lies about
 * its own capture is answered by the same arithmetic rather than believed.
 *
 * The documents this exists for are the worst inputs OCR ever sees: faded thermal disposal
 * tickets, carbon copies, paper that spent the morning on a dashboard, photographed with gloved
 * hands. That gap is not closed by a better engine downstream. It is closed at the moment of
 * capture.
 *
 * ## Three verdicts, not two
 *
 * `acceptable` and `unjudged` both let the page through and they are different facts.
 * `acceptable` means the platform scored the frame and the scores cleared the floors. `unjudged`
 * means the platform reported nothing to score — the ordinary case on a device whose scanner
 * returns bytes and no telemetry — and must never be recorded as though the frame had been checked
 * and passed. A reviewer looking at a doubtful extraction has to be able to tell "the image was
 * checked and was fine" from "nobody ever looked at the image".
 *
 * ## The gate advises; it does not confiscate
 *
 * `reshoot` is a recommendation with reasons, not a refusal. A driver at -30C with one usable
 * glove keeps the frame they took, and the session records that the gate objected and they went
 * ahead. A gate that threw away the only photograph of a disposal ticket because it disliked the
 * glare would have destroyed the evidence it exists to protect. What the objection does do is
 * travel: onto the page, into the capture, and in front of whoever confirms the extraction.
 *
 * ## What this file cannot see
 *
 * Nothing here detects thermal fade, because none of the signals a scanner reports measures it: an
 * evenly faded ticket is in focus, unglared, correctly cornered and perfectly legible to an edge
 * detector. Fade surfaces one stage later as a low recognition confidence, and that is where it is
 * caught. A page this gate calls `acceptable` is a well-photographed page, which is not the same
 * claim as a readable one.
 */

/**
 * What the platform reports about its own capture.
 *
 * Every field is nullable and null means UNRECORDED, never good. The gate treats an unreported
 * signal as one it cannot judge and says so — the alternative is a faded thermal ticket sailing
 * through because the platform declined to score it.
 */
export type CaptureQualitySignals = {
  widthPx: number | null;
  heightPx: number | null;
  /** 0-100, higher is sharper. */
  focusScore: number | null;
  /** 0-100, the share of the page the engine believes is blown out. */
  glarePercent: number | null;
  /** 0-100 confidence that the four page corners were actually found. */
  edgeConfidence: number | null;
  /** 0-100, how much of the frame the detected page fills. */
  pageCoveragePercent: number | null;
};

/**
 * The floors, declared once.
 *
 * `minLongEdgePx` is the one that matters most and the one worth arguing about: 1600 px across the
 * long edge of a letter page is about 145 dpi, the region where 8-point print on a fuel receipt
 * stops resolving. It is deliberately not the 300 dpi a flatbed would give, because that floor
 * would reject most phones held at arm's length in a cab and the worker would learn to ignore the
 * gate. A gate that is ignored protects nothing.
 */
export const QUALITY_FLOORS = {
  minLongEdgePx: 1600,
  minShortEdgePx: 900,
  /** Below this, strokes bleed into each other and digits transpose. */
  minFocusScore: 60,
  /** A blown-out patch over a total or a signature is the failure this catches. */
  maxGlarePercent: 8,
  /** Corners the scanner was unsure it found mean a deskew that may have warped the text. */
  minEdgeConfidence: 70,
  /** A page filling less than this much of the frame is spending its pixels on the dashboard. */
  minPageCoveragePercent: 45,
} as const;

export type QualitySignalKey = "resolution" | "focus" | "glare" | "edges" | "coverage";

export const ALL_QUALITY_SIGNALS: readonly QualitySignalKey[] =
  ["resolution", "focus", "glare", "edges", "coverage"] as const;

export type QualityFailure = {
  signal: QualitySignalKey;
  observed: number;
  floor: number;
  /** The arithmetic, so a worker reads a reason rather than a red border. */
  message: string;
};

export type PageQualityVerdict = "acceptable" | "unjudged" | "reshoot";

export type PageQualityAssessment = {
  verdict: PageQualityVerdict;
  /** Every floor the frame missed, named. Never a count. */
  failures: QualityFailure[];
  /** Signals the platform did not report. Unrecorded, never good. */
  unreported: QualitySignalKey[];
  /** One line to put in front of the worker. */
  advice: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A number the platform did not really report. NaN and Infinity are not measurements. */
const reported = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Judge one captured page.
 *
 * Each signal is judged only if the platform reported it. A signal reported as null — or as NaN or
 * Infinity, which is a platform returning junk rather than a measurement — lands in `unreported`
 * and produces neither a pass nor a failure, because both would be claims about something nobody
 * measured.
 *
 * Comparisons are deliberately inclusive of the floor: a focus score exactly at the floor PASSES,
 * and glare exactly at the ceiling PASSES. A threshold that rejected its own boundary value would
 * make the constant a lie about where the line is.
 */
export function assessPageQuality(signals: CaptureQualitySignals): PageQualityAssessment {
  const failures: QualityFailure[] = [];
  const unreported: QualitySignalKey[] = [];

  // Resolution is two numbers and one verdict: the long edge carries the text.
  if (!reported(signals.widthPx) || !reported(signals.heightPx)) {
    unreported.push("resolution");
  } else {
    const longEdge = Math.max(signals.widthPx, signals.heightPx);
    const shortEdge = Math.min(signals.widthPx, signals.heightPx);
    if (longEdge < QUALITY_FLOORS.minLongEdgePx) {
      failures.push({
        signal: "resolution", observed: longEdge, floor: QUALITY_FLOORS.minLongEdgePx,
        message: `${signals.widthPx}x${signals.heightPx} px - the long edge is ${longEdge}, below ${QUALITY_FLOORS.minLongEdgePx}; small print will not resolve`,
      });
    } else if (shortEdge < QUALITY_FLOORS.minShortEdgePx) {
      failures.push({
        signal: "resolution", observed: shortEdge, floor: QUALITY_FLOORS.minShortEdgePx,
        message: `${signals.widthPx}x${signals.heightPx} px - the short edge is ${shortEdge}, below ${QUALITY_FLOORS.minShortEdgePx}`,
      });
    }
  }

  if (!reported(signals.focusScore)) unreported.push("focus");
  else if (signals.focusScore < QUALITY_FLOORS.minFocusScore) {
    failures.push({
      signal: "focus", observed: round1(signals.focusScore), floor: QUALITY_FLOORS.minFocusScore,
      message: `focus ${round1(signals.focusScore)} of 100, below ${QUALITY_FLOORS.minFocusScore} - hold steadier or move back a hand's width`,
    });
  }

  if (!reported(signals.glarePercent)) unreported.push("glare");
  else if (signals.glarePercent > QUALITY_FLOORS.maxGlarePercent) {
    failures.push({
      signal: "glare", observed: round1(signals.glarePercent), floor: QUALITY_FLOORS.maxGlarePercent,
      message: `${round1(signals.glarePercent)}% of the page is blown out, over ${QUALITY_FLOORS.maxGlarePercent}% - turn the page away from the window or the dome light`,
    });
  }

  if (!reported(signals.edgeConfidence)) unreported.push("edges");
  else if (signals.edgeConfidence < QUALITY_FLOORS.minEdgeConfidence) {
    failures.push({
      signal: "edges", observed: round1(signals.edgeConfidence), floor: QUALITY_FLOORS.minEdgeConfidence,
      message: `page corners found with ${round1(signals.edgeConfidence)}% confidence, below ${QUALITY_FLOORS.minEdgeConfidence}% - flatten the page against something dark`,
    });
  }

  if (!reported(signals.pageCoveragePercent)) unreported.push("coverage");
  else if (signals.pageCoveragePercent < QUALITY_FLOORS.minPageCoveragePercent) {
    failures.push({
      signal: "coverage", observed: round1(signals.pageCoveragePercent), floor: QUALITY_FLOORS.minPageCoveragePercent,
      message: `the page fills ${round1(signals.pageCoveragePercent)}% of the frame, below ${QUALITY_FLOORS.minPageCoveragePercent}% - fill the screen with the paper`,
    });
  }

  if (failures.length > 0) {
    return { verdict: "reshoot", failures, unreported, advice: reshootAdvice(failures) };
  }

  // Nothing failed. Whether that is a pass or merely an absence of evidence depends on whether
  // anything was measured at all.
  if (unreported.length === ALL_QUALITY_SIGNALS.length) {
    return {
      verdict: "unjudged", failures: [], unreported,
      advice: "This device reports nothing about capture quality, so the image was not checked. Read the page on screen before you accept it.",
    };
  }

  return {
    verdict: "acceptable", failures: [], unreported,
    advice: unreported.length === 0
      ? "Capture looks good."
      : `Capture looks good on what this device measures; it reports nothing about ${unreported.join(", ")}.`,
  };
}

/**
 * One line, not five.
 *
 * A worker handed five faults re-shoots nothing. The worst fault is the one that changes what they
 * do with their hands, and the rest are counted.
 */
function reshootAdvice(failures: QualityFailure[]): string {
  const order: QualitySignalKey[] = ["focus", "glare", "resolution", "coverage", "edges"];
  const worst = failures.slice().sort((a, b) => order.indexOf(a.signal) - order.indexOf(b.signal))[0]!;
  const others = failures.length - 1;
  return others > 0 ? `${worst.message} (and ${others} other issue${others > 1 ? "s" : ""})` : worst.message;
}

/**
 * Every page's verdict reduced to the session's, worst first. A session is only as good as its
 * worst page.
 *
 * No pages reads `unjudged` rather than `acceptable`: an empty session has not passed a check, it
 * has not had one, and the two must not share a word.
 */
export function sessionQualityVerdict(pages: readonly PageQualityAssessment[]): PageQualityVerdict {
  if (pages.length === 0) return "unjudged";
  if (pages.some(p => p.verdict === "reshoot")) return "reshoot";
  if (pages.some(p => p.verdict === "unjudged")) return "unjudged";
  return "acceptable";
}

/**
 * Calendar-fixture early warning.
 *
 * Twice in one session a test broke because the real clock passed a date a
 * fixture had frozen: promotionLedger.db.test compared a fixture "tomorrow"
 * against the database's now(); workforce.test hired someone on 2026-09-14
 * and two onboarding tasks went overdue when the 17th arrived. Neither file
 * looked risky; both were.
 *
 * A static scan cannot see a router's `new Date()` from a test file, so this
 * is not a zero rule. It is a tripwire: for every test file that both holds a
 * date the calendar will pass within the window AND makes a genuine clock
 * read, a reviewer has either recorded that the date never meets the clock
 * (`clock_independent`, with the reason) or has not — and an unreviewed file
 * fails this test three weeks before its nearest date arrives, so the fix
 * lands before the break does. Reviewed verdicts are checked too: a file
 * whose recorded dates have changed is back to unreviewed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WINDOW_DAYS = 60;
const FAIL_WITHIN_DAYS = 21;

/** Reviewed files: the dates seen at review and why the clock never meets them. Re-review when the dates change. */
const REVIEWED: Record<string, { dates: string[]; verdict: "clock_independent"; reason: string }> = {
  "server/_core/calibrationEvidence.test.ts": { dates: ["2026-09-20", "2026-10-01"], verdict: "clock_independent", reason: "both are compared only against fixed dates — 2026-10-01 against a reading at a fixed AT, 2026-09-20 against the finding's own performedAt. The two tests in this file that DO read the real clock pass it to deriveExceptions and involve neither date" },
  "server/_core/evidenceVault.test.ts": { dates: ["2026-09-20", "2026-09-21"], verdict: "clock_independent", reason: "every evaluation receives an explicit `now`; the only real read stamps amendedAt" },
  "server/communications.test.ts": { dates: ["2026-09-18", "2026-09-25"], verdict: "clock_independent", reason: "effectiveTo and planForPath `at` are both explicit; Date.now() only mints keys" },
  "server/capitalAssets.test.ts": { dates: ["2026-10-15", "2026-10-20", "2026-10-31"], verdict: "clock_independent", reason: "schedule and disposal fixtures use explicit asOf/acquiredAt/disposedAt dates; real clock reads only supply registration timestamps and unique test keys" },
  // Re-recorded 2026-09-21 with the file unchanged: 2026-11-20 (an invoice dueAt at line 123)
  // came into range as the 60-day window advanced, and a date entering is precisely what this
  // list exists to have somebody look at. It was checked against the same reason, which holds —
  // it is aged against fixed dates, and the file's only real clock reads mint a key and stamp a
  // role grant. 2026-09-20 is kept though it is now past: `dates` below is built from future
  // in-window dates only, so a departed date is already a non-event and dropping it from the
  // record would only lose the evidence that it was certified while it still mattered.
  "server/cash.test.ts": { dates: ["2026-09-25", "2026-09-28", "2026-09-30", "2026-10-02", "2026-10-10", "2026-10-20", "2026-11-20"], verdict: "clock_independent", reason: "statement periods and END are fixed ranges compared with each other, not with now" },
  // Reviewed 2026-09-24, when 2026-10-15 came into the window as the clock advanced.
  // All three are explicit parameters: 2026-10-31 is the fiscalYearEnd handed to
  // buildSchedule and asserted as a string, 2026-10-15 is an explicit `asOf`, and
  // 2026-10-20 is an explicit `disposedAt`. Each is compared with the others and
  // with the fixed fiscal year, never with now. The file's real clock reads mint a
  // key and stamp grantedAt/acquiredAt, and take part in none of those comparisons.
  "server/auditPackage.test.ts": { dates: ["2026-09-30"], verdict: "clock_independent", reason: "periodFrom/periodTo bound the package; nothing compares them with now" },
  "server/bulkFuel.test.ts": { dates: ["2026-09-30"], verdict: "clock_independent", reason: "statement period and anomaly window are fixed ranges" },
  "server/purchasingAp.test.ts": { dates: ["2026-09-30", "2026-10-02", "2026-10-08"], verdict: "clock_independent", reason: "fourWayMatch compares dates with each other, not with now" },
  "server/workforce.test.ts": { dates: ["2026-09-30", "2026-11-01"], verdict: "clock_independent", reason: "offboardingClose receives an explicit `now`; the hire start date is already clock-relative (the earlier break)" },
  "server/commercialProjects.test.ts": { dates: ["2026-10-01"], verdict: "clock_independent", reason: "quoteAcceptanceDecision compares validUntil with an explicit `at: NOW`" },
  "server/commsDispatch.test.ts": { dates: ["2026-10-01"], verdict: "clock_independent", reason: "effectiveTo-before-effectiveFrom refusal; the dates are compared with each other" },
  "server/fieldroute.test.ts": { dates: ["2026-10-01"], verdict: "clock_independent", reason: "the document is created with expiresAt; only its creation is asserted" },
  "server/gst.test.ts": { dates: ["2026-10-01"], verdict: "clock_independent", reason: "period-bound arithmetic (2026-Q3 ends 1 October); no comparison with now" },
  "server/ifta.test.ts": { dates: ["2026-10-01"], verdict: "clock_independent", reason: "quarter-bound arithmetic; no comparison with now" },
  "server/qualificationStore.test.ts": { dates: ["2026-10-01", "2026-11-10"], verdict: "clock_independent", reason: "the expired holding is evaluated against the shift's explicit STARTS, not now" },
  // CI-0.1 (2026-09-24). The first review this list has been given with a proof rather than a reading:
  // the file's own "CI-0.1" tests run the fixture year under five system clocks (2026-09-24 through
  // 2030-09-24) and require identical answers, and were checked to fail on a planted clock dependency.
  "server/capitalAssets.test.ts": { dates: ["2026-10-15", "2026-10-16", "2026-10-20", "2026-10-21", "2026-10-31", "2026-11-15", "2030-09-24"], verdict: "clock_independent", reason: "one fiscal year ending 2026-10-31: the schedule gets an explicit asOf (10-15), disposal is compared only with acquisition (10-20), periods lock by a recorded close not the calendar, the twin's real-clock asOf matters only with recorded distance (none here), and the CCA seed rates have no end date. 10-16, 10-21, 11-15 and 2030-09-24 are the proof's own system clocks. Real clock reads: keys, role grants, two refusal-path acquiredAt values" },
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!/node_modules|dist/.test(e)) testFiles(p, out); }
    else if (/\.test\.tsx?$/.test(e) && !p.endsWith("calendarFixtures.test.ts")) out.push(p);
  }
  return out;
}
const genuineClockReads = (src: string) =>
  (src.match(/new Date\(\)/g) ?? []).length +
  Array.from(src.matchAll(/Date\.now\(\)/g)).filter(m => !src.slice(m.index! + 10, m.index! + 23).startsWith(".toString(36)")).length;

const DAY = 86_400_000;
const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();

describe("fixture dates the calendar is about to pass", () => {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const exposures: Record<string, string[]> = {};
  for (const f of [...testFiles("server"), ...testFiles("client/src")]) {
    const src = readFileSync(f, "utf8");
    if (!genuineClockReads(src)) continue;
    const dates = new Set<string>();
    for (const m of src.matchAll(/["'](\d{4}-\d{2}-\d{2})/g)) {
      const t = dayOf(m[1]!);
      if (Number.isNaN(t)) continue;
      if (t > today && t <= today + WINDOW_DAYS * DAY) dates.add(m[1]!);
    }
    if (dates.size) exposures[f] = Array.from(dates).sort();
  }

  it("every file with a near-future fixture and a real clock read is reviewed, or has more than three weeks left", () => {
    const failing: string[] = [];
    for (const [f, dates] of Object.entries(exposures)) {
      const r = REVIEWED[f];
      // Only dates that are future AND in-window reach `dates`, so a recorded date
      // going past is already a non-event and cannot fail a file. The one thing
      // that can is a date ARRIVING in range, which is the review this list is for.
      const unreviewed = r ? dates.filter(d => !r.dates.includes(d)) : dates;
      if (unreviewed.length === 0) continue;
      const nearest = Math.min(...dates.map(dayOf));
      const daysLeft = Math.round((nearest - today) / DAY);
      // Name the dates nobody has certified. Saying only "dates changed" sent a
      // reader looking for an edit to a file that had not been touched.
      if (daysLeft <= FAIL_WITHIN_DAYS) failing.push(`${f}: ${dates.join(", ")} (${daysLeft} day(s) until the first) — ${r ? `not yet reviewed: ${unreviewed.join(", ")}` : "unreviewed"}`);
    }
    expect(failing, "A test fixture date is about to be passed by the real clock in a file that also reads the clock. Review it: make the fixture clock-relative, or record it in REVIEWED with the reason the clock never meets it.").toEqual([]);
  });

  it("names what is coming, so the next review is not a surprise", () => {
    // Informational: printed in the run, never a failure on its own.
    const upcoming = Object.entries(exposures).filter(([f]) => !REVIEWED[f]).map(([f, d]) => `${f} → ${d[0]}`);
    // eslint-disable-next-line no-console
    if (upcoming.length) console.info(`[calendar-fixtures] ${upcoming.length} unreviewed file(s) with a fixture date inside ${WINDOW_DAYS} days:\n  ${upcoming.join("\n  ")}`);
    expect(Array.isArray(upcoming)).toBe(true);
  });
});

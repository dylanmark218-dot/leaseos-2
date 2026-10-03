/**
 * Clock-sweep setup (CI-0.2): when CLOCK_SWEEP_AT is set, every test file in the run starts at that
 * instant — at module load and inside tests — and the clock then runs forward in real time. Only
 * `Date` is faked; timers stay real so database I/O works. It advances rather than freezes because a
 * frozen clock is not a calendar date, it is a different bug: two writes in one test would share a
 * timestamp they never share in production, and the sweep would report that, not the date. Loaded only by scripts/clock-sweep/vitest.config.ts, never by the gate.
 */
import { vi } from "vitest";

const at = process.env.CLOCK_SWEEP_AT;
if (at) {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, advanceTimeDelta: 1 });
  vi.setSystemTime(new Date(at));
}

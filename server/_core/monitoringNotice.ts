/**
 * P4.6 — whether this worker has been told what is collected about them.
 *
 * LeaseOS reads a driver's position continuously and holds their hours, inspections and defect
 * reports. The person is entitled to know, and the company is entitled to be able to show that they
 * were told. Neither is served by a system that assumes it happened.
 *
 * The state that does the work here is `not_notified`, and it is the default. There is no
 * "presumably covered": a worker with no notice on file is a worker nobody told, which is precisely
 * the fact this register exists to surface rather than to soften.
 *
 * What this deliberately does **not** do is block collection. Whether unacknowledged monitoring
 * should stop a dispatch is a decision with real operational teeth — a hard block would strand
 * trucks over paperwork — and it belongs to the owner through the automation policy, not to a
 * module that happens to know the answer. So this reports, and the Exception Centre surfaces it.
 */

export type MonitoringPurpose =
  | "vehicle_location" | "driver_duty_hours" | "in_cab_camera"
  | "device_telemetry" | "app_usage" | "biometric_device_unlock";

/** What each purpose actually collects, in the words a notice has to use to be a notice. */
export const PURPOSE_PLAIN_LANGUAGE: Readonly<Record<MonitoringPurpose, string>> = {
  vehicle_location: "where the vehicle you are driving is, continuously while you are on duty",
  driver_duty_hours: "when you start and stop driving, and how long you have worked",
  in_cab_camera: "video from inside the cab",
  device_telemetry: "how the device behaves — battery, connectivity, whether it is moving",
  app_usage: "which parts of the app you open and when",
  biometric_device_unlock: "that your fingerprint or face unlocked the device — never the fingerprint or face itself",
};

export type NoticeRow = {
  id: number;
  subjectUserId: number;
  purpose: MonitoringPurpose;
  noticeVersion: string;
  issuedAt: Date;
  acknowledgedAt: Date | null;
  supersededAt: Date | null;
  withdrawnAt: Date | null;
};

export type CoverageState = "acknowledged" | "issued_not_acknowledged" | "withdrawn" | "superseded_not_replaced" | "not_notified";

export type Coverage = {
  purpose: MonitoringPurpose;
  state: CoverageState;
  /** True only for `acknowledged`. Everything else is a fact someone has to deal with. */
  covered: boolean;
  noticeId: number | null;
  noticeVersion: string | null;
  detail: string;
};

/**
 * Coverage for one purpose at one moment.
 *
 * `issued_not_acknowledged` is kept separate from `not_notified` on purpose. They call for
 * different work — one is chasing a signature, the other is that nobody ever sent anything — and
 * collapsing them into "not covered" would hide which of those a company is actually facing.
 */
export function coverageFor(
  subjectUserId: number,
  purpose: MonitoringPurpose,
  notices: readonly NoticeRow[],
  at: Date,
): Coverage {
  const mine = notices
    .filter(n => n.subjectUserId === subjectUserId && n.purpose === purpose && n.issuedAt <= at)
    .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());

  if (mine.length === 0) {
    return {
      purpose, state: "not_notified", covered: false, noticeId: null, noticeVersion: null,
      detail: `No notice has been issued to this person about ${PURPOSE_PLAIN_LANGUAGE[purpose]}. Nobody told them; that is not the same as a notice they have not signed.`,
    };
  }

  const live = mine.find(n => !n.supersededAt && !n.withdrawnAt);
  if (!live) {
    const withdrawn = mine.find(n => n.withdrawnAt);
    if (withdrawn) {
      return {
        purpose, state: "withdrawn", covered: false, noticeId: withdrawn.id, noticeVersion: withdrawn.noticeVersion,
        detail: `The notice was withdrawn ${withdrawn.withdrawnAt!.toISOString().slice(0, 10)}. Collection under a withdrawn notice is collection nobody has been told about.`,
      };
    }
    const superseded = mine[0]!;
    return {
      purpose, state: "superseded_not_replaced", covered: false, noticeId: superseded.id, noticeVersion: superseded.noticeVersion,
      // The quiet failure: a notice is updated, the old one retired, and the replacement never issued.
      detail: `Notice ${superseded.noticeVersion} was superseded and no replacement has been issued to this person. The old one no longer covers them and the new one never reached them.`,
    };
  }

  if (!live.acknowledgedAt) {
    return {
      purpose, state: "issued_not_acknowledged", covered: false, noticeId: live.id, noticeVersion: live.noticeVersion,
      detail: `Notice ${live.noticeVersion} was issued ${live.issuedAt.toISOString().slice(0, 10)} and has not been acknowledged. Sending it and their having read it are different facts.`,
    };
  }
  return {
    purpose, state: "acknowledged", covered: true, noticeId: live.id, noticeVersion: live.noticeVersion,
    detail: `Notice ${live.noticeVersion} acknowledged ${live.acknowledgedAt.toISOString().slice(0, 10)}.`,
  };
}

/** Coverage across every purpose a deployment actually uses. */
export function coverageAcross(
  subjectUserId: number,
  purposes: readonly MonitoringPurpose[],
  notices: readonly NoticeRow[],
  at: Date,
): { covered: boolean; gaps: Coverage[]; all: Coverage[] } {
  const all = purposes.map(p => coverageFor(subjectUserId, p, notices, at));
  const gaps = all.filter(c => !c.covered);
  return { covered: gaps.length === 0, gaps, all };
}

/**
 * A notice has to say what is collected in language the person can act on.
 *
 * The failure this prevents is the notice that technically exists and tells nobody anything —
 * "the Company may collect operational data in accordance with its policies." That is a sentence
 * whose only function is to have been sent.
 */
export function noticeIsIntelligible(purpose: MonitoringPurpose, text: string): { ok: true } | { ok: false; reason: string } {
  const t = text.trim();
  if (t.length < 80) {
    return { ok: false, reason: "A notice under eighty characters cannot say what is collected, for how long, and who to ask about it." };
  }
  if (/in accordance with (its|our|the company'?s) polic/i.test(t) && t.length < 300) {
    return { ok: false, reason: "A notice that points at a policy instead of saying what is collected is a sentence whose only function is to have been sent." };
  }
  return { ok: true };
}

/**
 * 0172 — external training handoff.
 *
 * Pure. The formal record of "LeaseOS cannot issue this; somebody has to
 * arrange it": H2S Alive, workplace First Aid, Class 1–4 licensing, the Q
 * endorsement, and any course a company declares external.
 *
 * A handoff is coordination, never a credential. Nothing here is read by the
 * readiness path: not the request, not the booking, not "training completed".
 * The only way a handoff closes as VERIFIED/ACTIVE is by linking a holding that
 * the wallet verified under its own rules — and it is that holding, through
 * the canonical rule, that dispatch reads.
 */

export type HandoffStatus =
  | "ACTION_REQUIRED" | "REQUESTED" | "ADMIN_REVIEW" | "PROVIDER_SELECTED" | "BOOKING_IN_PROGRESS" | "BOOKED"
  | "TRAINING_COMPLETED" | "DOCUMENT_PENDING" | "DOCUMENT_UPLOADED_UNVERIFIED" | "VERIFIED" | "ACTIVE"
  | "CANCELLED" | "EXPIRED" | "NOT_REQUIRED" | "UNKNOWN";

export const HANDOFF_STATUSES: readonly HandoffStatus[] = [
  "ACTION_REQUIRED", "REQUESTED", "ADMIN_REVIEW", "PROVIDER_SELECTED", "BOOKING_IN_PROGRESS", "BOOKED",
  "TRAINING_COMPLETED", "DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED", "VERIFIED", "ACTIVE",
  "CANCELLED", "EXPIRED", "NOT_REQUIRED", "UNKNOWN",
];

export type HandoffTrigger = "expiring" | "expired" | "missing_required" | "new_hire" | "career_development" | "employee_request" | "admin_initiated";

export const TERMINAL: ReadonlySet<HandoffStatus> = new Set<HandoffStatus>(["ACTIVE", "CANCELLED", "NOT_REQUIRED"]);
const OPEN_FOR_TERMINATION: HandoffStatus[] = HANDOFF_STATUSES.filter(s => !TERMINAL.has(s));

/** Forward path, with the side exits any open handoff may take. */
const NEXT: Record<HandoffStatus, HandoffStatus[]> = {
  ACTION_REQUIRED: ["REQUESTED", "ADMIN_REVIEW"],
  REQUESTED: ["ADMIN_REVIEW", "PROVIDER_SELECTED"],
  ADMIN_REVIEW: ["PROVIDER_SELECTED", "BOOKING_IN_PROGRESS"],
  PROVIDER_SELECTED: ["BOOKING_IN_PROGRESS", "BOOKED"],
  BOOKING_IN_PROGRESS: ["BOOKED", "PROVIDER_SELECTED"],
  BOOKED: ["TRAINING_COMPLETED", "BOOKING_IN_PROGRESS", "DOCUMENT_PENDING"],
  TRAINING_COMPLETED: ["DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED"],
  DOCUMENT_PENDING: ["DOCUMENT_UPLOADED_UNVERIFIED"],
  DOCUMENT_UPLOADED_UNVERIFIED: ["VERIFIED", "DOCUMENT_PENDING"],
  VERIFIED: ["ACTIVE"],
  ACTIVE: [],
  EXPIRED: ["REQUESTED", "ADMIN_REVIEW"],
  UNKNOWN: ["ADMIN_REVIEW", "REQUESTED"],
  CANCELLED: [],
  NOT_REQUIRED: [],
};

export type HandoffActor = "employee" | "admin";

/**
 * May this move happen?
 *
 * Employees request, cancel their own request, and say they have finished and
 * uploaded. Everything that involves the company's decisions or the issuer's
 * evidence is an admin move. VERIFIED and ACTIVE additionally need a linked
 * holding the wallet verified — the transition cannot assert it.
 */
export function handoffTransition(args: {
  from: HandoffStatus;
  to: HandoffStatus;
  actor: HandoffActor;
  linkedHolding?: { verificationState: string; code: string } | null;
  qualificationCode: string;
  heldNow?: boolean;
}): { permitted: boolean; blockers: string[] } {
  const b: string[] = [];
  const { from, to } = args;
  if (TERMINAL.has(from)) b.push(`Handoff is ${from}; open a new request instead`);
  const sideExit = (to === "CANCELLED" || to === "NOT_REQUIRED" || to === "UNKNOWN" || to === "EXPIRED") && OPEN_FOR_TERMINATION.includes(from);
  if (!sideExit && !NEXT[from].includes(to)) b.push(`${from} → ${to} is not a valid step`);
  const employeeMay: HandoffStatus[] = ["REQUESTED", "CANCELLED", "TRAINING_COMPLETED", "DOCUMENT_UPLOADED_UNVERIFIED"];
  if (args.actor === "employee" && !employeeMay.includes(to)) b.push(`Only safety/administration may move a handoff to ${to}`);
  if (to === "VERIFIED" || to === "ACTIVE") {
    if (!args.linkedHolding) b.push("A handoff becomes VERIFIED only by linking a credential the wallet has verified");
    else {
      if (args.linkedHolding.code !== args.qualificationCode) b.push("The linked credential is for a different qualification");
      if (args.linkedHolding.verificationState !== "verified") b.push("The linked credential is not verified; an uploaded certificate is not a verified credential");
    }
  }
  if (to === "ACTIVE" && !args.heldNow) b.push("ACTIVE means the canonical qualification rule currently counts the credential as held");
  return { permitted: b.length === 0, blockers: b };
}

/** The four words the worker sees instead of fifteen states. */
export function workerFacingStatus(s: HandoffStatus): { label: string; step: 0 | 1 | 2 | 3 | 4 | 5 } {
  switch (s) {
    case "ACTION_REQUIRED": return { label: "Action required", step: 0 };
    case "REQUESTED": case "ADMIN_REVIEW": return { label: "Requested — with the office", step: 1 };
    case "PROVIDER_SELECTED": case "BOOKING_IN_PROGRESS": return { label: "Office contacting provider", step: 2 };
    case "BOOKED": return { label: "Booked", step: 3 };
    case "TRAINING_COMPLETED": case "DOCUMENT_PENDING": case "DOCUMENT_UPLOADED_UNVERIFIED": return { label: "Awaiting certificate verification", step: 4 };
    case "VERIFIED": case "ACTIVE": return { label: "Complete — verified credential on file", step: 5 };
    case "CANCELLED": return { label: "Cancelled", step: 0 };
    case "EXPIRED": return { label: "Expired — request again", step: 0 };
    case "NOT_REQUIRED": return { label: "Not required", step: 0 };
    case "UNKNOWN": return { label: "Unknown — office reviewing", step: 0 };
  }
}

/** Admin's plain-language buttons mapped to the formal states. */
export const ADMIN_MARKS = {
  contacted: "PROVIDER_SELECTED",
  booking: "BOOKING_IN_PROGRESS",
  booked: "BOOKED",
  awaiting_completion: "BOOKED",
  awaiting_certificate: "DOCUMENT_PENDING",
  complete: "VERIFIED",
} as const satisfies Record<string, HandoffStatus>;

/**
 * Who may open a request for whom. An employee requests for themself; asking
 * on somebody else's behalf needs workforce authority.
 */
export function requestAuthority(args: { callerUserId: number; subjectUserId: number; callerHasWorkforceAuthority: boolean }): { permitted: boolean; reason: string | null } {
  if (args.callerUserId === args.subjectUserId) return { permitted: true, reason: null };
  if (args.callerHasWorkforceAuthority) return { permitted: true, reason: null };
  return { permitted: false, reason: "You can request training only for yourself" };
}

/** One open request per person and qualification: a second tap returns the first. */
export function openDuplicate<T extends { userId: number; qualificationCode: string; status: HandoffStatus }>(existing: readonly T[], userId: number, code: string): T | null {
  return existing.find(h => h.userId === userId && h.qualificationCode === code && !TERMINAL.has(h.status) && h.status !== "EXPIRED") ?? null;
}

/**
 * Provider options: the authoritative directory and the company's preferred
 * providers, kept apart. "Find an approved Alberta First Aid provider" is a
 * source; "we normally use ABC Safety" is a company choice.
 */
export function providerOptions(args: {
  capabilities: readonly string[];
  authoritativeSources: readonly { sourceRef: string; title: string; sourceUrl: string | null; capabilityCodes: readonly string[]; reviewStatus: string }[];
  companyProviders: readonly { vendorRef: string; name: string; phone: string | null; email: string | null; capabilityCode: string; preferred: boolean; bookingUrl: string | null; active: boolean }[];
}) {
  const want = new Set(args.capabilities);
  const official = args.authoritativeSources
    .filter(s => s.capabilityCodes.some(c => want.has(c)) && s.reviewStatus !== "rejected" && s.reviewStatus !== "superseded")
    .map(s => ({ ...s, kind: "authoritative_directory" as const, reviewed: s.reviewStatus === "reviewed" }));
  const company = args.companyProviders
    .filter(p => p.active && want.has(p.capabilityCode))
    .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name))
    .map(p => ({ ...p, kind: "company_provider" as const }));
  return { official, company };
}

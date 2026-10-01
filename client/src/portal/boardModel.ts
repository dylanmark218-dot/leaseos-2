/**
 * 0205/0206 — what the board says, as a tested artifact rather than a styling choice.
 *
 * Pure. The view renders these words; it decides none of them.
 *
 * Three vocabularies live here, and each exists to keep one claim honest:
 *
 *   SEND STATE. A message on this device is saved, queued, sending, sent, refused or in conflict —
 *   never "delivered" and never "read". Those are the recipient's facts; the device does not have
 *   them. The states the server witnesses use the server's own words (`senderLabel`), so "Sent"
 *   means the same thing on both sides.
 *
 *   TABS. Six, from the channel's type. A type this build has never heard of is a server that moved
 *   ahead of the client: its channel is still shown (the server let this person open it), under
 *   Company, and nothing is guessed about what it is for.
 *
 *   THE OPEN-WORK CARD. ✓ means "on record and current". A requirement nothing established is "?",
 *   never ✓: a ticket nobody recorded, a person with no operator record, a capability the readiness
 *   composer did not evaluate, an equipment class the award checks later. ✗ is a recorded fact that
 *   excludes. The card also never says a person is assigned, awarded or dispatched on the strength
 *   of interest or an accepted offer — only the award gives work, and the award is dispatch's.
 */
import { senderLabel } from "../../../server/_core/messageLifecycle";
import type { SyncState } from "../runtime/contracts";

/* ------------------------------------------------------------------ */
/* Send state                                                           */
/* ------------------------------------------------------------------ */

export type SendPresentation = {
  label: string;
  tone: "pending" | "ok" | "failed" | "attention";
  /** True only once the server answered with its reference. */
  serverHasIt: boolean;
  /** Kept on the device: everything the server has not accepted. */
  retained: boolean;
};

export const SYNC_STATES: readonly SyncState[] = ["saved_locally", "queued", "syncing", "synchronized", "failed", "conflict"];

export function presentSend(state: SyncState): SendPresentation {
  switch (state) {
    case "saved_locally": return { label: "Saved on this device", tone: "pending", serverHasIt: false, retained: true };
    case "queued": return { label: "Queued on this device — not sent", tone: "pending", serverHasIt: false, retained: true };
    case "syncing": return { label: senderLabel("uploaded"), tone: "pending", serverHasIt: false, retained: true };
    case "synchronized": return { label: senderLabel("accepted"), tone: "ok", serverHasIt: true, retained: false };
    case "failed": return { label: "Not sent — refused, kept on this device", tone: "failed", serverHasIt: false, retained: true };
    case "conflict": return { label: "Needs attention — kept on this device", tone: "attention", serverHasIt: false, retained: true };
  }
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */

export const BOARD_TABS = ["inbox", "dispatch", "my_jobs", "open_work", "company", "safety"] as const;
export type BoardTab = (typeof BOARD_TABS)[number];

export const TAB_LABELS: Record<BoardTab, string> = {
  inbox: "Inbox", dispatch: "Dispatch", my_jobs: "My Jobs", open_work: "Open Work", company: "Company", safety: "Safety",
};

/** The channel types the server can hold today, each with its tab. */
const TYPE_TAB: Record<string, Exclude<BoardTab, "open_work">> = {
  direct: "inbox", group: "inbox",
  dispatch: "dispatch",
  job: "my_jobs",
  safety: "safety", emergency: "safety",
  announcement: "company", general: "company", department: "company", unit: "company", shift: "company",
  field_operations: "company", road_conditions: "company", training: "company", maintenance: "company", private: "company",
};

export const KNOWN_CHANNEL_TYPES: readonly string[] = Object.keys(TYPE_TAB);

export type BoardChannel = { channelRef: string; type: string; name: string; unacknowledged: number };

/** The tab a channel lives under. An unknown type is shown under Company rather than hidden. */
export function tabOfChannel(type: string): Exclude<BoardTab, "open_work"> {
  return TYPE_TAB[type] ?? "company";
}

/**
 * The channels a tab lists. Inbox is conversations plus anything waiting on you: a bulletin you owe
 * an acknowledgement is in your inbox whichever channel it came through.
 */
export function channelsForTab(tab: BoardTab, channels: readonly BoardChannel[]): BoardChannel[] {
  if (tab === "open_work") return [];
  if (tab === "inbox") return channels.filter(c => tabOfChannel(c.type) === "inbox" || c.unacknowledged > 0);
  return channels.filter(c => tabOfChannel(c.type) === tab);
}

/** Bulletins waiting on you in a tab. Counted once per channel, not once per tab it appears in. */
export function tabBadge(tab: BoardTab, channels: readonly BoardChannel[]): number {
  return channelsForTab(tab, channels).reduce((n, c) => n + c.unacknowledged, 0);
}

/* ------------------------------------------------------------------ */
/* Open work                                                            */
/* ------------------------------------------------------------------ */

export type Mark = "held" | "missing" | "unknown";
export const MARK_GLYPH: Record<Mark, string> = { held: "✓", missing: "✗", unknown: "?" };
export const MARK_WORDS: Record<Mark, string> = { held: "on record", missing: "not met", unknown: "not established" };

export type RequirementLine = { label: string; mark: Mark; detail: string | null };

export type PostForCard = {
  postRef: string;
  title: string;
  status: string;
  requiredRole: string;
  requiredQualifications: readonly string[];
  requiredEquipmentClass: string | null;
  location: string | null;
  regionCode: string | null;
  startsAt: Date;
  endsAt: Date;
  estimatedHours: number | null;
  overtime: boolean;
  priority: string;
};

export type PreviewForCard = {
  /** The one rule's answer (SPINE item 2). Absent from an older server: then `verdict` decides. */
  eligible?: boolean;
  verdict: "eligible" | "ineligible" | "unknown";
  /** The rule's reasons, unrenamed. */
  reasons: readonly { code: string; detail: string }[];
  availability: string;
  /** What the person's declaration says about this post. Shown, never a refusal. */
  availabilityNotes?: readonly { code: string; detail: string }[];
  interestExpressed: boolean;
  readinessNotEvaluated: readonly string[];
  /** Readiness findings about the person. Its own axis: the award's stored check is where they bind. */
  readinessBlockers?: readonly { code: string; detail: string }[];
};

export type OfferForCard = { offerRef: string; status: string; expiresAt: Date | null } | null;

export type OpenWorkCard = {
  postRef: string;
  title: string;
  facts: string[];
  requirements: RequirementLine[];
  verdict: { label: string; tone: "ok" | "unknown" | "blocked" };
  availability: string;
  canRespond: boolean;
  canDecline: boolean;
  actionNote: string | null;
  offer: { offerRef: string; label: string; answerable: boolean } | null;
};

const when = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const OFFER_LABELS: Record<string, string> = {
  offered: "Offered to you — accept or decline",
  accepted: "You accepted — the work is not given until dispatch awards it",
  declined: "You declined this offer",
  withdrawn: "The offer was withdrawn",
  expired: "The offer expired",
  awarded: "Given to you — dispatch still books it and runs the pre-departure check",
  not_selected: "Given to somebody else",
};

const AVAILABILITY_WORDS: Record<string, string> = {
  available: "You declared yourself available",
  available_for_overtime: "You declared yourself available for overtime",
  on_call: "You declared yourself on call",
  unavailable: "You declared yourself unavailable",
  undeclared: "No availability declared for this time",
};

/** The rule's codes that are facts excluding a person, as opposed to things not established. */
const EXCLUDING = new Set(["not_in_organization", "on_approved_leave", "not_rostered", "wrong_role", "overlaps_existing", "licence_expired", "qualification_expired"]);

const mentions = (detail: string, code: string) => detail.toLowerCase().includes(code.toLowerCase());

export function presentOpenWork(post: PostForCard, me: PreviewForCard | null, offer: OfferForCard): OpenWorkCard {
  const reasons = me?.reasons ?? [];
  const has = (code: string) => reasons.some(r => r.code === code);
  // Whether the person may take it is the one rule's answer; `verdict` only says how it was reached.
  const eligible = !!me && (me.eligible ?? me.verdict === "eligible");

  const facts = [
    post.requiredRole,
    post.location ?? post.regionCode ?? "Location not given",
    `${when(post.startsAt)} → ${when(post.endsAt)}`,
    post.estimatedHours ? `Estimated ${post.estimatedHours} h` : "Duration as posted",
    ...(post.overtime ? ["Overtime eligible"] : []),
    ...(post.priority !== "normal" ? [`Priority: ${post.priority}`] : []),
  ];

  const requirements: RequirementLine[] = [];
  const licence = reasons.find(r => r.code === "licence_expired" || r.code === "no_licence_recorded");
  requirements.push({
    label: "Driver licence",
    mark: !me ? "unknown" : licence?.code === "licence_expired" ? "missing" : licence ? "unknown" : "held",
    detail: !me ? "Not checked yet" : licence?.detail ?? null,
  });
  for (const q of post.requiredQualifications) {
    const expired = reasons.find(r => r.code === "qualification_expired" && mentions(r.detail, q));
    const unknown = reasons.find(r => (r.code === "qualification_unknown" || r.code === "qualification_unverified") && mentions(r.detail, q));
    requirements.push({
      label: q,
      mark: expired ? "missing" : unknown || !me ? "unknown" : "held",
      detail: expired?.detail ?? unknown?.detail ?? (!me ? "Not checked yet" : null),
    });
  }
  if (post.requiredEquipmentClass) {
    // The card has no answer for the equipment; the award's readiness check does.
    requirements.push({ label: `Equipment: ${post.requiredEquipmentClass}`, mark: "unknown", detail: "Checked when the work is given" });
  }
  for (const r of reasons) {
    if (r.code === "on_approved_leave") requirements.push({ label: "Not on leave", mark: "missing", detail: r.detail });
    if (r.code === "not_rostered") requirements.push({ label: "Rostered on", mark: "missing", detail: r.detail });
    if (r.code === "overlaps_existing") requirements.push({ label: "No other work at this time", mark: "missing", detail: r.detail });
    if (r.code === "wrong_role") requirements.push({ label: `Role: ${post.requiredRole}`, mark: "missing", detail: r.detail });
    if (r.code === "not_in_organization") requirements.push({ label: "In this organization", mark: "missing", detail: r.detail });
  }
  for (const b of me?.readinessBlockers ?? []) {
    requirements.push({ label: b.detail, mark: "missing", detail: "A readiness finding — dispatch's check decides it when the work is given" });
  }
  for (const capability of me?.readinessNotEvaluated ?? []) {
    requirements.push({ label: capability, mark: "unknown", detail: "Not evaluated — checked when the work is given" });
  }

  const verdict: OpenWorkCard["verdict"] =
    !me ? { label: "Not checked yet", tone: "unknown" }
    : eligible ? { label: "Eligible from what is on record", tone: "ok" }
    : me.verdict === "unknown" ? { label: "Not established from what is on record — that refuses, as a failed check does", tone: "unknown" }
    : { label: "Not eligible from what is on record", tone: "blocked" };

  const excluding = reasons.find(r => EXCLUDING.has(r.code));
  const first = excluding ?? reasons[0];
  const open = post.status === "open";
  // Saying you would take it is refused unless the rule says you may; declining never is.
  const canRespond = open && eligible;
  const canDecline = open;
  const actionNote = !open ? `This post is ${post.status}; it takes no responses`
    : me && !eligible && first ? `${excluding ? "A recorded fact excludes you" : "Not established"}: ${first.detail}. You can still decline.`
    : null;
  const notes = (me?.availabilityNotes ?? []).map(n => n.detail);

  return {
    postRef: post.postRef, title: post.title, facts, requirements, verdict,
    availability: [AVAILABILITY_WORDS[me?.availability ?? "undeclared"] ?? AVAILABILITY_WORDS.undeclared!, ...notes].join(". "),
    canRespond, canDecline, actionNote,
    offer: offer ? { offerRef: offer.offerRef, label: OFFER_LABELS[offer.status] ?? "Offer status not recognised by this version", answerable: offer.status === "offered" } : null,
  };
}

/** A person's own standing response, in their words. */
export function presentResponse(response: string | null): string | null {
  switch (response) {
    case "interested": return "You said you are interested";
    case "available": return "You said you are available";
    case "request_assignment": return "You asked to be given this work";
    case "declined": return "You declined";
    default: return null;
  }
}

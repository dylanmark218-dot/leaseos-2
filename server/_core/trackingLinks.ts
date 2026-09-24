/**
 * 0175 — One-time job tracking links: pure decisions.
 *
 * A link is a random token that projects one job to one recipient without an account. The
 * router stores and the gate enforces; this module decides. Nothing here touches a database.
 *
 * Secrets: the token is 32 random bytes, base64url; only its SHA-256 is stored, so a database
 * read never yields a usable link. A link never names a database id in its URL.
 *
 * Two expiries, deliberately separate: the LINK expires (`expiresAt`, `maxAccessCount`, revocation)
 * and, inside that, LIVE tracking expires (`liveUntilRule`). Documents and the open ticket stay
 * readable for the life of the link; the unit's position and live status stop under the live rule.
 */
import { createHash, randomBytes } from "node:crypto";

export const TRACKING_TOKEN_BYTES = 32;
/** A fix older than this is presented as stale, never as live. */
export const STALE_LOCATION_MINUTES = 15;

export type TrackingScope = {
  /** Job status, timeline, unit identity, ETA. */
  status: boolean;
  /** Loads and disposal tickets. */
  loads: boolean;
  /** Released documents. */
  documents: boolean;
  /** The open service ticket's customer-visible lines and accrued amount. */
  billing: boolean;
  /** Acknowledge, approve, dispute, comment, sign. */
  act: boolean;
};

export const DEFAULT_SCOPE: TrackingScope = { status: true, loads: true, documents: true, billing: false, act: false };

export type LocationMode = "none" | "approximate" | "live";
export type LiveUntilRule = "until_completion" | "hours_after_completion" | "custom" | "manual";
export type LinkStatus = "active" | "revoked" | "disabled" | "superseded";

export const newTrackingToken = () => randomBytes(TRACKING_TOKEN_BYTES).toString("base64url");
export const hashTrackingToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** A client address is kept only as a keyed hash; the key is per deployment. */
export const hashClientAddress = (address: string | null | undefined, salt: string) =>
  address ? createHash("sha256").update(`${salt}:${address}`).digest("hex") : null;

/** The token, as it travels: base64url of 32 bytes, nothing else is even hashed. */
export function tokenShapeValid(token: string): boolean {
  return /^[A-Za-z0-9_-]{40,48}$/.test(token);
}

export function parseScope(json: string | null | undefined): TrackingScope {
  if (!json) return { ...DEFAULT_SCOPE };
  try {
    const raw = JSON.parse(json) as Partial<Record<keyof TrackingScope, unknown>>;
    return {
      status: raw.status === true,
      loads: raw.loads === true,
      documents: raw.documents === true,
      billing: raw.billing === true,
      act: raw.act === true,
    };
  } catch {
    // A scope that cannot be read grants nothing.
    return { status: false, loads: false, documents: false, billing: false, act: false };
  }
}

export const serializeScope = (scope: TrackingScope) => JSON.stringify({ status: scope.status, loads: scope.loads, documents: scope.documents, billing: scope.billing, act: scope.act });

export type LinkRow = {
  status: LinkStatus;
  expiresAt: Date | null;
  maxAccessCount: number | null;
  accessCount: number;
};

/** May this link be used now? Every "no" is a named reason, and none of them says whether the job exists. */
export function linkCheck(link: LinkRow, now: Date): { allowed: boolean; reason: string | null } {
  if (link.status === "revoked") return { allowed: false, reason: "This tracking link has been revoked" };
  if (link.status === "disabled") return { allowed: false, reason: "This tracking link is disabled" };
  if (link.status === "superseded") return { allowed: false, reason: "This tracking link was replaced — ask for the current one" };
  if (link.expiresAt && now >= link.expiresAt) return { allowed: false, reason: "This tracking link has expired" };
  if (link.maxAccessCount != null && link.accessCount >= link.maxAccessCount) return { allowed: false, reason: "This tracking link has reached its access limit" };
  return { allowed: true, reason: null };
}

export type LiveWindowInput = {
  liveUntilRule: LiveUntilRule;
  liveGraceHours: number | null;
  liveExpiresAt: Date | null;
  jobCompletedAt: Date | null;
  linkExpiresAt: Date | null;
  now: Date;
};

/**
 * Is live tracking (status timeline, position, ETA) still available on this link? Documents and
 * billing do not consult this; they follow the link itself.
 */
export function liveWindow(i: LiveWindowInput): { live: boolean; reason: string; until: Date | null } {
  if (i.linkExpiresAt && i.now >= i.linkExpiresAt) return { live: false, reason: "link expired", until: i.linkExpiresAt };
  switch (i.liveUntilRule) {
    case "manual":
      return { live: true, reason: "until revoked", until: null };
    case "custom": {
      if (!i.liveExpiresAt) return { live: false, reason: "no custom live expiry recorded — live tracking off", until: null };
      return i.now < i.liveExpiresAt ? { live: true, reason: "until the custom date", until: i.liveExpiresAt } : { live: false, reason: "custom live window ended", until: i.liveExpiresAt };
    }
    case "until_completion":
      return i.jobCompletedAt ? { live: false, reason: "job complete — live tracking ended at completion", until: i.jobCompletedAt } : { live: true, reason: "until job completion", until: null };
    case "hours_after_completion": {
      if (!i.jobCompletedAt) return { live: true, reason: "until job completion plus grace", until: null };
      const hours = i.liveGraceHours ?? 24;
      const until = new Date(i.jobCompletedAt.getTime() + hours * 3_600_000);
      return i.now < until ? { live: true, reason: `${hours} h after completion`, until } : { live: false, reason: `live tracking ended ${hours} h after completion`, until };
    }
  }
}

/** The named presets a dispatcher chooses from; a custom date or manual revocation are the other two. */
export const LIVE_PRESETS: Record<"until_completion" | "24h" | "7d" | "30d", { liveUntilRule: LiveUntilRule; liveGraceHours: number | null }> = {
  until_completion: { liveUntilRule: "until_completion", liveGraceHours: null },
  "24h": { liveUntilRule: "hours_after_completion", liveGraceHours: 24 },
  "7d": { liveUntilRule: "hours_after_completion", liveGraceHours: 24 * 7 },
  "30d": { liveUntilRule: "hours_after_completion", liveGraceHours: 24 * 30 },
};

/** The URL the recipient opens; also the QR payload. It carries the token and nothing about the job. */
export function trackingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/t/${token}`;
}

/**
 * What goes into a QR code: the URL, verbatim. Rendering the code is a client concern; this is the
 * contract that the payload never carries a job number, a customer or a location.
 */
export function qrPayload(baseUrl: string, token: string): { payload: string; encoding: "url"; note: string } {
  return { payload: trackingUrl(baseUrl, token), encoding: "url", note: "The payload is the secure URL only; scanning opens the authorized customer view. No job data is encoded." };
}

/** Which scope key a tracking permission needs on the link. */
export const SCOPE_FOR_PERMISSION: Record<"tracking.read" | "tracking.loads" | "tracking.documents" | "tracking.billing" | "tracking.act", keyof TrackingScope> = {
  "tracking.read": "status",
  "tracking.loads": "loads",
  "tracking.documents": "documents",
  "tracking.billing": "billing",
  "tracking.act": "act",
};

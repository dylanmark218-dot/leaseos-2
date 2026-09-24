/**
 * AIL-1A — who owns a piece of learning.
 *
 * Every persistent thing LeaseOS learns belongs to exactly one of four scopes:
 *
 *   GLOBAL        LeaseOS itself. Visible to every organization.
 *   ORGANIZATION  one company. Visible only inside it.
 *   USER          one person, inside one company. Visible only to that person there.
 *   SESSION_JOB   the job, trip or agent run in hand. Context, not durable learning.
 *
 * Four rules carry the module.
 *
 * **Scope is derived, never supplied.** The organization comes from `resolveActingScope()` and the
 * user from the authenticated session. A scope *request* that names an organization or user is
 * refused rather than obeyed — refused, not silently ignored, so a caller that tried learns that it
 * cannot. Model responses, tool arguments, retrieved pages and uploaded documents are never read for
 * identity at all: nothing in this module takes them as input, and the owner is stamped from the
 * session, so an organization named inside them has no path to become one.
 *
 * **The scope is a discriminator, not a pattern of nulls.** "No organization id, therefore global"
 * is the mistake this repository already makes in several places (the commercial default book, the
 * dispatch role catalogue, platform workflow rules). Here the kind is stated, and a missing
 * organization is a refusal.
 *
 * **GLOBAL cannot be reached from a request.** No principal in this system holds platform authority
 * today (owner ruling R-6; trust-governance D5), so `PlatformAuthority` has no constructor at all.
 * Nothing a tenant does can produce a GLOBAL scope, and a request for one is refused by name.
 *
 * **Scope is not permission.** Scope answers "whose information is this?". Authorization answers
 * "may this person do this?" and stays in `roleProcedure` / `authorize()`. Being inside the right
 * scope grants nothing; being outside it refuses everything.
 *
 * Learning moves downward for visibility (a GLOBAL fact is visible to a user) and never upward on its
 * own. This module deliberately has no function that turns one scope kind into a wider one. Promotion
 * — USER to ORGANIZATION, ORGANIZATION to GLOBAL — is a later, governed operation.
 *
 * "AI memory" remains intentionally unsupported: a scope owns explicit, governed records, never a
 * hidden store the model writes to.
 */

import { AmbiguousOrganization, resolveActingScope, type ActingScope } from "./actingScope";
import type { DbOrTx } from "./dbTypes";

/* ------------------------------------------------------------------ */
/* The four scopes                                                     */
/* ------------------------------------------------------------------ */

export const LEARNING_SCOPE_KINDS = ["GLOBAL", "ORGANIZATION", "USER", "SESSION_JOB"] as const;
export type LearningScopeKind = (typeof LEARNING_SCOPE_KINDS)[number];

/** Nothing outside this module can produce these symbols, so nothing outside it can forge a scope. */
declare const learningScopeBrand: unique symbol;
declare const platformAuthorityBrand: unique symbol;
declare const verifiedSubjectBrand: unique symbol;

/**
 * The authority GLOBAL learning needs. **This module exports no way to make one**, on purpose: the
 * principal that would hold it does not exist yet (R-6, D5). It is named, not a role, so the type
 * says what is missing without deciding who will hold it. `users.role = "admin"`, a role grant with
 * `scopeType = "global"`, `ActingScope.global`, a `system` tenant proof and a NULL organization are
 * all *not* this, and a test pins each non-equivalence.
 */
export type PlatformAuthority = { readonly [platformAuthorityBrand]: true; readonly basis: string };

/** How the organization was established, carried so a fallback-derived scope stays visible as one. */
export type ScopeDerivation = ActingScope["derivedFrom"];

/** The operational subjects a SESSION_JOB may be anchored to. Each has a tenant check that exists today. */
export const SESSION_JOB_SUBJECT_KINDS = ["job", "trip", "agent_run"] as const;
export type SessionJobSubjectKind = (typeof SESSION_JOB_SUBJECT_KINDS)[number];
export type SessionJobSubject = { kind: SessionJobSubjectKind; ref: string };

type Branded = { readonly [learningScopeBrand]: true };

export type GlobalScope = Branded & { readonly kind: "GLOBAL"; readonly authority: PlatformAuthority };
export type OrganizationScope = Branded & {
  readonly kind: "ORGANIZATION"; readonly orgRef: string; readonly derivedFrom: ScopeDerivation;
};
export type UserScope = Branded & {
  readonly kind: "USER"; readonly orgRef: string; readonly userId: number; readonly derivedFrom: ScopeDerivation;
};
export type SessionJobScope = Branded & {
  readonly kind: "SESSION_JOB"; readonly orgRef: string; readonly userId: number;
  readonly subject: Readonly<SessionJobSubject>; readonly derivedFrom: ScopeDerivation;
};

export type LearningScope = GlobalScope | OrganizationScope | UserScope | SessionJobScope;
/** Every scope a request can reach. GLOBAL is not among them. */
export type TenantLearningScope = OrganizationScope | UserScope | SessionJobScope;
/** Scopes durable learning may be owned by from a request. SESSION_JOB is context, not learning. */
export type DurableTenantScope = OrganizationScope | UserScope;
/** The acting party reading or writing: always a person, sometimes inside a job. */
export type LearningActor = UserScope | SessionJobScope;

/* ------------------------------------------------------------------ */
/* Refusals                                                            */
/* ------------------------------------------------------------------ */

export type ScopeRefusalCode =
  | "NO_AUTHENTICATED_USER"
  | "AMBIGUOUS_ORGANIZATION"
  | "NO_ORGANIZATION"
  | "SCOPE_IDENTITY_CLAIM_REFUSED"
  | "GLOBAL_REQUIRES_PLATFORM_AUTHORITY"
  | "SESSION_JOB_SUBJECT_UNSUPPORTED"
  | "SESSION_JOB_SUBJECT_NOT_FOUND"
  | "SESSION_JOB_NOT_DURABLE"
  | "CROSS_ORGANIZATION"
  | "OTHER_USER"
  | "OTHER_SUBJECT"
  | "SCOPE_KIND_UNKNOWN";

export class LearningScopeRefused extends Error {
  constructor(readonly code: ScopeRefusalCode, message: string) {
    super(`${code}: ${message}`);
  }
}

const refuse = (code: ScopeRefusalCode, message: string): never => {
  throw new LearningScopeRefused(code, message);
};

/* ------------------------------------------------------------------ */
/* What a caller may ask for                                           */
/* ------------------------------------------------------------------ */

/**
 * A request names a scope KIND, and for SESSION_JOB the subject. It carries no organization and no
 * user — those are never the caller's to state.
 */
export type ScopeRequest =
  | { kind: "ORGANIZATION" }
  | { kind: "USER" }
  | { kind: "SESSION_JOB"; subject: SessionJobSubject }
  | { kind: "GLOBAL" };

/**
 * Keys that assert identity. A request (or a subject inside one) carrying any of them is refused,
 * whatever its value — including one that happens to match the caller's own scope, because a value
 * that is right today is a habit that is wrong tomorrow. Case and separators are ignored, so
 * `organization_id`, `OrganizationID` and `tenant-id` are the same claim.
 */
const IDENTITY_KEYS = new Set([
  "organizationid", "organization", "orgref", "orgid", "org", "tenantid", "tenant",
  "userid", "user", "actoruserid", "principaluserid", "createdbyuserid", "ownerid", "ownerorgref",
  "scope", "scopekind", "authority", "platformauthority",
].map(k => k.toLowerCase()));

const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");

/** Identity-asserting keys found in a value, for the refusal message. Walks plain objects only. */
export function identityClaimsIn(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => identityClaimsIn(v, `${path}[${i}]`));
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    if (IDENTITY_KEYS.has(normalizeKey(k))) out.push(here);
    out.push(...identityClaimsIn(v, here));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Construction — only from trusted inputs                             */
/* ------------------------------------------------------------------ */

const brand = <T>(v: object): T => v as T;

const requireUser = (userId: number): number =>
  Number.isInteger(userId) && userId > 0
    ? userId
    : refuse("NO_AUTHENTICATED_USER", "a learning scope needs an authenticated person; a cron or synthetic principal has none");

const requireOrganization = (acting: ActingScope): string =>
  typeof acting.tenantId === "string" && acting.tenantId.trim().length > 0
    ? acting.tenantId
    : refuse("NO_ORGANIZATION", "the acting scope names no organization, and a missing organization is not global");

/** The organization the caller is acting for, from the server's own resolution. */
export function organizationScopeFrom(acting: ActingScope): OrganizationScope {
  return brand<OrganizationScope>({ kind: "ORGANIZATION", orgRef: requireOrganization(acting), derivedFrom: acting.derivedFrom });
}

/** The caller as a person inside their organization. `userId` is the authenticated session's. */
export function userScopeFrom(acting: ActingScope, userId: number): UserScope {
  return brand<UserScope>({
    kind: "USER", orgRef: requireOrganization(acting), userId: requireUser(userId), derivedFrom: acting.derivedFrom,
  });
}

/**
 * Proof that a SESSION_JOB subject was checked against an organization. Produced only by
 * `verifySessionJobSubject`, so a scope cannot be anchored to a subject nobody looked up.
 */
export type VerifiedSubject = {
  readonly [verifiedSubjectBrand]: true; readonly orgRef: string; readonly subject: Readonly<SessionJobSubject>;
};

/**
 * Looks a subject up for one organization. Answers false for "does not exist" and "belongs to
 * someone else" alike — the caller must not be able to tell the two apart. The database version is
 * `sessionJobSubjectInScope` in `server/db.ts`; tests inject their own.
 */
export type SubjectVerifier = (subject: SessionJobSubject, orgRef: string) => Promise<boolean>;

export async function verifySessionJobSubject(
  subject: SessionJobSubject, orgRef: string, verifier: SubjectVerifier,
): Promise<VerifiedSubject> {
  if (!SESSION_JOB_SUBJECT_KINDS.includes(subject.kind)) {
    refuse("SESSION_JOB_SUBJECT_UNSUPPORTED", `a session/job scope cannot be anchored to "${String(subject.kind)}"; no tenant check exists for it`);
  }
  if (typeof subject.ref !== "string" || subject.ref.trim().length === 0) {
    refuse("SESSION_JOB_SUBJECT_NOT_FOUND", `${subject.kind} not found`);
  }
  const found = await verifier({ kind: subject.kind, ref: subject.ref }, orgRef);
  if (!found) refuse("SESSION_JOB_SUBJECT_NOT_FOUND", `${subject.kind} ${subject.ref} not found`);
  return brand<VerifiedSubject>({ orgRef, subject: { kind: subject.kind, ref: subject.ref } });
}

export function sessionJobScopeFrom(acting: ActingScope, userId: number, verified: VerifiedSubject): SessionJobScope {
  const orgRef = requireOrganization(acting);
  if (verified.orgRef !== orgRef) {
    refuse("SESSION_JOB_SUBJECT_NOT_FOUND", `${verified.subject.kind} ${verified.subject.ref} not found`);
  }
  return brand<SessionJobScope>({
    kind: "SESSION_JOB", orgRef, userId: requireUser(userId), subject: verified.subject, derivedFrom: acting.derivedFrom,
  });
}

/**
 * The one resolver: from an authenticated user and a requested kind to a trusted scope.
 *
 * The organization comes from `resolveActingScope(db, userId)` and nothing else. Two live
 * memberships are refused rather than guessed between. GLOBAL is refused by name. A request that
 * carries an identity claim anywhere in it is refused before anything is resolved.
 */
export async function resolveLearningScope(args: {
  db: DbOrTx;
  userId: number;
  request: ScopeRequest;
  verifySubject: SubjectVerifier;
}): Promise<TenantLearningScope> {
  const claims = identityClaimsIn(args.request);
  if (claims.length) {
    refuse("SCOPE_IDENTITY_CLAIM_REFUSED", `the request states ${claims.join(", ")}; organization and user come from the session, never from a request`);
  }
  const kind = (args.request as { kind?: unknown }).kind;
  if (kind === "GLOBAL") {
    refuse("GLOBAL_REQUIRES_PLATFORM_AUTHORITY", "no principal holds platform authority (R-6, D5); GLOBAL learning is not reachable from a request");
  }
  if (kind !== "ORGANIZATION" && kind !== "USER" && kind !== "SESSION_JOB") {
    refuse("SCOPE_KIND_UNKNOWN", `"${String(kind)}" is not a learning scope`);
  }
  const userId = requireUser(args.userId);

  let acting: ActingScope;
  try {
    acting = await resolveActingScope(args.db, userId);
  } catch (e) {
    if (e instanceof AmbiguousOrganization) {
      return refuse("AMBIGUOUS_ORGANIZATION", "the person belongs to more than one organization and which one they act for has not been established");
    }
    throw e;
  }

  if (kind === "ORGANIZATION") return organizationScopeFrom(acting);
  if (kind === "USER") return userScopeFrom(acting, userId);
  const subject = (args.request as { subject?: SessionJobSubject }).subject;
  if (!subject || typeof subject !== "object") refuse("SESSION_JOB_SUBJECT_NOT_FOUND", "a session/job scope needs a subject");
  const verified = await verifySessionJobSubject(subject!, requireOrganization(acting), args.verifySubject);
  return sessionJobScopeFrom(acting, userId, verified);
}

/* ------------------------------------------------------------------ */
/* Containment                                                         */
/* ------------------------------------------------------------------ */

export type Containment = { allowed: true } | { allowed: false; code: ScopeRefusalCode; reason: string };
const ALLOWED: Containment = { allowed: true };
const no = (code: ScopeRefusalCode, reason: string): Containment => ({ allowed: false, code, reason });

/**
 * May an artifact owned by `artifact` be seen by `actor`? Visibility flows downward only:
 * GLOBAL to everyone; ORGANIZATION inside that organization; USER to that person inside that
 * organization; SESSION_JOB to that person, in that organization, in that same job.
 *
 * Scope only. The caller's permission to read the kind of thing is a separate check.
 */
export function canSee(actor: LearningActor, artifact: LearningScope): Containment {
  switch (artifact.kind) {
    case "GLOBAL":
      return ALLOWED;
    case "ORGANIZATION":
      return artifact.orgRef === actor.orgRef ? ALLOWED : no("CROSS_ORGANIZATION", "another organization's learning");
    case "USER":
      if (artifact.orgRef !== actor.orgRef) return no("CROSS_ORGANIZATION", "another organization's learning");
      return artifact.userId === actor.userId ? ALLOWED : no("OTHER_USER", "another person's private learning");
    case "SESSION_JOB":
      if (artifact.orgRef !== actor.orgRef) return no("CROSS_ORGANIZATION", "another organization's learning");
      if (artifact.userId !== actor.userId) return no("OTHER_USER", "another person's session context");
      if (actor.kind !== "SESSION_JOB" || actor.subject.kind !== artifact.subject.kind || actor.subject.ref !== artifact.subject.ref) {
        return no("OTHER_SUBJECT", "context from a different job, trip or run");
      }
      return ALLOWED;
    default:
      return no("SCOPE_KIND_UNKNOWN", "unknown scope kind");
  }
}

/**
 * May `actor` create or change something owned by `target`? A tenant-originated write can never
 * target GLOBAL, another organization, another person's USER scope, or another job's context.
 *
 * Scope only, again: this refuses writes outside the actor's containment; it never grants one.
 */
export function canTarget(actor: LearningActor, target: LearningScope): Containment {
  if (target.kind === "GLOBAL") {
    return no("GLOBAL_REQUIRES_PLATFORM_AUTHORITY", "tenant-originated learning cannot be written as GLOBAL; promotion is a separate governed operation");
  }
  return canSee(actor, target);
}

/* ------------------------------------------------------------------ */
/* Durability                                                          */
/* ------------------------------------------------------------------ */

/**
 * SESSION_JOB is context. It expires with its job or session under a future policy, and it never
 * becomes USER or ORGANIZATION learning by itself — that takes a learning candidate and a person.
 */
export const isDurableScopeKind = (kind: LearningScopeKind): boolean => kind !== "SESSION_JOB";

/** Refuses a scope that may not own durable learning. Returns it narrowed when it may. */
export function requireDurableTenantScope(scope: TenantLearningScope): DurableTenantScope {
  // Read defensively: an untyped caller may pass nothing, or a GLOBAL scope it should not hold.
  const kind = (scope as { kind?: unknown } | null | undefined)?.kind;
  if (kind === "SESSION_JOB") {
    refuse("SESSION_JOB_NOT_DURABLE", "session/job context does not become durable learning without a governed learning candidate");
  }
  if (kind === "GLOBAL") {
    refuse("GLOBAL_REQUIRES_PLATFORM_AUTHORITY", "tenant learning cannot be owned by GLOBAL; promotion is a separate governed operation");
  }
  if (kind !== "ORGANIZATION" && kind !== "USER") {
    refuse("NO_ORGANIZATION", "learning must have an owner; a missing owner is not global");
  }
  return scope as DurableTenantScope;
}

/* ------------------------------------------------------------------ */
/* What a scope may hold                                               */
/* ------------------------------------------------------------------ */

/**
 * Settings a USER scope may carry: how LeaseOS presents itself to one person. Nothing here can
 * create operational authority — a preference changes the answer's shape, never its substance.
 */
export const USER_SETTING_CLASSES = ["presentation", "accessibility", "answer_detail", "input_mode", "terminology_display"] as const;

/**
 * Settings that only an organization (or LeaseOS itself) may hold. A user preference can never
 * weaken, replace or override one of these.
 */
export const ORGANIZATION_SETTING_CLASSES = [
  "safety", "compliance", "hours_of_service", "dangerous_goods", "permits", "permissions",
  "automation", "dispatch_authority", "job_assignment", "regulatory", "company_procedure",
] as const;

export type SettingClass = (typeof USER_SETTING_CLASSES)[number] | (typeof ORGANIZATION_SETTING_CLASSES)[number];

export function scopeMayHold(kind: LearningScopeKind, settingClass: SettingClass): boolean {
  if (kind === "GLOBAL" || kind === "ORGANIZATION") return true;
  // USER and SESSION_JOB shape presentation only.
  return (USER_SETTING_CLASSES as readonly string[]).includes(settingClass);
}

/* ------------------------------------------------------------------ */
/* Rows keyed by tenantId                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether a row keyed by `tenantId` belongs to the acting organization. Strict equality: a NULL,
 * empty or missing tenant belongs to nobody — never to everybody. A missing row is not in scope,
 * so "not found" and "not yours" read the same to the caller.
 */
export function rowInTenant(row: { tenantId: string | null } | null | undefined, scope: { tenantId: string }): boolean {
  if (!row) return false;
  if (typeof row.tenantId !== "string" || row.tenantId.length === 0) return false;
  if (typeof scope.tenantId !== "string" || scope.tenantId.length === 0) return false;
  return row.tenantId === scope.tenantId;
}

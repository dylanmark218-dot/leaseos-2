/**
 * v22.20 — the crew chat, and what being in it does not entitle you to.
 *
 * Pure. No network, no database.
 *
 * **The rule worth stating first.** Being added to a crew grants crew things.
 * It does not grant payroll, another crew's conversation, management channels,
 * company financials, or a client's private records. That sounds obvious until
 * membership is automatic: dispatch assigns somebody to a job at 06:00 and a
 * permission set assembles itself, and if that set is built by *adding* to
 * whatever the person already had, the fast path quietly becomes the privileged
 * one. So crew permissions are enumerated, and everything outside the list is
 * absent rather than merely unmentioned.
 *
 * **Membership follows the assignment, history does not follow the member.**
 * Leaving a crew ends what you can read next; it does not unwrite what you
 * said. The messages stay on the company record — that is where a billing
 * dispute is answered from months later — and the person simply stops
 * receiving new ones.
 *
 * **A closed job's room stops taking messages and keeps them all.** The
 * conversation is part of the job record, which is worth nothing if it can be
 * appended to after the invoice is disputed.
 */

export type CrewType =
  | "permanent" | "job" | "shift" | "site" | "unit" | "project" | "emergency";

export type CrewRole =
  | "supervisor" | "driver" | "operator" | "labourer" | "mechanic" | "safety" | "dispatch" | "other";

export type MembershipSource = "manual" | "dispatch" | "job_assignment" | "shift_assignment";

export type Crew = {
  crewRef: string;
  name: string;
  type: CrewType;
  supervisorUserId: number | null;
  jobRef: string | null;
  /** A job crew closes with its job; a permanent crew does not. */
  state: "active" | "read_only" | "archived";
};

export type CrewMember = {
  crewRef: string;
  userId: number;
  crewRole: CrewRole;
  source: MembershipSource;
  joinedAt: Date;
  /** Set when the assignment ends. The record stays either way. */
  leftAt: Date | null;
};

/* ------------------------------------------------------------------ */
/* The floor                                                            */
/* ------------------------------------------------------------------ */

export type CrewPermission =
  | "crew.read" | "crew.post" | "crew.attach"
  | "crew.job.read" | "crew.job.documents.read" | "crew.safety.read"
  | "crew.broadcast" | "crew.members.manage";

/**
 * Everything crew membership can ever confer. Enumerated rather than derived,
 * so a new crew role cannot widen it by accident.
 */
export const CREW_PERMISSIONS: readonly CrewPermission[] = [
  "crew.read", "crew.post", "crew.attach",
  "crew.job.read", "crew.job.documents.read", "crew.safety.read",
  "crew.broadcast", "crew.members.manage",
];

const BY_ROLE: Record<CrewRole, readonly CrewPermission[]> = {
  supervisor: ["crew.read", "crew.post", "crew.attach", "crew.job.read", "crew.job.documents.read", "crew.safety.read", "crew.broadcast", "crew.members.manage"],
  dispatch: ["crew.read", "crew.post", "crew.attach", "crew.job.read", "crew.job.documents.read", "crew.safety.read", "crew.broadcast"],
  safety: ["crew.read", "crew.post", "crew.attach", "crew.safety.read", "crew.broadcast"],
  mechanic: ["crew.read", "crew.post", "crew.attach", "crew.safety.read"],
  driver: ["crew.read", "crew.post", "crew.attach", "crew.job.read", "crew.job.documents.read", "crew.safety.read"],
  operator: ["crew.read", "crew.post", "crew.attach", "crew.job.read", "crew.job.documents.read", "crew.safety.read"],
  labourer: ["crew.read", "crew.post", "crew.attach", "crew.safety.read"],
  other: ["crew.read"],
};

/**
 * What a crew role confers, and nothing else.
 *
 * Returns a fresh list every time rather than a reference into a shared table,
 * because a caller that mutated the result would be editing the floor.
 */
export function crewPermissions(role: CrewRole): CrewPermission[] {
  return [...BY_ROLE[role]];
}

/**
 * The permissions a person actually holds, with crew membership contributing
 * only crew permissions.
 *
 * This is the function that keeps the floor honest: whatever a person already
 * has stays theirs, and the crew adds crew things to it. It cannot add anything
 * else, because it has nothing else to add.
 */
export function effectivePermissions(existing: readonly string[], memberships: readonly { crewRole: CrewRole; active: boolean }[]): string[] {
  const fromCrews = memberships.filter(m => m.active).flatMap(m => crewPermissions(m.crewRole));
  return Array.from(new Set([...existing, ...fromCrews]));
}

/* ------------------------------------------------------------------ */
/* Membership follows the assignment                                    */
/* ------------------------------------------------------------------ */

export type Assignment = { userId: number; crewRef: string; crewRole: CrewRole; from: Date; to: Date | null };

export const isCurrentMember = (m: CrewMember, at: Date): boolean =>
  m.joinedAt.getTime() <= at.getTime() && (!m.leftAt || m.leftAt.getTime() > at.getTime());

/**
 * Derive membership from dispatch assignments.
 *
 * Ending an assignment sets `leftAt` rather than removing the row: the person
 * was in that crew, said things in it, and deleting the membership would make
 * their messages authored by somebody who was never there.
 */
export function membershipFrom(assignments: readonly Assignment[], existing: readonly CrewMember[]): CrewMember[] {
  const out = existing.map(m => ({ ...m }));
  for (const a of assignments) {
    const found = out.find(m => m.crewRef === a.crewRef && m.userId === a.userId && !m.leftAt);
    if (found) {
      if (a.to) found.leftAt = a.to;
      continue;
    }
    out.push({ crewRef: a.crewRef, userId: a.userId, crewRole: a.crewRole, source: "dispatch", joinedAt: a.from, leftAt: a.to });
  }
  return out;
}

export type ReadAccess = { allowed: boolean; reason: string };

/**
 * Whether somebody may read a message in a crew channel.
 *
 * A former member can read what was posted while they were there and nothing
 * after. They were present for the first and absent for the second, and a chat
 * that showed them either more or less than that would be misrepresenting the
 * record.
 */
export function mayReadMessage(member: CrewMember | undefined, postedAt: Date): ReadAccess {
  if (!member) return { allowed: false, reason: "Not a member of this crew" };
  if (postedAt.getTime() < member.joinedAt.getTime()) {
    return { allowed: false, reason: "Posted before this person joined the crew" };
  }
  if (member.leftAt && postedAt.getTime() >= member.leftAt.getTime()) {
    return { allowed: false, reason: "Posted after this person left the crew" };
  }
  return { allowed: true, reason: member.leftAt ? "Posted while they were a member" : "Current member" };
}

export class ChannelClosed extends Error {}

/**
 * Whether the crew still takes messages.
 *
 * A job crew goes read-only when the job closes, and the conversation becomes
 * part of the job record. A record that can still be appended to after an
 * invoice is disputed is not a record.
 */
export function mayPost(crew: Crew, member: CrewMember | undefined, at: Date): ReadAccess {
  if (crew.state !== "active") {
    return { allowed: false, reason: `${crew.name} is ${crew.state} — the conversation is part of the job record now` };
  }
  if (!member || !isCurrentMember(member, at)) return { allowed: false, reason: "Not a current member of this crew" };
  if (!crewPermissions(member.crewRole).includes("crew.post")) {
    return { allowed: false, reason: `A ${member.crewRole} in this crew may read and not post` };
  }
  return { allowed: true, reason: "Current member" };
}

/** Close a job crew. Nothing is deleted; it stops accepting. */
export function closeWithJob(crew: Crew): Crew {
  if (crew.type !== "job") throw new ChannelClosed(`${crew.name} is a ${crew.type} crew and does not close with a job`);
  return { ...crew, state: "read_only" };
}

/* ------------------------------------------------------------------ */
/* Mentions reach their scope                                           */
/* ------------------------------------------------------------------ */

export type MentionScope = "crew" | CrewRole | { unitRef: string } | { userId: number };

/**
 * Who an @mention elevates a notification for.
 *
 * `@drivers` reaching everybody is how a crew learns to ignore mentions, and
 * then the one that mattered is ignored too.
 */
export function mentionReaches(
  scope: MentionScope,
  members: readonly CrewMember[],
  at: Date,
  unitOf: (userId: number) => string | null = () => null,
): number[] {
  const current = members.filter(m => isCurrentMember(m, at));
  if (scope === "crew") return current.map(m => m.userId);
  if (typeof scope === "object") {
    if ("userId" in scope) return current.filter(m => m.userId === scope.userId).map(m => m.userId);
    return current.filter(m => unitOf(m.userId) === scope.unitRef).map(m => m.userId);
  }
  return current.filter(m => m.crewRole === scope).map(m => m.userId);
}

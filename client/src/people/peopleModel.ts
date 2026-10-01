/**
 * B23.2 — the People & Access view model.
 *
 * Pure. It shapes what the server already decided into what the screen draws,
 * and decides nothing itself. Every question that matters — may this person be
 * granted this role, does this default workspace exist for them, is this the
 * last administrator — is answered by the server on the write, and this module
 * exists so a person is not offered a control that will refuse them, not so the
 * control is locked.
 *
 * The role list and the workspace preview both arrive from the server
 * (`people.roleCatalogue`, `people.detail`). There is deliberately no role
 * registry in the client: a second list is a second thing to drift.
 */

export type PersonRow = {
  userId: number;
  displayName: string;
  membershipStatus: "active" | "suspended" | "ended";
  membershipType: string;
  roles: readonly string[];
  workspaces: readonly string[];
  defaultWorkspace: string | null;
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
  live: boolean;
};

export type InvitationRow = {
  invitationRef: string;
  emailHint: string | null;
  displayNameHint: string | null;
  roles: readonly string[];
  view: "pending" | "accepted" | "cancelled" | "expired";
  expiresAt: string | Date;
  invitedAt: string | Date;
};

export type ResolutionRow = {
  legacyGrantId: number;
  userId: number;
  displayName: string;
  role: string;
  grantedAt: string | Date;
};

export type SectionKey = "active" | "invitations" | "resolution" | "former";

export const SECTIONS: readonly { key: SectionKey; label: string; hint: string }[] = [
  { key: "active", label: "Active people", hint: "Everyone who can work for this organization today" },
  { key: "invitations", label: "Pending invitations", hint: "Sent, not yet accepted" },
  { key: "resolution", label: "Access needs resolution", hint: "Old grants that authorize nothing until re-issued here" },
  { key: "former", label: "Former", hint: "Access removed — the person's LeaseOS account is untouched" },
];

/** Active people are the live ones; Former is everybody else. Nothing is hidden. */
export function partitionPeople(people: readonly PersonRow[]): { active: PersonRow[]; former: PersonRow[] } {
  return {
    active: people.filter(p => p.live),
    former: people.filter(p => !p.live),
  };
}

/** Pending first, because that is the list an administrator acts on. */
export function sortInvitations(rows: readonly InvitationRow[]): InvitationRow[] {
  const rank: Record<InvitationRow["view"], number> = { pending: 0, expired: 1, cancelled: 2, accepted: 3 };
  return [...rows].sort((a, b) => rank[a.view] - rank[b.view] || a.invitationRef.localeCompare(b.invitationRef));
}

/**
 * The count beside a section name.
 *
 * `resolution` deliberately shows its number even when zero is the good news:
 * an administrator should be able to see that nothing is waiting without
 * clicking, and a badge that disappears is indistinguishable from a badge that
 * failed to load.
 */
export function sectionCount(
  key: SectionKey,
  data: { active: number; former: number; pendingInvitations: number; resolution: number }
): number {
  switch (key) {
    case "active": return data.active;
    case "former": return data.former;
    case "invitations": return data.pendingInvitations;
    case "resolution": return data.resolution;
  }
}

/**
 * Is this role set different from the one the person holds?
 *
 * Drives whether Save is enabled. Order-insensitive, because a checkbox list is
 * a set and re-rendering it must not look like a change.
 */
export function rolesChanged(held: readonly string[], selected: readonly string[]): boolean {
  if (held.length !== selected.length) return true;
  const a = [...held].sort();
  const b = [...selected].sort();
  return a.some((r, i) => r !== b[i]);
}

/**
 * Which default-workspace options to offer: only workspaces the SELECTED roles
 * open, plus "no preference".
 *
 * Computed from the selection rather than from what is saved, so an
 * administrator who unticks Mechanic immediately stops being offered the
 * mechanic workspace as a landing page. The server refuses the same thing; this
 * keeps the screen from proposing it.
 */
export function defaultWorkspaceChoices(
  workspaceOptions: readonly { key: string; label: string }[]
): readonly { key: string | null; label: string }[] {
  return [{ key: null, label: "No preference" }, ...workspaceOptions.map(w => ({ key: w.key, label: w.label }))];
}

/** A human date, or an em dash. Dates arrive as strings over the wire. */
export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/**
 * How an invitation's state should read, in words rather than a colour.
 *
 * Paired with a text label everywhere it is drawn, because state carried only
 * by colour is state a screen reader cannot report and a colour-blind reader
 * cannot see.
 */
export function invitationTone(view: InvitationRow["view"]): { label: string; tone: "waiting" | "done" | "stale" } {
  switch (view) {
    case "pending": return { label: "Pending", tone: "waiting" };
    case "accepted": return { label: "Accepted", tone: "done" };
    case "cancelled": return { label: "Cancelled", tone: "stale" };
    case "expired": return { label: "Expired", tone: "stale" };
  }
}

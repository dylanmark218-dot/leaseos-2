/**
 * B23.2 — People & Access, the view.
 *
 * Pure: it renders what the server sent and calls back when somebody acts. It
 * holds no role registry, computes no access and hides nothing that matters —
 * every control it draws leads to a procedure that re-derives the decision from
 * the grant tables and refuses on its own.
 *
 * Scope is said out loud everywhere it matters. "Remove access to ABC
 * Transport", never "Delete Dylan": one LeaseOS account may work for several
 * companies, and an administrator of one of them is ending one relationship.
 *
 * Responsive by structure rather than by breakpoint tricks: a table on a wide
 * screen, the same rows as cards on a phone, both from one list.
 */

import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  defaultWorkspaceChoices,
  invitationTone,
  partitionPeople,
  rolesChanged,
  SECTIONS,
  sectionCount,
  shortDate,
  sortInvitations,
  type InvitationRow,
  type PersonRow,
  type ResolutionRow,
  type SectionKey,
} from "./peopleModel";

export type RoleOption = { role: string; description: string; workspaces: readonly { key: string; label: string }[] };

export type PeopleAccessViewProps = {
  organizationName: string;
  people: readonly PersonRow[];
  invitations: readonly InvitationRow[];
  needsResolution: readonly ResolutionRow[];
  roleCatalogue: readonly RoleOption[];
  /** The person opened, if any, with the workspaces the server says their roles open. */
  selected?: { person: PersonRow; workspaceOptions: readonly { key: string; label: string }[] } | null;
  section?: SectionKey;
  onSection?: (key: SectionKey) => void;
  onOpenPerson?: (userId: number) => void;
  onClosePerson?: () => void;
  onSaveRoles?: (userId: number, roles: string[]) => void;
  onSetDefaultWorkspace?: (userId: number, workspace: string | null) => void;
  onRemoveAccess?: (userId: number) => void;
  onInvite?: (input: { email?: string; displayName?: string; roles: string[] }) => void;
  onCancelInvitation?: (invitationRef: string) => void;
  onResolve?: (legacyGrantId: number) => void;
  /** Shown once, after an invitation is created. Never stored anywhere. */
  issuedLink?: { invitationRef: string; token: string } | null;
  busy?: boolean;
  error?: string | null;
};

const card = "rounded-2xl border border-[#dfe5ee] bg-white";
const muted = "text-sm text-[#5b6b82]";

export function PeopleAccessView(props: PeopleAccessViewProps) {
  const section = props.section ?? "active";
  const { active, former } = useMemo(() => partitionPeople(props.people), [props.people]);
  const invitations = useMemo(() => sortInvitations(props.invitations), [props.invitations]);
  const pendingCount = invitations.filter(i => i.view === "pending").length;

  return (
    <section aria-labelledby="people-access-heading" className="space-y-4">
      <header>
        <h1 id="people-access-heading" className="text-xl font-semibold">
          People &amp; Access
        </h1>
        <p className={muted}>
          Who belongs to {props.organizationName}, and what they may do here. Roles granted here apply to this
          organization only.
        </p>
      </header>

      {props.error ? (
        <p role="alert" className="rounded-xl border border-[#f3c3bd] bg-[#fdf3f2] p-3 text-sm text-[#7a271a]">
          {props.error}
        </p>
      ) : null}

      {/* A real tab set: arrow keys move, Home/End jump, one tab stop for the group. */}
      <div role="tablist" aria-label="People and access sections" className="flex flex-wrap gap-2">
        {SECTIONS.map(s => {
          const count = sectionCount(s.key, {
            active: active.length,
            former: former.length,
            pendingInvitations: pendingCount,
            resolution: props.needsResolution.length,
          });
          const selected = section === s.key;
          return (
            <button
              key={s.key}
              role="tab"
              id={`people-tab-${s.key}`}
              aria-selected={selected}
              aria-controls={`people-panel-${s.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => props.onSection?.(s.key)}
              onKeyDown={e => {
                const i = SECTIONS.findIndex(x => x.key === section);
                const move =
                  e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? SECTIONS.length - 1 : null;
                if (move == null) return;
                e.preventDefault();
                props.onSection?.(SECTIONS[(move + SECTIONS.length) % SECTIONS.length]!.key);
              }}
              className={`rounded-full px-3 py-2 text-sm min-h-11 ${selected ? "bg-[#132a4a] text-white" : "bg-[#eef2f7] text-[#132a4a]"}`}
            >
              {s.label} <span aria-hidden="true">·</span>{" "}
              <span aria-label={`${count} items`}>{count}</span>
            </button>
          );
        })}
      </div>

      {SECTIONS.map(s => (
        <div
          key={s.key}
          role="tabpanel"
          id={`people-panel-${s.key}`}
          aria-labelledby={`people-tab-${s.key}`}
          hidden={section !== s.key}
          tabIndex={0}
        >
          {section !== s.key ? null : (
            <>
              <p className={`${muted} mb-2`}>{s.hint}</p>
              {s.key === "active" ? (
                <PeopleList people={active} onOpen={props.onOpenPerson} emptyMessage="Nobody has accepted an invitation yet." />
              ) : null}
              {s.key === "former" ? (
                <PeopleList
                  people={former}
                  onOpen={props.onOpenPerson}
                  emptyMessage="Nobody has had their access removed."
                  former
                />
              ) : null}
              {s.key === "invitations" ? (
                <Invitations
                  invitations={invitations}
                  roleCatalogue={props.roleCatalogue}
                  onInvite={props.onInvite}
                  onCancel={props.onCancelInvitation}
                  issuedLink={props.issuedLink}
                  busy={props.busy}
                />
              ) : null}
              {s.key === "resolution" ? (
                <Resolution rows={props.needsResolution} onResolve={props.onResolve} busy={props.busy} />
              ) : null}
            </>
          )}
        </div>
      ))}

      {props.selected ? (
        <PersonDetail
          person={props.selected.person}
          workspaceOptions={props.selected.workspaceOptions}
          organizationName={props.organizationName}
          roleCatalogue={props.roleCatalogue}
          onClose={props.onClosePerson}
          onSaveRoles={props.onSaveRoles}
          onSetDefaultWorkspace={props.onSetDefaultWorkspace}
          onRemoveAccess={props.onRemoveAccess}
          busy={props.busy}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function PeopleList(props: {
  people: readonly PersonRow[];
  onOpen?: (userId: number) => void;
  emptyMessage: string;
  former?: boolean;
}) {
  if (props.people.length === 0) return <p className={`${card} p-4 ${muted}`}>{props.emptyMessage}</p>;
  return (
    <>
      {/* Wide screens: a real table, so a screen reader can announce columns. */}
      <table className={`${card} hidden w-full md:table`}>
        <caption className="sr-only">{props.former ? "Former people" : "Active people"}</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[#5b6b82]">
            <th scope="col" className="p-3">Name</th>
            <th scope="col" className="p-3">Status</th>
            <th scope="col" className="p-3">Roles here</th>
            <th scope="col" className="p-3">Workspaces</th>
            <th scope="col" className="p-3">{props.former ? "Access removed" : "Since"}</th>
            <th scope="col" className="p-3"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {props.people.map(p => (
            <tr key={p.userId} className="border-t border-[#eef2f7]">
              <th scope="row" className="p-3 text-left font-medium">{p.displayName}</th>
              <td className="p-3 text-sm">{p.live ? "Active" : p.membershipStatus === "ended" ? "Removed" : "Suspended"}</td>
              <td className="p-3 text-sm">{p.roles.length ? p.roles.join(", ") : "No roles"}</td>
              <td className="p-3 text-sm">{p.workspaces.length ? p.workspaces.join(", ") : "None"}</td>
              <td className="p-3 text-sm">{shortDate(props.former ? p.effectiveTo : p.effectiveFrom)}</td>
              <td className="p-3">
                <Button variant="outline" className="min-h-11" onClick={() => props.onOpen?.(p.userId)}>
                  Manage<span className="sr-only"> access for {p.displayName}</span>
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phones: the same rows as cards. One list, not a second data path. */}
      <ul className="space-y-2 md:hidden">
        {props.people.map(p => (
          <li key={p.userId} className={`${card} p-4`}>
            <div className="font-medium">{p.displayName}</div>
            <dl className="mt-1 text-sm">
              <div className="flex gap-2"><dt className="text-[#5b6b82]">Status</dt><dd>{p.live ? "Active" : p.membershipStatus === "ended" ? "Removed" : "Suspended"}</dd></div>
              <div className="flex gap-2"><dt className="text-[#5b6b82]">Roles</dt><dd>{p.roles.length ? p.roles.join(", ") : "No roles"}</dd></div>
              <div className="flex gap-2"><dt className="text-[#5b6b82]">Workspaces</dt><dd>{p.workspaces.length ? p.workspaces.join(", ") : "None"}</dd></div>
            </dl>
            <Button variant="outline" className="mt-3 min-h-11 w-full" onClick={() => props.onOpen?.(p.userId)}>
              Manage<span className="sr-only"> access for {p.displayName}</span>
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------------ */

function PersonDetail(props: {
  person: PersonRow;
  workspaceOptions: readonly { key: string; label: string }[];
  organizationName: string;
  roleCatalogue: readonly RoleOption[];
  onClose?: () => void;
  onSaveRoles?: (userId: number, roles: string[]) => void;
  onSetDefaultWorkspace?: (userId: number, workspace: string | null) => void;
  onRemoveAccess?: (userId: number) => void;
  busy?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([...props.person.roles]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const headingId = useId();
  const changed = rolesChanged(props.person.roles, selected);

  // The preview is the server's own computation for the roles currently ticked,
  // taken from the catalogue rather than guessed: each role carries the
  // workspaces it opens, so the union is what the resolver would open.
  const previewed = useMemo(() => {
    const keys = new Map<string, string>();
    for (const role of selected) {
      for (const w of props.roleCatalogue.find(r => r.role === role)?.workspaces ?? []) keys.set(w.key, w.label);
    }
    return Array.from(keys.entries()).map(([key, label]) => ({ key, label }));
  }, [selected, props.roleCatalogue]);

  return (
    <Card role="region" aria-labelledby={headingId} className="mt-4">
      <CardHeader>
        <CardTitle id={headingId}>{props.person.displayName}</CardTitle>
        <CardDescription>
          Access in {props.organizationName}. Membership {props.person.membershipStatus}
          {props.person.live ? "" : " — this person cannot work for this organization"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset>
          <legend className="text-sm font-medium">Roles in {props.organizationName}</legend>
          <p className={muted}>Roles granted here apply to this organization only.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {props.roleCatalogue.map(r => {
              const id = `role-${r.role}`;
              const checked = selected.includes(r.role);
              return (
                <label key={r.role} htmlFor={id} className="flex items-start gap-2 rounded-lg border border-[#e6ebf2] p-3 min-h-11">
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    aria-describedby={`${id}-desc`}
                    onChange={e => setSelected(prev => (e.target.checked ? [...prev, r.role] : prev.filter(x => x !== r.role)))}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium">{r.role}</span>
                    <span id={`${id}-desc`} className="block text-xs text-[#5b6b82]">{r.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <h3 className="text-sm font-medium">Resulting workspaces</h3>
          <p aria-live="polite" className={muted}>
            {previewed.length ? previewed.map(w => w.label).join(", ") : "None — this person would have no workspace."}
          </p>
        </div>

        <div>
          <label htmlFor="default-workspace" className="text-sm font-medium">Default workspace</label>
          <p className={muted}>Where they land. Only workspaces their roles open can be chosen.</p>
          <select
            id="default-workspace"
            defaultValue={props.person.defaultWorkspace ?? ""}
            onChange={e => props.onSetDefaultWorkspace?.(props.person.userId, e.target.value || null)}
            className="mt-1 min-h-11 w-full rounded-lg border border-[#cfd6e0] px-3 py-2 text-sm"
          >
            {defaultWorkspaceChoices(props.workspaceOptions).map(c => (
              <option key={c.key ?? "none"} value={c.key ?? ""}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button disabled={!changed || props.busy} onClick={() => props.onSaveRoles?.(props.person.userId, selected)} className="min-h-11">
            Save access
          </Button>
          <Button variant="outline" onClick={props.onClose} className="min-h-11">Close</Button>
        </div>

        <div className="rounded-xl border border-[#f3c3bd] bg-[#fdf3f2] p-3">
          <h3 className="text-sm font-medium text-[#7a271a]">Remove access to {props.organizationName}</h3>
          <p className="text-xs text-[#7a271a]">
            Ends this person&apos;s membership of {props.organizationName} and revokes the roles granted here. Their
            LeaseOS account and any access at another employer are untouched.
          </p>
          {confirmRemove ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="destructive"
                disabled={props.busy}
                onClick={() => props.onRemoveAccess?.(props.person.userId)}
                className="min-h-11"
              >
                Yes, remove {props.person.displayName}&apos;s access to {props.organizationName}
              </Button>
              <Button variant="outline" onClick={() => setConfirmRemove(false)} className="min-h-11">Keep access</Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setConfirmRemove(true)} className="mt-2 min-h-11">
              Remove access<span className="sr-only"> for {props.person.displayName} to {props.organizationName}</span>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function Invitations(props: {
  invitations: readonly InvitationRow[];
  roleCatalogue: readonly RoleOption[];
  onInvite?: (input: { email?: string; displayName?: string; roles: string[] }) => void;
  onCancel?: (invitationRef: string) => void;
  issuedLink?: { invitationRef: string; token: string } | null;
  busy?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);

  return (
    <div className="space-y-4">
      {props.issuedLink ? (
        <div role="status" className={`${card} border-[#bfe3c8] bg-[#f2fbf4] p-4`}>
          <h3 className="text-sm font-medium">Invitation created — copy this link now</h3>
          <p className="text-xs text-[#40624a]">
            It is shown once and is not stored anywhere. Send it to the person yourself; LeaseOS does not send email.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-white p-2 text-xs">
            /invitation?token={props.issuedLink.token}
          </code>
        </div>
      ) : null}

      <form
        className={`${card} p-4 space-y-3`}
        onSubmit={e => {
          e.preventDefault();
          props.onInvite?.({ email: email || undefined, displayName: displayName || undefined, roles });
        }}
      >
        <h3 className="text-sm font-medium">Invite a person</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="invite-name" className="text-sm">Name</label>
            <input
              id="invite-name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="mt-1 min-h-11 w-full rounded-lg border border-[#cfd6e0] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="invite-email" className="text-sm">Email</label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              aria-describedby="invite-email-hint"
              className="mt-1 min-h-11 w-full rounded-lg border border-[#cfd6e0] px-3 py-2 text-sm"
            />
            <p id="invite-email-hint" className="mt-1 text-xs text-[#5b6b82]">
              A label so you know who you meant. The invitation is claimed with the link and a LeaseOS sign-in, not
              with this address.
            </p>
          </div>
        </div>
        <fieldset>
          <legend className="text-sm">Roles</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {props.roleCatalogue.map(r => (
              <label key={r.role} htmlFor={`invite-role-${r.role}`} className="flex items-start gap-2 text-sm min-h-11">
                <input
                  id={`invite-role-${r.role}`}
                  type="checkbox"
                  checked={roles.includes(r.role)}
                  onChange={e => setRoles(prev => (e.target.checked ? [...prev, r.role] : prev.filter(x => x !== r.role)))}
                  className="mt-1"
                />
                <span>{r.role}<span className="block text-xs text-[#5b6b82]">{r.description}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={roles.length === 0 || props.busy} className="min-h-11">
          Send invitation
        </Button>
      </form>

      {props.invitations.length === 0 ? (
        <p className={`${card} p-4 ${muted}`}>No invitations yet.</p>
      ) : (
        <ul className="space-y-2">
          {props.invitations.map(i => {
            const tone = invitationTone(i.view);
            return (
              <li key={i.invitationRef} className={`${card} p-4`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{i.displayNameHint ?? i.emailHint ?? i.invitationRef}</span>
                  {/* The state is a word, not only a colour. */}
                  <span className="text-sm">{tone.label}</span>
                </div>
                <p className={muted}>
                  {i.roles.join(", ") || "no roles"} · invited {shortDate(i.invitedAt)} · expires {shortDate(i.expiresAt)}
                </p>
                {i.view === "pending" ? (
                  <Button variant="outline" className="mt-2 min-h-11" disabled={props.busy} onClick={() => props.onCancel?.(i.invitationRef)}>
                    Cancel invitation<span className="sr-only"> for {i.displayNameHint ?? i.emailHint ?? i.invitationRef}</span>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Resolution(props: { rows: readonly ResolutionRow[]; onResolve?: (id: number) => void; busy?: boolean }) {
  if (props.rows.length === 0) {
    return <p className={`${card} p-4 ${muted}`}>Nothing needs resolution.</p>;
  }
  return (
    <div className="space-y-2">
      <p className={`${card} p-3 ${muted}`}>
        These roles were granted before roles carried an organization. They authorize nothing until you re-issue them
        here. Resolve them one at a time, and only where you know the access is right.
      </p>
      <ul className="space-y-2">
        {props.rows.map(r => (
          <li key={r.legacyGrantId} className={`${card} p-4`}>
            <div className="font-medium">{r.displayName}</div>
            <p className={muted}>{r.role} · granted {shortDate(r.grantedAt)} · authorizes nothing</p>
            <Button className="mt-2 min-h-11" disabled={props.busy} onClick={() => props.onResolve?.(r.legacyGrantId)}>
              Re-issue {r.role} here<span className="sr-only"> for {r.displayName}</span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

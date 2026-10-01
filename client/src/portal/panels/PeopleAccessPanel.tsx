/**
 * B23.2 — People & Access, wired to the real procedures.
 *
 * The container: it fetches, it mutates, it refetches. Every decision belongs
 * to the server, so this file contains no rule — only the calls and the
 * invalidations that keep the screen honest after a write.
 *
 * Mounted in the `management` workspace alone. That is not the security
 * boundary: `roles.grant` is held by `management` and every procedure below
 * re-derives it, so a person who reached this panel another way would be
 * refused by the gate. It is mounted narrowly so nobody is shown a screen that
 * would refuse them.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { PeopleAccessView } from "@/people/PeopleAccessView";
import type { SectionKey } from "@/people/peopleModel";

export function PeopleAccessPanel() {
  const [section, setSection] = useState<SectionKey>("active");
  const [openUserId, setOpenUserId] = useState<number | null>(null);
  const [issuedLink, setIssuedLink] = useState<{ invitationRef: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const people = trpc.people.list.useQuery();
  const catalogue = trpc.people.roleCatalogue.useQuery();
  const invitations = trpc.people.invitations.list.useQuery();
  const resolution = trpc.people.accessResolution.list.useQuery();
  const detail = trpc.people.detail.useQuery({ userId: openUserId ?? 0 }, { enabled: openUserId != null });

  const utils = trpc.useUtils();
  const refresh = () => {
    void utils.people.list.invalidate();
    void utils.people.detail.invalidate();
    void utils.people.invitations.list.invalidate();
    void utils.people.accessResolution.list.invalidate();
  };
  // A server refusal is the message worth showing; it already says what to do.
  const onError = (e: { message: string }) => setError(e.message);
  const onDone = () => { setError(null); refresh(); };

  const setRoles = trpc.people.setRoles.useMutation({ onSuccess: onDone, onError });
  const setDefault = trpc.people.setDefaultWorkspace.useMutation({ onSuccess: onDone, onError });
  const remove = trpc.people.removeFromOrganization.useMutation({
    onSuccess: () => { setOpenUserId(null); onDone(); },
    onError,
  });
  const invite = trpc.people.invitations.create.useMutation({
    onSuccess: r => { setIssuedLink({ invitationRef: r.invitationRef, token: r.token }); onDone(); },
    onError,
  });
  const cancelInvite = trpc.people.invitations.cancel.useMutation({ onSuccess: onDone, onError });
  const resolveLegacy = trpc.records.roles.resolveLegacy.useMutation({ onSuccess: onDone, onError });

  const busy =
    setRoles.isPending || setDefault.isPending || remove.isPending ||
    invite.isPending || cancelInvite.isPending || resolveLegacy.isPending;

  return (
    <PeopleAccessView
      organizationName={people.data?.organization.name ?? "this organization"}
      people={people.data?.people ?? []}
      invitations={invitations.data?.invitations ?? []}
      needsResolution={resolution.data?.needsResolution ?? []}
      roleCatalogue={catalogue.data?.roles ?? []}
      selected={
        openUserId != null && detail.data
          ? { person: detail.data.person, workspaceOptions: detail.data.workspaceOptions }
          : null
      }
      section={section}
      onSection={setSection}
      onOpenPerson={setOpenUserId}
      onClosePerson={() => setOpenUserId(null)}
      onSaveRoles={(userId, roles) => setRoles.mutate({ userId, roles: roles as never, reason: "access updated" })}
      onSetDefaultWorkspace={(userId, workspace) => setDefault.mutate({ userId, workspace })}
      onRemoveAccess={userId => remove.mutate({ userId, reason: "access removed by an administrator" })}
      onInvite={input => invite.mutate({ ...input, roles: input.roles as never, defaultWorkspace: null })}
      onCancelInvitation={invitationRef => cancelInvite.mutate({ invitationRef, reason: "cancelled by an administrator" })}
      onResolve={legacyGrantId => resolveLegacy.mutate({ legacyGrantId, reason: "confirmed by an administrator" })}
      issuedLink={issuedLink}
      busy={busy}
      error={error}
    />
  );
}

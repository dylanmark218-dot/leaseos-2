/**
 * The Dispatch Detail screen — the container.
 *
 * It reads one job and the crew slots on it, and it can now change them.
 *
 *   `fieldRoute.jobs.list` returns the hundred most recently updated jobs in scope and takes no
 *   input, so a numeric jobId is matched client-side. Not finding it is `outside_window` — the list
 *   came back and this id was not in it — which is not the same as a failed read and not the same
 *   as a job that does not exist. This is unchanged: there is still no job-by-id read.
 *
 *   `dispatch.listRoles({ jobId })` replaces the `jobUnits.list` read PR #6 had to use. It is keyed
 *   by job, so the capped job-blind window is gone, and it returns the slots nobody is in, which a
 *   worklog table could not represent at all.
 *
 *   `units.list` and `operators.list` remain capped and unfiltered, so ids stay authoritative and
 *   names stay optional enrichment. A name that does not match is "not resolved", never "unknown".
 *
 * PERMISSION. The server is the only authority on whether this caller may assign, and nothing
 * exposes a permission set to the client — there is no `auth.me` permission list to read. So the
 * screen does not guess: it offers the controls, and if the server refuses the write as forbidden
 * it stops offering them and says why. Guessing "no" would hide a control a dispatcher is entitled
 * to; guessing "yes" silently would leave them clicking a button that cannot work.
 *
 * The readiness panel is the existing component, composed in unchanged. It resolves its own subject
 * from the same canonical slot model, so the two cannot disagree about who is on the job.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DispatchReadiness from "./DispatchReadiness";
import { invalidateAfterSlotMutation } from "./assignmentRefresh";
import {
  DispatchJobDetailView,
  type AssignSubmission,
  type HistoryRow,
  type JobState,
  type SlotMutation,
  type SlotRow,
  type SlotsState,
  type UnassignSubmission,
} from "./DispatchJobDetailView";

export default function DispatchJobDetail({ jobId }: { jobId: number }) {
  const validJob = Number.isInteger(jobId) && jobId > 0;
  const utils = trpc.useUtils();

  const [mutation, setMutation] = useState<SlotMutation>({ kind: "idle" });
  const [forbidden, setForbidden] = useState(false);

  const jobs = trpc.fieldRoute.jobs.list.useQuery(undefined, { enabled: validJob });
  const roles = trpc.dispatch.listRoles.useQuery({ jobId, includeHistory: true }, { enabled: validJob });
  const units = trpc.fieldRoute.identity.units.list.useQuery(undefined, { enabled: validJob });
  const operators = trpc.fieldRoute.identity.operators.list.useQuery(undefined, { enabled: validJob });

  const job: JobState =
    !validJob ? { kind: "failed", message: `"${String(jobId)}" is not a job.` }
    : jobs.isError ? { kind: "failed", message: jobs.error.message }
    : jobs.isPending ? { kind: "loading" }
    : (() => {
        const found = (jobs.data ?? []).find(j => j.id === jobId);
        if (!found) return { kind: "outside_window" as const };
        return {
          kind: "loaded" as const,
          job: {
            id: found.id, jobCode: found.jobCode, type: found.type, mode: found.mode,
            customer: found.customer, location: found.location, status: found.status,
            progress: found.progress, eta: found.eta ?? null,
            vehicleText: found.vehicle ?? null, driverText: found.driver ?? null,
          },
        };
      })();

  // A name list that failed or is still loading is not a name that does not exist. Both leave the
  // name null, and the view distinguishes the two through `namesResolved`.
  const namesResolved = !units.isError && !operators.isError && !units.isPending && !operators.isPending;
  const unitName = (id: number | null) =>
    id == null ? null : (units.data ?? []).find(u => u.id === id)?.unitNumber ?? null;
  const operatorName = (id: number | null) =>
    id == null ? null : (operators.data ?? []).find(o => o.id === id)?.name ?? null;

  const slots: SlotsState =
    !validJob ? { kind: "failed", message: `"${String(jobId)}" is not a job.` }
    : roles.isError ? { kind: "failed", message: roles.error.message }
    : roles.isPending ? { kind: "loading" }
    : (roles.data?.postings.length ?? 0) === 0 ? { kind: "no_posting" }
    : {
        kind: "loaded",
        rows: (roles.data?.roles ?? []).map((r): SlotRow => ({
          roleId: r.roleId, postingId: r.postingId,
          roleCode: r.roleCode, roleLabel: r.roleLabel, displayName: r.displayName,
          required: r.required, status: r.status,
          operatorId: r.operatorId, operatorName: operatorName(r.operatorId),
          unitId: r.unitId, unitName: unitName(r.unitId),
          trailerId: r.trailerId, trailerName: unitName(r.trailerId),
          requiredEquipmentClass: r.requiredEquipmentClass,
          requiredTrailerClass: r.requiredTrailerClass,
          lastEventId: r.lastEventId,
        })),
        staffing: roles.data!.staffing,
        planningState: roles.data!.planningState,
        history: (roles.data?.history ?? []).map((e): HistoryRow => ({
          id: e.id, roleId: e.roleId, eventType: e.eventType,
          fromOperatorId: e.fromOperatorId, fromUnitId: e.fromUnitId,
          toOperatorId: e.toOperatorId, toUnitId: e.toUnitId,
          reason: e.reason, actorUserId: e.actorUserId,
          occurredAt: new Date(e.occurredAt),
        })),
      };

  /*
   * Every write, however it ends, re-reads both the slots and readiness. The second is the one that
   * matters and the one easy to forget: a verdict computed for the previous crew looks exactly like
   * a current one. `invalidateAfterSlotMutation` states that once instead of twice.
   */
  const settle = () =>
    invalidateAfterSlotMutation({
      listRoles: utils.dispatch.listRoles,
      readiness: utils.dispatch.readiness,
    });

  const failWith = (roleId: number, error: { message: string; data?: { code?: string } | null }) => {
    const code = error.data?.code;
    if (code === "FORBIDDEN" || code === "UNAUTHORIZED") setForbidden(true);
    setMutation(
      code === "CONFLICT"
        ? { kind: "conflict", roleId, message: error.message }
        : { kind: "failed", roleId, message: error.message },
    );
  };

  const assign = trpc.dispatch.setRoleAssignment.useMutation({
    onMutate: v => { setMutation({ kind: "pending", roleId: v.roleId }); },
    onSuccess: () => setMutation({ kind: "idle" }),
    onError: (e, v) => failWith(v.roleId, e),
    onSettled: () => { settle(); },
  });

  const unassign = trpc.dispatch.clearRoleAssignment.useMutation({
    onMutate: v => { setMutation({ kind: "pending", roleId: v.roleId }); },
    onSuccess: () => setMutation({ kind: "idle" }),
    onError: (e, v) => failWith(v.roleId, e),
    onSettled: () => { settle(); },
  });

  const onAssign = (s: AssignSubmission) =>
    assign.mutate({
      roleId: s.roleId,
      operatorId: s.operatorId,
      unitId: s.unitId,
      trailerId: s.trailerId,
      expectedLastEventId: s.expectedLastEventId,
      ...(s.reason ? { reason: s.reason } : {}),
    });

  const onUnassign = (s: UnassignSubmission) =>
    unassign.mutate({
      roleId: s.roleId,
      expectedLastEventId: s.expectedLastEventId,
      reason: s.reason,
    });

  const refresh = () => {
    void jobs.refetch();
    void roles.refetch();
    void units.refetch();
    void operators.refetch();
  };

  return (
    <DispatchJobDetailView
      jobId={jobId}
      job={job}
      slots={slots}
      namesResolved={namesResolved}
      operatorChoices={(operators.data ?? []).map(o => ({ id: o.id, label: o.name }))}
      unitChoices={(units.data ?? []).map(u => ({ id: u.id, label: u.unitNumber }))}
      mutation={mutation}
      canAssign={!forbidden}
      readiness={<DispatchReadiness jobId={jobId} as="panel" />}
      onAssign={onAssign}
      onUnassign={onUnassign}
      onRefresh={refresh}
      refreshing={jobs.isFetching || roles.isFetching || units.isFetching || operators.isFetching}
    />
  );
}

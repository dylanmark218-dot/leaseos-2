/**
 * The Readiness Panel — the container.
 *
 * It resolves which unit and driver the job is actually assigned to, asks `dispatch.readiness`
 * about exactly that pair, and hands the answer to the view unchanged. Two rules it keeps:
 *
 *   a failed query is a failure on screen, never a stale or cached answer — the query is not
 *   allowed to keep a previous result to fall back on, and an error outranks any data held;
 *
 *   the capability picture is passed through exactly as the server computed it — `null` when the
 *   response carries none at all, which the view says outright rather than showing an empty grid
 *   that reads as clear. Nothing here recombines it, and the overall verdict stays `verdict`.
 */
import { trpc } from "@/lib/trpc";
import { DispatchReadinessView, type ReadinessPanelState, type SchedulingPanelState } from "./DispatchReadinessView";

export default function DispatchReadiness({ jobId }: { jobId: number }) {
  const validJob = Number.isInteger(jobId) && jobId > 0;

  /*
   * `dispatch.readiness` takes an operator and a unit, not a job, so the assignment has to be
   * read first. `jobUnits.list` is behind `dispatch.read` — the same permission the readiness
   * query itself uses — so this adds no reach a dispatcher did not already have.
   */
  const assignments = trpc.fieldRoute.identity.jobUnits.list.useQuery(undefined, { enabled: validJob });
  const assignment = (assignments.data ?? [])
    .filter(a => a.jobId === jobId && a.operatorId != null)[0] ?? null;

  const subject = assignment && assignment.operatorId != null
    ? { operatorId: assignment.operatorId, unitId: assignment.unitId ?? null, trailerId: null }
    : null;

  const readiness = trpc.dispatch.readiness.useQuery(
    { operatorId: subject?.operatorId ?? 1, unitId: subject?.unitId ?? null, trailerId: null, jobId },
    {
      enabled: subject !== null,
      // A readiness is a point-in-time judgement. It is never served from cache, and a failure
      // must not be able to reveal the answer from before it.
      retry: false, staleTime: 0, gcTime: 0,
    }
  );

  /*
   * B23.3 — the scheduling answer for the same pair, beside the gate's own. `work.scheduleAssess`
   * is behind `work.scheduling`; a dispatcher holds it, and a failed or refused read is shown as
   * that rather than hidden. The window is the job's own bookings when it has any, and the server
   * says which basis it used.
   */
  const scheduling = trpc.work.scheduleAssess.useQuery(
    { operatorIds: [subject?.operatorId ?? 1], unitId: subject?.unitId ?? undefined, jobId },
    { enabled: subject !== null, retry: false, staleTime: 0, gcTime: 0 }
  );

  const refresh = () => {
    void assignments.refetch();
    if (subject) { void readiness.refetch(); void scheduling.refetch(); }
  };

  const schedulingState: SchedulingPanelState | null =
    !subject ? null
    : scheduling.isError ? { kind: "failed", message: scheduling.error.message }
    : scheduling.isPending ? { kind: "loading" }
    : { kind: "loaded", assessment: scheduling.data?.ranked[0] ? { ...scheduling.data.ranked[0], basis: scheduling.data.basis } : null };

  const state: ReadinessPanelState =
    !validJob ? { kind: "failed", message: `"${String(jobId)}" is not a job.` }
    : assignments.isError ? { kind: "failed", message: assignments.error.message }
    : assignments.isPending ? { kind: "loading" }
    : readiness.isError ? { kind: "failed", message: readiness.error.message }
    : subject && readiness.isPending ? { kind: "loading" }
    : { kind: "loaded", result: readiness.data ?? null };

  return (
    <DispatchReadinessView
      jobId={jobId}
      subject={validJob ? subject : null}
      state={state}
      capabilities={readiness.data?.capabilities ?? null}
      capabilityVerdict={readiness.data?.capabilityVerdict ?? null}
      onRefresh={refresh}
      refreshing={assignments.isFetching || readiness.isFetching || scheduling.isFetching}
      scheduling={schedulingState}
    />
  );
}

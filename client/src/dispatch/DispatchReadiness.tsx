/**
 * The Readiness Panel — the container.
 *
 * It resolves which unit and driver the job is actually assigned to, asks `dispatch.readiness`
 * about exactly that pair, and hands the answer to the view unchanged. Two rules it keeps:
 *
 *   a failed query is a failure on screen, never a stale or cached answer — the query is not
 *   allowed to keep a previous result to fall back on, and an error outranks any data held;
 *
 *   the capability picture is passed as `null`, because `dispatch.readiness` does not return one.
 *   The view says so. Nothing here fabricates the missing half of the P8.1 contract.
 */
import { trpc } from "@/lib/trpc";
import { DispatchReadinessView, type ReadinessPanelState } from "./DispatchReadinessView";

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

  const refresh = () => {
    void assignments.refetch();
    if (subject) void readiness.refetch();
  };

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
      capabilities={null}
      onRefresh={refresh}
      refreshing={assignments.isFetching || readiness.isFetching}
    />
  );
}

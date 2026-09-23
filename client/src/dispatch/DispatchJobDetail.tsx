/**
 * The Dispatch Detail screen — the container.
 *
 * It reads one job through procedures that have no single-job read, and it is explicit about what
 * that costs rather than hiding it behind a spinner:
 *
 *   `fieldRoute.jobs.list` returns the hundred most recently updated jobs in scope and takes no
 *   input, so a numeric jobId is matched client-side. Not finding it is `outside_window` — the
 *   list came back and this id was not in it — which is not the same as a failed read and not the
 *   same as a job that does not exist.
 *
 *   `jobUnits.list`, `units.list` and `operators.list` are the same shape: no filter, capped at a
 *   hundred. Ids come from the assignment row and are authoritative; names are matched out of
 *   those lists and are optional. A name that does not match is not resolved, and the view says so.
 *
 * The readiness panel is the existing component, composed in unchanged. `jobUnits.list` takes no
 * input, so this page and the panel share one react-query key and one request, and re-reading here
 * refreshes both.
 */
import { trpc } from "@/lib/trpc";
import DispatchReadiness from "./DispatchReadiness";
import {
  DispatchJobDetailView,
  type AssignmentRow,
  type AssignmentState,
  type JobState,
} from "./DispatchJobDetailView";

export default function DispatchJobDetail({ jobId }: { jobId: number }) {
  const validJob = Number.isInteger(jobId) && jobId > 0;

  const jobs = trpc.fieldRoute.jobs.list.useQuery(undefined, { enabled: validJob });
  const assignments = trpc.fieldRoute.identity.jobUnits.list.useQuery(undefined, { enabled: validJob });
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
  const unitName = (id: number) => (units.data ?? []).find(u => u.id === id)?.unitNumber ?? null;
  const operatorName = (id: number) => (operators.data ?? []).find(o => o.id === id)?.name ?? null;

  const assignmentState: AssignmentState =
    !validJob ? { kind: "failed", message: `"${String(jobId)}" is not a job.` }
    : assignments.isError ? { kind: "failed", message: assignments.error.message }
    : assignments.isPending ? { kind: "loading" }
    : {
        kind: "loaded",
        rows: (assignments.data ?? [])
          .filter(a => a.jobId === jobId)
          .map((a): AssignmentRow => ({
            jobUnitId: a.id,
            unitId: a.unitId,
            unitName: unitName(a.unitId),
            operatorId: a.operatorId ?? null,
            operatorName: a.operatorId != null ? operatorName(a.operatorId) : null,
            role: a.role,
            joinedAt: new Date(a.joinedAt),
            departedAt: a.departedAt ? new Date(a.departedAt) : null,
          })),
      };

  const refresh = () => {
    void jobs.refetch();
    void assignments.refetch();
    void units.refetch();
    void operators.refetch();
  };

  return (
    <DispatchJobDetailView
      jobId={jobId}
      job={job}
      assignments={assignmentState}
      namesResolved={namesResolved}
      readiness={<DispatchReadiness jobId={jobId} as="panel" />}
      onRefresh={refresh}
      refreshing={jobs.isFetching || assignments.isFetching || units.isFetching || operators.isFetching}
    />
  );
}

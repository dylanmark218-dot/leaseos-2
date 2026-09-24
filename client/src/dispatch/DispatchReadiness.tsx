/**
 * The Readiness Panel — the container.
 *
 * It resolves which crew the job is actually assigned to, asks `dispatch.readiness` about exactly
 * that pairing, and hands the answer to the view unchanged. Three rules it keeps:
 *
 *   the subject comes from the canonical slot model and from nowhere else. PR #5 had to read
 *   `jobUnits.list` because `dispatchRoles` had no production door and no reader; now it has both,
 *   and a readiness verdict computed from the legacy worklog table while assignments are written to
 *   slots would be a verdict about whoever last filed hours, not about the crew on the job;
 *
 *   a failed query is a failure on screen, never a stale or cached answer — the query is not
 *   allowed to keep a previous result to fall back on, and an error outranks any data held;
 *
 *   the capability picture is passed through exactly as the server computed it — `null` when the
 *   response carries none at all, which the view says outright rather than showing an empty grid
 *   that reads as clear. Nothing here recombines it, and the overall verdict stays `verdict`.
 */
import { trpc } from "@/lib/trpc";
import { DispatchReadinessView, type ReadinessPanelState } from "./DispatchReadinessView";

export default function DispatchReadiness({ jobId, as }: { jobId: number; as?: "page" | "panel" }) {
  const validJob = Number.isInteger(jobId) && jobId > 0;

  /*
   * `dispatch.readiness` takes an operator and a unit, not a job, so the binding has to be read
   * first. `dispatch.listRoles` is behind `dispatch.read` — the same permission the readiness query
   * itself uses — so this adds no reach a dispatcher did not already have, and unlike the read it
   * replaces it is keyed by job rather than returning a capped, job-blind window.
   */
  const roles = trpc.dispatch.listRoles.useQuery({ jobId }, { enabled: validJob });

  /*
   * The first filled slot is the subject. A posting with several filled slots has several crews and
   * therefore several readiness questions; this panel answers one, and shows which.
   */
  const bound = (roles.data?.roles ?? [])
    .filter(r => r.status === "assigned" && r.operatorId != null)[0] ?? null;

  const subject = bound && bound.operatorId != null
    ? { operatorId: bound.operatorId, unitId: bound.unitId ?? null, trailerId: bound.trailerId ?? null }
    : null;

  const readiness = trpc.dispatch.readiness.useQuery(
    {
      operatorId: subject?.operatorId ?? 1,
      unitId: subject?.unitId ?? null,
      trailerId: subject?.trailerId ?? null,
      jobId,
    },
    {
      enabled: subject !== null,
      // A readiness is a point-in-time judgement. It is never served from cache, and a failure
      // must not be able to reveal the answer from before it.
      retry: false, staleTime: 0, gcTime: 0,
    }
  );

  const refresh = () => {
    void roles.refetch();
    if (subject) void readiness.refetch();
  };

  const state: ReadinessPanelState =
    !validJob ? { kind: "failed", message: `"${String(jobId)}" is not a job.` }
    : roles.isError ? { kind: "failed", message: roles.error.message }
    : roles.isPending ? { kind: "loading" }
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
      as={as}
      onRefresh={refresh}
      refreshing={roles.isFetching || readiness.isFetching}
    />
  );
}

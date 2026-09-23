/**
 * The Dispatch Detail screen — the view.
 *
 * Props in, DOM out. One job: its header, what is assigned to it, and the readiness panel for that
 * pairing, composed in rather than reimplemented.
 *
 * Three things this screen is careful about, because the procedures behind it were not designed
 * for a detail view and the gaps are all in the direction of looking more certain than it is:
 *
 *   there is no job-by-id read, so a job is found in a hundred-row list — and absent means
 *   "not among the ones you can read", never "does not exist";
 *
 *   `jobUnits` carries ids and no names, so ids are the authoritative text and a name is optional
 *   enrichment — a name that did not resolve is "not resolved", never "unknown", because
 *   out-of-scope, past-the-cap and deleted all arrive the same way;
 *
 *   `jobUnits.list` is job-blind and capped, so an empty result is not proof of an unassigned job,
 *   and the screen says which window it looked at.
 *
 * It changes nothing. The assignment controls are absent on purpose and the screen says why.
 */
import type { ReactNode } from "react";

export type JobHeader = {
  id: number;
  jobCode: string;
  type: string;
  mode: string;
  customer: string;
  location: string;
  status: string;
  progress: number;
  eta: string | null;
  /** `jobs.vehicle` / `jobs.driver`: free text somebody typed, not a reference to a record. */
  vehicleText: string | null;
  driverText: string | null;
};

export type AssignmentRow = {
  jobUnitId: number;
  unitId: number;
  /** null = the id did not resolve to a name in the lists this caller can read. */
  unitName: string | null;
  operatorId: number | null;
  operatorName: string | null;
  /** `jobUnits.role`: unvalidated captured text. Nothing on the server reads it. */
  role: string;
  joinedAt: Date;
  departedAt: Date | null;
};

export type JobState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  /** The list came back and this id was not in it. More than one cause; the screen names none. */
  | { kind: "outside_window" }
  | { kind: "loaded"; job: JobHeader };

export type AssignmentState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; rows: AssignmentRow[] };

export type DispatchJobDetailViewProps = {
  jobId: number;
  job: JobState;
  assignments: AssignmentState;
  /** Whether the name lists loaded at all, so an unresolved name can be explained honestly. */
  namesResolved: boolean;
  /** The real readiness panel, composed in. This view never computes readiness. */
  readiness: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
};

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
    <dd className="text-sm text-slate-900">{value}</dd>
  </div>
);

function Alert({ message }: { message: string }) {
  return (
    <div role="alert" className="space-y-1 rounded border border-red-700 bg-red-50 p-4 text-sm text-red-900">
      <p className="font-medium">This could not be read.</p>
      <p>{message}</p>
      <p>Nothing is shown in its place. A read that failed is not a record that is empty.</p>
    </div>
  );
}

function Header({ jobId, state }: { jobId: number; state: JobState }) {
  if (state.kind === "loading") return <p data-testid="job-loading" className="text-sm text-slate-600">Reading job {jobId}…</p>;
  if (state.kind === "failed") return <Alert message={state.message} />;
  if (state.kind === "outside_window") {
    return (
      <p data-testid="job-unavailable" className="rounded border border-slate-400 bg-slate-50 p-4 text-sm">
        Job {jobId} is not among the jobs you can read. That list holds the most recently updated
        jobs in your organization, so this may be an older job or one belonging to another
        organization — this screen cannot tell which, and does not guess.
      </p>
    );
  }

  const j = state.job;
  return (
    <div data-testid="job-header" className="space-y-3 rounded border border-slate-300 bg-white p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">{j.jobCode}</h1>
        <span className="rounded border border-slate-400 px-2 py-0.5 text-sm">{j.status}</span>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Customer" value={j.customer} />
        <Field label="Location" value={j.location} />
        <Field label="Type" value={j.type} />
        <Field label="Mode" value={j.mode} />
        <Field label="Progress" value={`${j.progress}%`} />
        {j.eta ? <Field label="ETA, as recorded" value={j.eta} /> : null}
      </dl>
      {j.vehicleText || j.driverText ? (
        <p data-testid="job-captured-text" className="text-sm text-slate-700">
          Typed on the job, as free text rather than a record
          {j.vehicleText ? ` — vehicle: ${j.vehicleText}` : ""}
          {j.driverText ? ` — driver: ${j.driverText}` : ""}. These are notes, not the assignment
          below, and nothing links them to a unit or an operator.
        </p>
      ) : null}
    </div>
  );
}

function Assignment({ state, namesResolved }: { state: AssignmentState; namesResolved: boolean }) {
  if (state.kind === "loading") return <p data-testid="assignment-loading" className="text-sm text-slate-600">Reading assignments…</p>;
  if (state.kind === "failed") return <Alert message={state.message} />;

  const unresolved = namesResolved
    ? "name not resolved"
    : "name not resolved — the name lists could not be read";

  return (
    <>
      {state.rows.length === 0 ? (
        <p data-testid="assignment-none" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">
          No assignment was found for this job.
        </p>
      ) : (
        <ul className="space-y-2">
          {state.rows.map(r => (
            <li key={r.jobUnitId} data-testid={`assignment-${r.jobUnitId}`}
              className="space-y-1 rounded border border-slate-300 bg-white p-3 text-sm">
              <p>
                <span className="font-medium">Unit #{r.unitId}</span>
                {r.unitName ? <span className="text-slate-700"> ({r.unitName})</span>
                  : <span className="text-slate-600"> — {unresolved}</span>}
              </p>
              <p>
                {r.operatorId == null
                  ? <span className="font-medium">No operator assigned</span>
                  : (
                    <>
                      <span className="font-medium">Operator #{r.operatorId}</span>
                      {r.operatorName ? <span className="text-slate-700"> ({r.operatorName})</span>
                        : <span className="text-slate-600"> — {unresolved}</span>}
                    </>
                  )}
              </p>
              <p className="text-xs text-slate-600">
                Role, as captured on the assignment: “{r.role}”. Free text; nothing on the server reads it.
              </p>
              <p className="text-xs text-slate-600">
                Joined {r.joinedAt.toISOString().slice(0, 16).replace("T", " ")}
                {r.departedAt ? ` · departed ${r.departedAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p data-testid="assignment-window" className="text-xs text-slate-600">
        Assignments are read from the most recent 100 in your organization, which is the widest
        window this endpoint offers. A job outside that window shows nothing here whether or not it
        is assigned, so an empty list is not proof that nobody is on this job.
      </p>

      <p data-testid="trailer-unsupported" className="text-xs text-slate-600">
        Trailer and equipment assignment is not represented in this data at all — an assignment
        records a unit and an operator and has no trailer of its own. Nothing is being shown as
        unset, because there is no field to be unset.
      </p>

      <p data-testid="assignment-readonly-note" className="rounded border border-amber-600 bg-amber-50 p-3 text-sm text-amber-900">
        This screen is read-only: assignment cannot be changed from here. The one mutation that
        writes an assignment also carries award semantics — it can mark an eligibility check as
        used for award — so a change control here would risk awarding a dispatch while appearing to
        do nothing more than pick a driver.
      </p>
    </>
  );
}

export function DispatchJobDetailView(props: DispatchJobDetailViewProps) {
  const { jobId, job, assignments, namesResolved, readiness, onRefresh, refreshing } = props;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-slate-600">Dispatch detail · job {jobId}</p>
        <button type="button" data-testid="refresh" onClick={onRefresh} disabled={refreshing}
          className="rounded border px-3 py-1 text-sm">
          {refreshing ? "Re-reading…" : "Re-read"}
        </button>
      </div>

      <Header jobId={jobId} state={job} />

      <section aria-labelledby="assignment-heading" className="space-y-2">
        <h2 id="assignment-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Assigned to this job
        </h2>
        <Assignment state={assignments} namesResolved={namesResolved} />
      </section>

      <section aria-labelledby="readiness-section-heading" className="space-y-2">
        <h2 id="readiness-section-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Dispatch readiness
        </h2>
        {readiness}
      </section>
    </div>
  );
}

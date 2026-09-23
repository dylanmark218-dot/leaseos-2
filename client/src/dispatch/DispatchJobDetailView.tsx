/**
 * The Dispatch Detail screen — the view.
 *
 * Props in, DOM out. One job: its header, the slots the posting has, and the readiness panel for
 * the crew on it, composed in rather than reimplemented.
 *
 * PR #6 built this read-only and said why in a banner: the only reachable assignment mutation was
 * `jobUnits.create`, which also sets `usedForAward`, so a "Change driver" control here could have
 * awarded a dispatch while appearing to pick a driver. The canonical assignment subsystem removed
 * that reason, so the banner is gone and the controls are real.
 *
 * Two of PR #6's other disclosures went with it, because repeating them would now be the
 * fabrication: `dispatch.listRoles` is keyed by job rather than job-blind, so there is no
 * hundred-row window to warn about, and a slot carries a trailer, so trailers are no longer
 * unrepresentable. What did not change is that the server cannot prove an id is a trailer rather
 * than a truck — `units.vehicleType` is free text nothing reads — so that limitation stays stated.
 *
 * The rule this screen keeps hardest is the one design §16 sets out: **Assigned**, **Ready** and
 * **Awarded** are three different answers from three different subsystems. Filling a slot is this
 * screen's business; whether the crew may legally be dispatched is the readiness panel's, and
 * whether the posting was won is the award's. `slotPresentation.ts` holds the vocabulary so that
 * separation is asserted rather than merely intended.
 */
import { useState, type ReactNode } from "react";
import { presentRequirement, presentSlot } from "./slotPresentation";

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

/** One `dispatchRoles` row, as `dispatch.listRoles` returns it. */
export type SlotRow = {
  roleId: number;
  postingId: number;
  roleCode: string;
  roleLabel: string;
  /** The catalog's display name, or null when the code resolves to no type this caller can see. */
  displayName: string | null;
  required: boolean;
  status: string;
  operatorId: number | null;
  operatorName: string | null;
  unitId: number | null;
  unitName: string | null;
  trailerId: number | null;
  trailerName: string | null;
  requiredEquipmentClass: string | null;
  requiredTrailerClass: string | null;
  /** The head of this slot's own history — the concurrency token. Null means it has none. */
  lastEventId: number | null;
};

/** `assessStaffing`'s result, passed through exactly. Nothing here recomputes it. */
export type StaffingPicture = {
  state: string;
  filled: number;
  requiredTotal: number;
  unfilledRoles: string[];
  message: string;
};

export type HistoryRow = {
  id: number;
  roleId: number;
  eventType: string;
  fromOperatorId: number | null;
  fromUnitId: number | null;
  toOperatorId: number | null;
  toUnitId: number | null;
  reason: string | null;
  actorUserId: number;
  occurredAt: Date;
};

export type JobState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  /** The list came back and this id was not in it. More than one cause; the screen names none. */
  | { kind: "outside_window" }
  | { kind: "loaded"; job: JobHeader };

export type SlotsState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  /** The job is readable and has no dispatch posting at all — not a posting with nobody on it. */
  | { kind: "no_posting" }
  | {
      kind: "loaded";
      rows: SlotRow[];
      staffing: StaffingPicture;
      planningState: string | null;
      history: HistoryRow[];
    };

/** One write at a time, attributed to the slot it was aimed at. */
export type SlotMutation =
  | { kind: "idle" }
  | { kind: "pending"; roleId: number }
  | { kind: "conflict"; roleId: number; message: string }
  | { kind: "failed"; roleId: number; message: string };

export type PickOption = { id: number; label: string };

export type AssignSubmission = {
  roleId: number;
  operatorId: number | null;
  unitId: number | null;
  trailerId: number | null;
  expectedLastEventId: number | null;
  reason: string | null;
};

export type UnassignSubmission = {
  roleId: number;
  expectedLastEventId: number | null;
  reason: string;
};

export type DispatchJobDetailViewProps = {
  jobId: number;
  job: JobState;
  slots: SlotsState;
  /** Whether the name lists loaded at all, so an unresolved name can be explained honestly. */
  namesResolved: boolean;
  operatorChoices: PickOption[];
  unitChoices: PickOption[];
  mutation: SlotMutation;
  /** `dispatch.assign`. Without it the screen reads and says so, rather than offering dead buttons. */
  canAssign: boolean;
  /** The real readiness panel, composed in. This view never computes readiness. */
  readiness: ReactNode;
  onAssign: (submission: AssignSubmission) => void;
  onUnassign: (submission: UnassignSubmission) => void;
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
          {j.driverText ? ` — driver: ${j.driverText}` : ""}. These are notes, not the slots below,
          and nothing links them to a unit or an operator.
        </p>
      ) : null}
    </div>
  );
}

/** The precise staffing answer, and beside it the coarse persisted one, reported as itself. */
function Staffing({ staffing, planningState }: { staffing: StaffingPicture; planningState: string | null }) {
  return (
    <div className="space-y-2">
      <p data-testid="staffing" className="rounded border border-slate-300 bg-white p-3 text-sm">
        <span className="font-medium">{staffing.state.replace(/_/g, " ")}</span>
        {" — "}
        {staffing.message}
        {staffing.unfilledRoles.length > 0 ? (
          <span className="block text-xs text-slate-600">
            Still to fill: {staffing.unfilledRoles.join(", ")}.
          </span>
        ) : null}
      </p>
      {planningState ? (
        <p data-testid="planning-state" className="text-xs text-slate-600">
          The posting's stored lifecycle field reads “{planningState}”. It is shown as itself and not
          as the staffing answer above: that field carries the posting's commercial life as well as
          its crewing, and it cannot express “none of the required roles are filled” — its only legal
          step back from staffed is partially staffed, which would be an approximation of the line
          above rather than a second opinion on it.
        </p>
      ) : null}
    </div>
  );
}

function Slot(props: {
  row: SlotRow;
  namesResolved: boolean;
  operatorChoices: PickOption[];
  unitChoices: PickOption[];
  canAssign: boolean;
  mutation: SlotMutation;
  onAssign: (s: AssignSubmission) => void;
  onUnassign: (s: UnassignSubmission) => void;
}) {
  const { row, namesResolved, operatorChoices, unitChoices, canAssign, mutation } = props;
  const [editing, setEditing] = useState<"assign" | "unassign" | null>(null);
  const [operatorId, setOperatorId] = useState<string>(row.operatorId != null ? String(row.operatorId) : "");
  const [unitId, setUnitId] = useState<string>(row.unitId != null ? String(row.unitId) : "");
  const [reason, setReason] = useState("");
  const [complaint, setComplaint] = useState<string | null>(null);

  const presented = presentSlot(row.status);
  const requirement = presentRequirement(row.required);
  const unresolved = namesResolved
    ? "name not resolved"
    : "name not resolved — the name lists could not be read";

  const mine = mutation.kind !== "idle" && mutation.roleId === row.roleId;

  const submitAssign = () => {
    const op = operatorId === "" ? null : Number(operatorId);
    const un = unitId === "" ? null : Number(unitId);
    if (op === null && un === null) {
      setComplaint("Choose an operator, a unit, or both before saving.");
      return;
    }
    /*
     * Taking a crew off work they were expecting is an account somebody is owed, so the server
     * refuses `assignment_reassigned` without a reason and accepts a first binding without one.
     * The screen has to know that difference: without it, every crew change is a round trip that
     * comes back rejected, and the dispatcher is told by an error rather than by the form.
     */
    if (presented.fill === "filled" && reason.trim() === "") {
      setComplaint(
        "A reason is required to change the crew on a filled slot — somebody is being taken off " +
        "work they were expecting.",
      );
      return;
    }
    setComplaint(null);
    props.onAssign({
      roleId: row.roleId, operatorId: op, unitId: un, trailerId: row.trailerId,
      expectedLastEventId: row.lastEventId,
      reason: reason.trim() === "" ? null : reason.trim(),
    });
  };

  const submitUnassign = () => {
    // The server refuses a whitespace-only reason, and it took a mutation that survived its own
    // test to find that the schema's length check had been doing all the work. Refusing it here
    // saves a round trip and keeps the screen from implying a blank reason was acceptable.
    if (reason.trim() === "") {
      setComplaint("A reason is required — a crew stood down with no reason recorded is a gap in the record.");
      return;
    }
    setComplaint(null);
    props.onUnassign({ roleId: row.roleId, expectedLastEventId: row.lastEventId, reason: reason.trim() });
  };

  return (
    <li data-testid={`slot-${row.roleId}`} className="space-y-2 rounded border border-slate-300 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {row.displayName ?? row.roleLabel}{" "}
          <span className="text-xs font-normal text-slate-600">({row.roleCode})</span>
        </p>
        <span className="rounded border border-slate-400 px-2 py-0.5 text-xs">{presented.label}</span>
      </div>
      <p className="text-xs text-slate-600">{presented.meaning}</p>
      <p className="text-xs text-slate-600">
        <span className="font-medium">{requirement.label}.</span> {requirement.meaning}
      </p>

      {row.operatorId == null ? (
        <p>No operator on this slot.</p>
      ) : (
        <p>
          <span className="font-medium">Operator #{row.operatorId}</span>
          {row.operatorName ? <span className="text-slate-700"> ({row.operatorName})</span>
            : <span className="text-slate-600"> — {unresolved}</span>}
        </p>
      )}
      {row.unitId == null ? (
        <p>No unit on this slot.</p>
      ) : (
        <p>
          <span className="font-medium">Unit #{row.unitId}</span>
          {row.unitName ? <span className="text-slate-700"> ({row.unitName})</span>
            : <span className="text-slate-600"> — {unresolved}</span>}
        </p>
      )}
      {row.trailerId != null ? (
        <p>
          <span className="font-medium">Trailer #{row.trailerId}</span>
          {row.trailerName ? <span className="text-slate-700"> ({row.trailerName})</span>
            : <span className="text-slate-600"> — {unresolved}</span>}
        </p>
      ) : null}

      {row.requiredEquipmentClass || row.requiredTrailerClass ? (
        <p className="text-xs text-slate-600">
          Recorded on this slot when it was created
          {row.requiredEquipmentClass ? ` — equipment class: ${row.requiredEquipmentClass}` : ""}
          {row.requiredTrailerClass ? ` — trailer class: ${row.requiredTrailerClass}` : ""}. Nothing
          on the server compares an asset against these; they are what the slot asked for.
        </p>
      ) : null}

      {mine && mutation.kind === "pending" ? (
        <p data-testid={`slot-pending-${row.roleId}`} className="text-xs text-slate-600">Saving…</p>
      ) : null}

      {mine && mutation.kind === "conflict" ? (
        <p role="alert" data-testid={`slot-conflict-${row.roleId}`}
          className="rounded border border-amber-600 bg-amber-50 p-2 text-xs text-amber-900">
          {mutation.message} Nothing was changed. Re-read the screen before trying again — the copy
          of this slot you are looking at is the part that is out of date.
        </p>
      ) : null}

      {mine && mutation.kind === "failed" ? (
        <p role="alert" data-testid={`slot-error-${row.roleId}`}
          className="rounded border border-red-700 bg-red-50 p-2 text-xs text-red-900">
          {mutation.message}
        </p>
      ) : null}

      {!canAssign ? null : editing === null ? (
        <div className="flex gap-2 pt-1">
          {presented.fill === "filled" ? (
            <>
              <button type="button" onClick={() => setEditing("assign")}
                className="rounded border px-3 py-1 text-xs">Change crew</button>
              <button type="button" onClick={() => { setReason(""); setComplaint(null); setEditing("unassign"); }}
                className="rounded border px-3 py-1 text-xs">Unassign</button>
            </>
          ) : presented.fill === "unfilled" ? (
            <button type="button" onClick={() => setEditing("assign")}
              className="rounded border px-3 py-1 text-xs">Assign crew</button>
          ) : null}
        </div>
      ) : editing === "assign" ? (
        <div className="space-y-2 rounded border border-slate-300 bg-slate-50 p-2">
          <label className="block text-xs">
            Operator
            <select data-testid={`assign-operator-${row.roleId}`} value={operatorId}
              onChange={e => setOperatorId(e.target.value)} className="mt-1 block w-full rounded border p-1 text-xs">
              <option value="">— none —</option>
              {operatorChoices.map(o => <option key={o.id} value={String(o.id)}>{o.label} (#{o.id})</option>)}
            </select>
          </label>
          <label className="block text-xs">
            Unit
            <select data-testid={`assign-unit-${row.roleId}`} value={unitId}
              onChange={e => setUnitId(e.target.value)} className="mt-1 block w-full rounded border p-1 text-xs">
              <option value="">— none —</option>
              {unitChoices.map(u => <option key={u.id} value={String(u.id)}>{u.label} (#{u.id})</option>)}
            </select>
          </label>
          <label className="block text-xs">
            {presented.fill === "filled"
              ? "Reason — required, because somebody is being taken off this slot"
              : "Reason (not required to fill an empty slot; recorded if given)"}
            <input data-testid={`assign-reason-${row.roleId}`} value={reason}
              onChange={e => setReason(e.target.value)} className="mt-1 block w-full rounded border p-1 text-xs" />
          </label>
          {complaint ? (
            <p data-testid={`assign-required-${row.roleId}`} className="text-xs text-red-800">{complaint}</p>
          ) : null}
          <div className="flex gap-2">
            <button type="button" data-testid={`assign-submit-${row.roleId}`} onClick={submitAssign}
              className="rounded border px-3 py-1 text-xs">Save</button>
            <button type="button" onClick={() => { setComplaint(null); setEditing(null); }}
              className="rounded border px-3 py-1 text-xs">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded border border-slate-300 bg-slate-50 p-2">
          <label className="block text-xs">
            Reason
            <input data-testid={`unassign-reason-${row.roleId}`} value={reason}
              onChange={e => setReason(e.target.value)} className="mt-1 block w-full rounded border p-1 text-xs" />
          </label>
          {complaint ? (
            <p data-testid={`unassign-reason-required-${row.roleId}`} className="text-xs text-red-800">{complaint}</p>
          ) : null}
          <div className="flex gap-2">
            <button type="button" data-testid={`unassign-submit-${row.roleId}`} onClick={submitUnassign}
              className="rounded border px-3 py-1 text-xs">Save</button>
            <button type="button" onClick={() => { setComplaint(null); setEditing(null); }}
              className="rounded border px-3 py-1 text-xs">Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

function History({ rows }: { rows: HistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <p data-testid="history-none" className="rounded border border-slate-400 bg-slate-50 p-3 text-xs">
        No assignment has been recorded against these slots yet.
      </p>
    );
  }
  const who = (from: number | null, to: number | null) =>
    from == null && to == null ? null : `${from ?? "nobody"} → ${to ?? "nobody"}`;

  return (
    <ul data-testid="history" className="space-y-1">
      {rows.map(e => (
        <li key={e.id} data-testid={`history-${e.id}`} className="rounded border border-slate-200 bg-white p-2 text-xs">
          <span className="font-medium">{e.eventType.replace(/_/g, " ")}</span>
          {" · slot "}{e.roleId}
          {" · "}{e.occurredAt.toISOString().slice(0, 16).replace("T", " ")}
          {" · by user "}{e.actorUserId}
          {who(e.fromOperatorId, e.toOperatorId) ? <span className="block">operator {who(e.fromOperatorId, e.toOperatorId)}</span> : null}
          {who(e.fromUnitId, e.toUnitId) ? <span className="block">unit {who(e.fromUnitId, e.toUnitId)}</span> : null}
          {e.reason ? <span className="block text-slate-700">“{e.reason}”</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Slots(props: Omit<DispatchJobDetailViewProps, "jobId" | "job" | "readiness" | "onRefresh" | "refreshing">) {
  const { slots, canAssign } = props;
  if (slots.kind === "loading") return <p data-testid="slots-loading" className="text-sm text-slate-600">Reading slots…</p>;
  if (slots.kind === "failed") return <Alert message={slots.message} />;
  if (slots.kind === "no_posting") {
    return (
      <p data-testid="slots-no-posting" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">
        This job has no dispatch posting, so it has no crew slots to show. That is not the same as a
        posting nobody has been put on — there is nothing yet to put anyone on.
      </p>
    );
  }

  const anyTrailer = slots.rows.some(r => r.trailerId != null);

  return (
    <div className="space-y-3">
      <Staffing staffing={slots.staffing} planningState={slots.planningState} />

      {slots.rows.length === 0 ? (
        <p data-testid="slots-none" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">
          This posting has no crew slots on it yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {slots.rows.map(r => (
            <Slot key={r.roleId} row={r} namesResolved={props.namesResolved}
              operatorChoices={props.operatorChoices} unitChoices={props.unitChoices}
              canAssign={canAssign} mutation={props.mutation}
              onAssign={props.onAssign} onUnassign={props.onUnassign} />
          ))}
        </ul>
      )}

      {!canAssign ? (
        <p data-testid="assign-not-permitted" className="rounded border border-slate-400 bg-slate-50 p-3 text-xs">
          You cannot change crew on this job — that needs the dispatch assign permission, which this
          account does not hold. The slots above are shown because you may read them.
        </p>
      ) : null}

      <p data-testid="assignment-scope-note" className="text-xs text-slate-600">
        Putting a crew on a slot records who is on it, and nothing else. Whether they may lawfully be
        sent is a separate judgement the readiness panel below makes on its own evidence, and filling
        a slot here does not make it, settle it, or count as having won the work.
      </p>

      {anyTrailer ? (
        <p data-testid="trailer-typing-note" className="text-xs text-slate-600">
          A trailer is held as a unit record, and the server does not verify that the id belongs to a
          trailer rather than to a truck — the type field it would check is free text nothing reads.
          Tenancy and existence are checked; the kind of asset is not.
        </p>
      ) : null}
    </div>
  );
}

export function DispatchJobDetailView(props: DispatchJobDetailViewProps) {
  const { jobId, job, readiness, onRefresh, refreshing, slots } = props;
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

      <section aria-labelledby="slots-heading" className="space-y-2">
        <h2 id="slots-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Crew slots on this job
        </h2>
        <Slots {...props} />
      </section>

      {slots.kind === "loaded" ? (
        <section aria-labelledby="history-heading" className="space-y-2">
          <h2 id="history-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            What happened to these slots
          </h2>
          <History rows={slots.history} />
        </section>
      ) : null}

      <section aria-labelledby="readiness-section-heading" className="space-y-2">
        <h2 id="readiness-section-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Dispatch readiness
        </h2>
        {readiness}
      </section>
    </div>
  );
}

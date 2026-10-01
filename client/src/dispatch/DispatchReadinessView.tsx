/**
 * The Readiness Panel — the view.
 *
 * Props in, DOM out. No tRPC, no fetch, no state of its own beyond what it is handed. Everything
 * it renders comes from `dispatch.readiness`, and every status on the screen goes through
 * `readinessPresentation` so that nothing here can round a server answer up.
 *
 * What this panel deliberately does not do: award, assign, override, force ready, resolve a
 * defect, attest hours, or edit a safety policy. It reads. Those acts have their own procedures,
 * their own permissions and their own audit, and a read screen that grew a write button would be
 * the second place a dispatcher could dispatch from.
 */
import {
  presentBlocker, presentCapability, presentVerdict,
  type Presented,
} from "./readinessPresentation";

export type ReadinessBlocker = {
  code: string;
  label: string;
  severity: string;
  subject: string;
  overridable: boolean;
  overrideAuthority?: "dispatcher" | "manager" | "administrator" | string;
};

/** Exactly what `dispatch.readiness` returns, and nothing the panel wishes it returned. */
export type ReadinessResult = {
  verdict: string;
  explanation: string;
  blockers: ReadinessBlocker[];
  contributions: { engine: string; finding: string }[];
};

/**
 * One P8.1 capability result, exactly as `dispatch.readiness` sends it. `reason` is present only on
 * NOT_EVALUATED and is required there — there is no unexplained NOT_EVALUATED, and the screen is
 * the last place that rule could be lost.
 */
export type CapabilityRow = { capability: string; status: string; detail?: string | null; reason?: string | null };

/**
 * The server's own combined status for the capability picture. It is shown as what it is — the
 * capability picture's combined answer — and it is never the panel's overall verdict. Those are two
 * server outputs, and when they disagree the disagreement belongs to the server, not to a screen
 * picking the one it likes.
 */
export type CapabilityVerdict = { status: string; explanation: string; missingRequired: readonly string[] };

/**
 * B23.3 — one finding from Scheduling Intelligence, exactly as `work.scheduleAssess` sends it. The
 * link is the server's, derived from the reference; the panel never composes one.
 */
export type SchedulingFinding = { engine: string; state: "ok" | "review" | "block" | "unknown"; line: string; ref: string | null; deepLink: string | null };

export type SchedulingAssessment = {
  verdict: "FEASIBLE" | "FEASIBLE_WITH_REVIEW" | "NOT_FEASIBLE" | "UNKNOWN";
  summary: string;
  availableFrom: string | Date | null;
  dutyWindowEndsAt: string | Date | null;
  findings: SchedulingFinding[];
  window: { from: string | Date; to: string | Date };
  /** Where the window and the duration came from, in the server's words. */
  basis: string;
};

/** The scheduling strip's state. Absent (undefined) means the panel does not show it at all. */
export type SchedulingPanelState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; assessment: SchedulingAssessment | null };

export type ReadinessPanelState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; result: ReadinessResult | null };

export type DispatchReadinessViewProps = {
  jobId: number;
  /** Null when the job has no assignment with both a unit and a driver to ask about. */
  subject: { operatorId: number; unitId: number | null; trailerId: number | null } | null;
  state: ReadinessPanelState;
  /**
   * Null means the server sent no capability picture at all; an empty array means it sent one with
   * nothing in it. Both are shown as themselves, and neither is shown as nothing-wrong — an empty
   * list of checks reads as clear to anyone glancing at it, which is the failure mode this whole
   * contract exists to prevent.
   */
  capabilities: CapabilityRow[] | null;
  capabilityVerdict: CapabilityVerdict | null;
  onRefresh: () => void;
  refreshing: boolean;
  /**
   * B23.3 — the scheduling answer beside the gate's own. Advice, composed from engines that already
   * decided; it never becomes the verdict above and it never says "ready" — its words are
   * feasible, review, cannot say, not feasible.
   */
  scheduling?: SchedulingPanelState | null;
};

const SCHEDULING_WORDS: Record<SchedulingAssessment["verdict"], { label: string; tone: string }> = {
  FEASIBLE: { label: "Feasible", tone: "border-emerald-600 bg-emerald-50 text-emerald-900" },
  FEASIBLE_WITH_REVIEW: { label: "Feasible with review", tone: "border-amber-600 bg-amber-50 text-amber-900" },
  UNKNOWN: { label: "Cannot say", tone: "border-slate-600 bg-slate-100 text-slate-900" },
  NOT_FEASIBLE: { label: "Not feasible", tone: "border-red-700 bg-red-50 text-red-900" },
};
const FINDING_TONE: Record<SchedulingFinding["state"], string> = { ok: "text-emerald-800", review: "text-amber-800", block: "text-red-800", unknown: "text-slate-600" };
const hhmm = (v: string | Date) => new Date(v).toISOString().slice(11, 16) + "Z";

/** The scheduling strip. Rendered only when the container supplies it; a failed read is a failure on screen. */
function SchedulingSection({ scheduling }: { scheduling: SchedulingPanelState }) {
  return (
    <section aria-label="Scheduling" className="space-y-2" data-testid="scheduling">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Scheduling</h2>
      {scheduling.kind === "loading" && <p className="text-sm text-slate-600">Composing the scheduling answer…</p>}
      {scheduling.kind === "failed" && (
        <p role="alert" data-testid="scheduling-failed" className="rounded border border-red-700 bg-red-50 p-3 text-sm text-red-900">
          The scheduling answer could not be read: {scheduling.message}. Nothing is shown in its place.
        </p>
      )}
      {scheduling.kind === "loaded" && !scheduling.assessment && (
        <p data-testid="scheduling-none" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">No scheduling answer was returned for this assignment.</p>
      )}
      {scheduling.kind === "loaded" && scheduling.assessment && (() => {
        const a = scheduling.assessment;
        const w = SCHEDULING_WORDS[a.verdict];
        return (
          <div data-testid="scheduling-verdict" data-scheduling={a.verdict} className={`space-y-2 rounded border p-3 ${w.tone}`}>
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-medium">{a.summary}</span>
              <span className="inline-block rounded border px-2 py-0.5 text-sm font-medium">{w.label}</span>
            </div>
            <p className="text-xs opacity-80">
              Window {hhmm(a.window.from)}–{hhmm(a.window.to)}{a.availableFrom ? ` · free from ${hhmm(a.availableFrom)}` : ""}{a.dutyWindowEndsAt ? ` · duty window projected to end ${hhmm(a.dutyWindowEndsAt)}` : ""} · {a.basis}
            </p>
            <ul data-testid="scheduling-findings" className="space-y-1 text-sm">
              {a.findings.map((f, i) => (
                <li key={`${f.engine}-${i}`} className={FINDING_TONE[f.state]}>
                  <span className="font-medium">{f.engine}</span>: {f.line}
                  {f.deepLink ? <> <a className="underline" href={f.deepLink}>Open {f.ref ?? "the record"}</a></> : f.ref ? <span className="opacity-70"> ({f.ref})</span> : null}
                </li>
              ))}
            </ul>
            <p className="text-xs opacity-80">
              Advice composed from engines that already decided, each line naming its engine. It never
              becomes the verdict above; dispatch assigns, and the readiness gate runs at award.
            </p>
          </div>
        );
      })()}
    </section>
  );
}

const TONE: Record<Presented["readiness"], string> = {
  ready: "border-emerald-600 bg-emerald-50 text-emerald-900",
  review: "border-amber-600 bg-amber-50 text-amber-900",
  blocked: "border-red-700 bg-red-50 text-red-900",
  insufficient: "border-slate-600 bg-slate-100 text-slate-900",
  not_evaluated: "border-slate-400 bg-slate-50 text-slate-700",
  unavailable: "border-slate-600 bg-slate-100 text-slate-900",
};

function Badge({ p }: { p: Presented }) {
  return <span className={`inline-block rounded border px-2 py-0.5 text-sm font-medium ${TONE[p.readiness]}`}>{p.label}</span>;
}

function Frame({ jobId, subject, children, onRefresh, refreshing }: {
  jobId: number; subject: DispatchReadinessViewProps["subject"]; children: React.ReactNode;
  onRefresh: () => void; refreshing: boolean;
}) {
  return (
    <section className="mx-auto max-w-3xl space-y-4 p-6" aria-labelledby="readiness-heading">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 id="readiness-heading" className="text-xl font-semibold">Dispatch readiness</h1>
          <p data-testid="subject" className="text-sm text-slate-600">
            {subject
              ? `Job ${jobId} · driver (operator ${subject.operatorId}) · unit ${subject.unitId ?? "none"}${subject.trailerId ? ` · trailer ${subject.trailerId}` : ""}`
              : `Job ${jobId}`}
          </p>
        </div>
        <button type="button" data-testid="refresh" onClick={onRefresh} disabled={refreshing}
          className="rounded border px-3 py-1 text-sm">
          {refreshing ? "Checking…" : "Re-check"}
        </button>
      </header>
      {children}
      <p className="text-xs text-slate-500">
        This is what the dispatch engine decided, shown as it decided it. Nothing on this screen
        changes a verdict, and a verdict here is a point in time — it is re-checked at award.
      </p>
    </section>
  );
}

export function DispatchReadinessView(props: DispatchReadinessViewProps) {
  const { jobId, subject, state, capabilities, capabilityVerdict, onRefresh, refreshing, scheduling } = props;
  const frame = (children: React.ReactNode) =>
    <Frame jobId={jobId} subject={subject} onRefresh={onRefresh} refreshing={refreshing}>{children}</Frame>;

  if (!subject) {
    return frame(
      <p data-testid="panel-no-subject" className="rounded border border-slate-400 bg-slate-50 p-4 text-sm">
        This job has no assignment naming both a unit and a driver, so there is no readiness
        question to ask. Assign a unit and a driver first.
      </p>
    );
  }

  if (state.kind === "loading") {
    return frame(<p data-testid="panel-loading" className="text-sm text-slate-600">Checking readiness…</p>);
  }

  if (state.kind === "failed") {
    return frame(
      <div role="alert" data-testid="panel-failed" className="space-y-2 rounded border border-red-700 bg-red-50 p-4">
        <p className="font-medium text-red-900">Readiness could not be checked.</p>
        <p className="text-sm text-red-900">{state.message}</p>
        <p className="text-sm text-red-900">
          No verdict is shown, and no earlier answer is reused. A readiness that could not be
          checked is not a readiness that passed.
        </p>
        <button type="button" data-testid="retry" onClick={onRefresh} disabled={refreshing}
          className="rounded border border-red-700 px-3 py-1 text-sm">Try again</button>
      </div>
    );
  }

  if (!state.result) {
    return frame(
      <p data-testid="panel-empty" className="rounded border border-slate-400 bg-slate-50 p-4 text-sm">
        No readiness was returned for this job. Nothing is being claimed about it either way.
      </p>
    );
  }

  const { verdict, explanation, blockers, contributions } = state.result;
  /* The overall verdict is the server's. It is never recomputed from the rows below it. */
  const overall = presentVerdict(verdict);

  return frame(
    <>
      <div data-testid="overall-verdict" data-readiness={overall.readiness}
        className={`space-y-1 rounded border p-4 ${TONE[overall.readiness]}`}>
        <p className="text-lg font-semibold">{overall.label}</p>
        <p className="text-sm">{overall.meaning}</p>
        <p className="text-xs opacity-80">Server verdict: {verdict || "(none sent)"}</p>
      </div>

      <p data-testid="explanation" className="text-sm text-slate-800">{explanation}</p>

      <section aria-label="Blockers" className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          What is in the way
        </h2>
        {blockers.length === 0
          ? <p data-testid="no-blockers" className="text-sm text-slate-600">The engine named no blockers.</p>
          : blockers.map(b => {
              const p = presentBlocker(b);
              return (
                <div key={b.code} data-testid={`blocker-${b.code}`} data-readiness={p.readiness}
                  className={`space-y-1 rounded border p-3 ${TONE[p.readiness]}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">{b.label}</span>
                    <Badge p={p} />
                  </div>
                  <p className="text-xs opacity-80">{b.code} · {b.subject}</p>
                  <p className="text-sm">{p.overrideNote}</p>
                </div>
              );
            })}
      </section>

      <section aria-label="Capability checks" className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Capability checks</h2>
        {capabilityVerdict && (() => {
          const p = presentCapability(capabilityVerdict.status);
          return (
            <div data-testid="capability-verdict" data-readiness={p.readiness}
              className={`space-y-1 rounded border p-3 ${TONE[p.readiness]}`}>
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-medium">Capability picture: {p.label}</span>
                <Badge p={p} />
              </div>
              <p className="text-sm">{capabilityVerdict.explanation}</p>
              {capabilityVerdict.missingRequired.length > 0 && (
                <p className="text-sm">
                  Required but not evaluated: {capabilityVerdict.missingRequired.join(", ")}
                </p>
              )}
              <p className="text-xs opacity-80">
                This is the capability picture's own combined status. The verdict above is the one
                that governs dispatch.
              </p>
            </div>
          );
        })()}
        {capabilities === null
          ? (
            <p data-testid="capabilities-unavailable" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">
              The server sent no capability picture with this readiness, so none is shown. It is not
              being claimed that these checks passed — they were not supplied.
            </p>
          )
          : capabilities.length === 0
          ? (
            <p data-testid="capabilities-empty" className="rounded border border-slate-400 bg-slate-50 p-3 text-sm">
              The server returned no capabilities for this dispatch. Nothing was evaluated, which is
              not the same as nothing being wrong.
            </p>
          )
          : capabilities.map(c => {
              const p = presentCapability(c.status);
              return (
                <div key={c.capability} data-testid={`capability-${c.capability}`} data-readiness={p.readiness}
                  className={`flex items-start justify-between gap-3 rounded border p-3 ${TONE[p.readiness]}`}>
                  <div>
                    <span className="font-medium">{c.capability}</span>
                    <p className="text-sm">{c.detail || p.meaning}</p>
                    {/* Only ever rendered from what arrived. A capability with no reason shows none. */}
                    {c.reason ? <p className="text-xs opacity-80">Not evaluated: {c.reason}</p> : null}
                  </div>
                  <Badge p={p} />
                </div>
              );
            })}
      </section>

      <section aria-label="What the engines found" className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">What the engines found</h2>
        <ul data-testid="contributions" className="space-y-1 text-sm text-slate-700">
          {contributions.length === 0
            ? <li>None recorded.</li>
            : contributions.map((c, i) => (
                <li key={`${c.engine}-${i}`}><span className="font-medium">{c.engine}</span>: {c.finding}</li>
              ))}
        </ul>
      </section>

      {scheduling ? <SchedulingSection scheduling={scheduling} /> : null}
    </>
  );
}

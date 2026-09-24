/**
 * 0187 — Compliance Operations: the queues safety/admin work from.
 *
 * Renewal Queue · Verification Queue · Source Review · System Exceptions.
 * (The External Training Queue is the existing `CompliancePanel` request list.)
 *
 * Presentational, like TrainingWalletView: data and callbacks in, nothing
 * decided here. Every action is a server procedure, and the server enforces the
 * rules the buttons describe (no self-verification, two people per source, a
 * verifier cannot change the uploaded facts). The copy keeps the line the
 * server keeps: a system failure is never a compliance conclusion, a company
 * review is never an expiry, and a request or booking never counts for work.
 */
import { useState, type ReactNode } from "react";

const btn = "min-h-12 rounded-xl px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const primary = `${btn} bg-primary text-primary-foreground hover:opacity-90`;
const secondary = `${btn} border border-border bg-card text-foreground hover:bg-muted`;
const card = "rounded-2xl border border-border bg-card p-4 text-card-foreground md:p-5";
const muted = "text-sm leading-6 text-muted-foreground";
const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

const TONE: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  bad: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  sys: "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-100",
  none: "bg-muted text-foreground",
};
function Tag({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  return <span className={`inline-flex min-h-7 items-center rounded-full px-3 text-xs font-semibold ${TONE[tone]}`}>{children}</span>;
}

/* ------------------------------------------------------------------ */
/* Renewal Queue                                                        */
/* ------------------------------------------------------------------ */

export type RenewalRow = {
  userId: number; employeeName: string | null; holdingRef: string; code: string; displayName: string; source: "wallet" | "academy";
  targetDate: Date | string | null; daysRemaining: number | null; targetKind: "legal_expiry" | "company_review" | "none";
  readinessImpact: string[]; handoff: { handoffRef: string; status: string } | null;
  lastReminder: { at: Date | string; title: string } | null;
  nextEscalation: { threshold: number | "expired"; inDays: number | null; recipients: string[] } | null;
};

export function RenewalQueuePanel({ rows, notice }: { rows: RenewalRow[]; notice: string }) {
  return (
    <section className={card} aria-labelledby="renewal-queue" data-testid="renewal-queue">
      <h2 id="renewal-queue" className="text-lg font-semibold">Renewal queue</h2>
      <p className={muted}>{notice}</p>
      {!rows.length && <p className={`${muted} mt-2`}>Nothing inside the notification window.</p>}
      <ul className="mt-3 space-y-3">
        {rows.map(r => {
          const review = r.targetKind === "company_review";
          const past = r.daysRemaining != null && r.daysRemaining < 0;
          return (
            <li key={`${r.holdingRef}:${r.code}`} className="rounded-xl border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{r.employeeName ?? `Employee ${r.userId}`} — {r.displayName}</p>
                <Tag tone={review ? "warn" : past ? "bad" : (r.daysRemaining ?? 99) <= 14 ? "bad" : "warn"}>
                  {review ? (past ? "Company review overdue" : `Company review in ${r.daysRemaining} day(s)`) : past ? `Expired ${-r.daysRemaining!} day(s) ago` : `Expires in ${r.daysRemaining} day(s)`}
                </Tag>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {review ? "Company review date (company policy, not an expiry)" : "Expiry"} {fmt(r.targetDate)} · {r.source === "academy" ? "Academy-issued certificate" : "Wallet credential"}
              </p>
              <p className="mt-1">Readiness impact: {r.readinessImpact.length ? r.readinessImpact.join("; ") : "no bound dispatch requirement"}</p>
              <p className="mt-1">Renewal: {r.handoff ? r.handoff.status.replaceAll("_", " ").toLowerCase() : "not requested"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Last reminder: {r.lastReminder ? `${fmt(r.lastReminder.at)} — ${r.lastReminder.title}` : "none yet"}
                {" · "}Next escalation: {r.nextEscalation ? `${r.nextEscalation.threshold === "expired" ? "on expiry" : `${r.nextEscalation.threshold}-day notice`} in ${r.nextEscalation.inDays} day(s) → ${r.nextEscalation.recipients.join(", ")}` : "none left"}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Verification Queue                                                   */
/* ------------------------------------------------------------------ */

export type VerificationItem = {
  holdingRef: string; employee: { userId: number; name: string | null }; code: string; displayName: string; issuer: string | null; issuingJurisdiction: string | null;
  certificateNumber: string | null; issuedAt: Date | string | null; expiresAt: Date | string | null; documentRef: string | null; backDocumentRef: string | null;
  restrictions: string[]; recordedAt: Date | string; correctsHoldingRef: string | null;
  correction: { requestedAt: Date | string; note: string | null } | null;
  previousVerified: { holdingRef: string; expiresAt: Date | string | null } | null;
  implications: { heldNow: boolean; heldIfVerified: boolean; requirements: string[]; note: string };
  handoff: { handoffRef: string; status: string } | null;
  callerMayAct: boolean; callerBlockedBecause: string | null;
};
export type VerifyInput = { holdingRef: string; method: "original_sighted" | "document_inspection" | "issuer_registry_check" | "issuer_confirmation"; verificationSource: string; issuedAt: Date | null; expiresAt: Date | null };

export function VerificationQueuePanel(props: {
  items: VerificationItem[];
  onVerify: (v: VerifyInput) => void;
  onReject: (holdingRef: string, reason: string) => void;
  onRequestCorrection: (holdingRef: string, note: string) => void;
  busy: boolean;
}) {
  return (
    <section className={card} aria-labelledby="verification-queue" data-testid="verification-queue">
      <h2 id="verification-queue" className="text-lg font-semibold">Uploaded — verification required</h2>
      <p className={muted}>Check the document or the issuer. You confirm what was uploaded; if the document says something different, request a correction — you cannot change the employee's record into a valid one.</p>
      {!props.items.length && <p className={`${muted} mt-2`}>Nothing waiting.</p>}
      <ul className="mt-3 space-y-3">{props.items.map(i => <VerificationRow key={i.holdingRef} item={i} {...props} />)}</ul>
    </section>
  );
}

function VerificationRow({ item: i, onVerify, onReject, onRequestCorrection, busy }: { item: VerificationItem; onVerify: (v: VerifyInput) => void; onReject: (h: string, r: string) => void; onRequestCorrection: (h: string, n: string) => void; busy: boolean }) {
  const [method, setMethod] = useState<VerifyInput["method"]>("document_inspection");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const id = `v-${i.holdingRef}`;
  const disabled = busy || !i.callerMayAct || !!i.correction;
  return (
    <li className="rounded-xl border border-border p-3 text-sm" data-testid={`verify-${i.code}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{i.employee.name ?? `Employee ${i.employee.userId}`} — {i.displayName}</p>
        <Tag tone={i.correction ? "warn" : "none"}>{i.correction ? "Correction requested" : "Unverified"}</Tag>
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs md:grid-cols-2">
        <div><dt className="inline text-muted-foreground">Issuer: </dt><dd className="inline">{i.issuer ?? "—"}{i.issuingJurisdiction ? ` (${i.issuingJurisdiction})` : ""}</dd></div>
        <div><dt className="inline text-muted-foreground">Number: </dt><dd className="inline">{i.certificateNumber ?? "—"}</dd></div>
        <div><dt className="inline text-muted-foreground">Issued: </dt><dd className="inline">{fmt(i.issuedAt)}</dd></div>
        <div><dt className="inline text-muted-foreground">Expires (as uploaded): </dt><dd className="inline">{fmt(i.expiresAt)}</dd></div>
        <div><dt className="inline text-muted-foreground">Documents: </dt><dd className="inline">{[i.documentRef, i.backDocumentRef].filter(Boolean).join(", ") || "none"}</dd></div>
        <div><dt className="inline text-muted-foreground">Previous verified: </dt><dd className="inline">{i.previousVerified ? `expires ${fmt(i.previousVerified.expiresAt)}` : "none"}</dd></div>
        <div><dt className="inline text-muted-foreground">From request: </dt><dd className="inline">{i.handoff ? `${i.handoff.handoffRef} (${i.handoff.status.replaceAll("_", " ").toLowerCase()})` : "none"}</dd></div>
        {i.correctsHoldingRef && <div><dt className="inline text-muted-foreground">Corrects: </dt><dd className="inline">{i.correctsHoldingRef}</dd></div>}
      </dl>
      {!!i.restrictions.length && <p className="mt-1 text-xs font-medium">Restrictions: {i.restrictions.join(", ")}</p>}
      <p className="mt-2 text-xs">Counts for work now: <strong>{i.implications.heldNow ? "yes" : "no"}</strong> · if verified: <strong>{i.implications.heldIfVerified ? "yes" : "no"}</strong>{i.implications.requirements.length ? ` · required by ${i.implications.requirements.join("; ")}` : ""}</p>
      {i.correction && <p className="mt-1 text-xs">Correction asked {fmt(i.correction.requestedAt)}: {i.correction.note}</p>}
      {i.callerBlockedBecause && <p className="mt-2 text-xs font-medium" role="note">{i.callerBlockedBecause} — another authorized person must act.</p>}
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <label className="grid gap-1 text-xs" htmlFor={`${id}-m`}>How you checked
          <select id={`${id}-m`} className="min-h-12 rounded-xl border border-border bg-background px-3 text-sm" value={method} onChange={e => setMethod(e.target.value as VerifyInput["method"])} disabled={disabled}>
            <option value="document_inspection">Document inspected</option>
            <option value="original_sighted">Original sighted</option>
            <option value="issuer_registry_check">Issuer registry check</option>
            <option value="issuer_confirmation">Issuer confirmed</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs" htmlFor={`${id}-s`}>What you checked against
          <input id={`${id}-s`} className="min-h-12 rounded-xl border border-border bg-background px-3 text-sm" value={source} onChange={e => setSource(e.target.value)} disabled={disabled} />
        </label>
        <label className="grid gap-1 text-xs md:col-span-2" htmlFor={`${id}-n`}>Reason (reject or correction)
          <input id={`${id}-n`} className="min-h-12 rounded-xl border border-border bg-background px-3 text-sm" value={note} onChange={e => setNote(e.target.value)} disabled={busy || !i.callerMayAct} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={disabled || source.trim().length < 3} onClick={() => onVerify({ holdingRef: i.holdingRef, method, verificationSource: source.trim(), issuedAt: i.issuedAt ? new Date(i.issuedAt) : null, expiresAt: i.expiresAt ? new Date(i.expiresAt) : null })}>Verify as uploaded</button>
        <button type="button" className={secondary} disabled={disabled || note.trim().length < 10} onClick={() => onRequestCorrection(i.holdingRef, note.trim())}>Request correction</button>
        <button type="button" className={secondary} disabled={busy || !i.callerMayAct || note.trim().length < 3} onClick={() => onReject(i.holdingRef, note.trim())}>Reject</button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Source Review                                                        */
/* ------------------------------------------------------------------ */

export type SourceRow = {
  sourceRef: string; authority: string; title: string; jurisdiction: string; edition: string | null; url: string | null; tier: string;
  retrievedAt: Date | string | null; fingerprint: string | null; fingerprintKind: string; reviewStatus: string; impactStatus: string;
  proposedByUserId: number | null; firstReviewedByUserId: number | null; lastReviewedByUserId: number | null; lastReviewedAt: Date | string | null;
  supersededBySourceRef: string | null; supersedesSourceRef: string | null; rejectionReason: string | null;
  affected: { courseVersions: number; modules: number; questions: number; policies: number; regulatoryProfiles: number };
};
export type SourceAction = "REVIEW" | "APPROVE" | "REJECT" | "MARK_SUPERSEDED";
const IMPACT_TONE: Record<string, keyof typeof TONE> = { SOURCE_CURRENT: "ok", SOURCE_SUPERSEDED_REVIEW_REQUIRED: "warn", SOURCE_UNREVIEWED: "none", SOURCE_REJECTED: "bad" };

export function SourceReviewPanel(props: { sources: SourceRow[]; onAct: (sourceRef: string, action: SourceAction, note: string, successorRef: string | null) => void; busy: boolean }) {
  return (
    <section className={card} aria-labelledby="source-review" data-testid="source-review">
      <h2 id="source-review" className="text-lg font-semibold">Source review</h2>
      <p className={muted}>One person reviews, a different person approves. A reviewed source is never edited — a new edition is a new source, and attempts taken on the old one stay tied to it. Nothing here rewrites course content.</p>
      <ul className="mt-3 space-y-3">{props.sources.map(s => <SourceItem key={s.sourceRef} s={s} {...props} />)}</ul>
    </section>
  );
}

function SourceItem({ s, onAct, busy, sources }: { s: SourceRow; onAct: (r: string, a: SourceAction, n: string, succ: string | null) => void; busy: boolean; sources: SourceRow[] }) {
  const [note, setNote] = useState("");
  const [successor, setSuccessor] = useState("");
  const id = `s-${s.sourceRef.replace(/[^A-Za-z0-9-]/g, "-")}`;
  const ok = !busy && note.trim().length >= 10;
  return (
    <li className="rounded-xl border border-border p-3 text-sm" data-testid={`source-${s.sourceRef}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{s.title}</p>
        <Tag tone={IMPACT_TONE[s.impactStatus] ?? "none"}>{s.impactStatus.replaceAll("_", " ").toLowerCase()}</Tag>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{s.authority} · {s.jurisdiction}{s.edition ? ` · ${s.edition}` : ""} · {s.tier.replaceAll("_", " ")} · retrieved {fmt(s.retrievedAt)}</p>
      {s.url && <p className="mt-1 break-all text-xs">{s.url.startsWith("internal://") ? s.url : <a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.url}</a>}</p>}
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Fingerprint ({s.fingerprintKind}): {s.fingerprint ?? "none"}</p>
      <p className="mt-1 text-xs">State: {s.reviewStatus.replaceAll("_", " ")} · last reviewer {s.lastReviewedByUserId ?? "—"} on {fmt(s.lastReviewedAt)}{s.supersededBySourceRef ? ` · superseded by ${s.supersededBySourceRef}` : ""}{s.supersedesSourceRef ? ` · supersedes ${s.supersedesSourceRef}` : ""}{s.rejectionReason ? ` · rejected: ${s.rejectionReason}` : ""}</p>
      <p className="mt-1 text-xs">Governs: {s.affected.courseVersions} course version(s), {s.affected.modules} lesson(s), {s.affected.questions} question(s), {s.affected.policies} renewal polic(ies), {s.affected.regulatoryProfiles} regulatory profile(s)</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <label className="grid gap-1 text-xs" htmlFor={`${id}-n`}>Review note (10+ characters)
          <input id={`${id}-n`} className="min-h-12 rounded-xl border border-border bg-background px-3 text-sm" value={note} onChange={e => setNote(e.target.value)} />
        </label>
        {s.reviewStatus === "reviewed" && (
          <label className="grid gap-1 text-xs" htmlFor={`${id}-succ`}>Superseded by
            <select id={`${id}-succ`} className="min-h-12 rounded-xl border border-border bg-background px-3 text-sm" value={successor} onChange={e => setSuccessor(e.target.value)}>
              <option value="">Choose the newer source…</option>
              {sources.filter(x => x.sourceRef !== s.sourceRef && (x.reviewStatus === "reviewed" || x.reviewStatus === "under_review" || x.reviewStatus === "unreviewed")).map(x => <option key={x.sourceRef} value={x.sourceRef}>{x.title}{x.edition ? ` (${x.edition})` : ""}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {s.reviewStatus === "unreviewed" && <button type="button" className={primary} disabled={!ok} onClick={() => onAct(s.sourceRef, "REVIEW", note.trim(), null)}>Review</button>}
        {s.reviewStatus === "under_review" && <button type="button" className={primary} disabled={!ok} onClick={() => onAct(s.sourceRef, "APPROVE", note.trim(), null)}>Approve (second person)</button>}
        {(s.reviewStatus === "unreviewed" || s.reviewStatus === "under_review") && <button type="button" className={secondary} disabled={!ok} onClick={() => onAct(s.sourceRef, "REJECT", note.trim(), null)}>Reject</button>}
        {s.reviewStatus === "reviewed" && <button type="button" className={secondary} disabled={!ok || !successor} onClick={() => onAct(s.sourceRef, "MARK_SUPERSEDED", note.trim(), successor)}>Mark superseded</button>}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* System exceptions (the sweep's own health)                           */
/* ------------------------------------------------------------------ */

export type SweepRun = { runRef: string; slotKey: string; status: string; startedAt: Date | string; completedAt: Date | string | null; inspected: number; actionable: number; notificationsCreated: number; suppressed: number; failureCount: number; errorSummary: string | null };
export type SystemException = { key: string; title: string; reason: string };

export function SystemExceptionsPanel({ runs, exceptions, notice }: { runs: SweepRun[]; exceptions: SystemException[]; notice: string }) {
  return (
    <section className={card} aria-labelledby="system-exceptions" data-testid="system-exceptions">
      <h2 id="system-exceptions" className="text-lg font-semibold">System exceptions</h2>
      <p className={muted}>{notice}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {exceptions.map(e => <li key={e.key} className="rounded-xl border border-border p-3"><Tag tone="sys">System failure</Tag><p className="mt-1 font-medium">{e.title}</p><p className="text-xs text-muted-foreground">{e.reason}</p></li>)}
        {!exceptions.length && <li className={muted}>No sweep failures in the last two days.</li>}
      </ul>
      <h3 className="mt-4 font-semibold">Recent scheduled runs</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead><tr className="text-muted-foreground"><th scope="col" className="py-1 pr-2">Slot</th><th scope="col" className="pr-2">Status</th><th scope="col" className="pr-2">Inspected</th><th scope="col" className="pr-2">Actionable</th><th scope="col" className="pr-2">Created</th><th scope="col" className="pr-2">Suppressed</th><th scope="col">Failures</th></tr></thead>
          <tbody>
            {runs.map(r => <tr key={r.runRef} className="border-t border-border"><td className="py-1 pr-2">{r.slotKey.split(":").slice(1).join(":")}</td><td className="pr-2"><Tag tone={r.status === "completed" ? "ok" : r.status === "running" ? "none" : "sys"}>{r.status}</Tag></td><td className="pr-2">{r.inspected}</td><td className="pr-2">{r.actionable}</td><td className="pr-2">{r.notificationsCreated}</td><td className="pr-2">{r.suppressed}</td><td>{r.failureCount}{r.errorSummary ? ` (${r.errorSummary})` : ""}</td></tr>)}
            {!runs.length && <tr><td colSpan={7} className="py-2 text-muted-foreground">No scheduled run recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

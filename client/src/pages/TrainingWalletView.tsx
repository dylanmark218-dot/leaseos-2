/**
 * 0172 — Training wallet, Study Centre, library, pathway and compliance panels.
 *
 * Presentational only: every panel takes data and callbacks, so it renders the
 * same in the app, in tests and under the accessibility harness. Built for the
 * field — phone first, 48px touch targets, plain language, theme tokens (so
 * dark and light both work), visible source/version on every lesson, and the
 * credential boundary stated wherever study could be mistaken for a licence.
 *
 * Nothing here decides anything. Held/expired/unverified come from the server's
 * canonical rule; this file only shows the answer and the way out.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Shared bits                                                          */
/* ------------------------------------------------------------------ */

const btn = "min-h-12 rounded-xl px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const primary = `${btn} bg-primary text-primary-foreground hover:opacity-90`;
const secondary = `${btn} border border-border bg-card text-foreground hover:bg-muted`;
const card = "rounded-2xl border border-border bg-card p-4 text-card-foreground md:p-5";
const muted = "text-sm leading-6 text-muted-foreground";
const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

export function BoundaryNotice({ children }: { children: ReactNode }) {
  return (
    <div role="note" data-testid="boundary-notice" className="rounded-xl border border-amber-400/60 bg-amber-50 p-3 text-sm leading-6 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
      <strong className="font-semibold">Preparation only. </strong>{children}
    </div>
  );
}

/** Read-aloud hook. Uses the browser's speech synthesis when present; says so when it is not. */
export function useReadAloud() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const speak = useCallback((text: string) => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }, [supported]);
  const stop = useCallback(() => { if (supported) window.speechSynthesis.cancel(); }, [supported]);
  return { supported, speak, stop };
}

export function ReadAloudButton({ text, label = "Read aloud" }: { text: string; label?: string }) {
  const { supported, speak } = useReadAloud();
  if (!supported) return null;
  return <button type="button" className={secondary} onClick={() => speak(text)} aria-label={`${label}: ${text.slice(0, 40)}`}>🔊 {label}</button>;
}

const STATE_STYLE: Record<string, string> = {
  held: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  expired: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  unverified: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  restricted: "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-100",
  unknown: "bg-muted text-foreground",
};
function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`inline-flex min-h-7 items-center rounded-full px-3 text-xs font-semibold ${STATE_STYLE[tone] ?? STATE_STYLE.unknown}`}>{children}</span>;
}

/* ------------------------------------------------------------------ */
/* Wallet                                                               */
/* ------------------------------------------------------------------ */

export type WalletCredential = {
  holdingRef: string; code: string; displayName: string; issuer: string | null; issuingJurisdiction: string | null; certificateNumber: string | null;
  issuedAt: Date | string | null; expiresAt: Date | string | null; endorsements: string[]; restrictions: string[];
  verificationState: string; verifiedAt: Date | string | null; boundary: string | null; lifecycle: string; current: boolean; supersededByHoldingRef: string | null;
  correction?: { requestedAt: Date | string; note: string | null } | null;
};
/** 0187 — the credential's own status and the renewal in motion are separate fields; a request never extends validity. */
export type WalletStatusCode = "VALID" | "EXPIRING" | "EXPIRED" | "UNVERIFIED" | "COMPANY_REVIEW_DUE" | "UNKNOWN";
export type RenewalStatusCode = "RENEWAL_REQUESTED" | "BOOKED" | "AWAITING_DOCUMENT" | "NONE";
export type WalletExpiring = {
  code: string; basis: string; legalExpiry: Date | string | null; employerReviewAt: Date | string | null; labels: string[]; held: boolean; heldReason: string; canRequestTraining: boolean;
  walletStatus?: WalletStatusCode; renewalStatus?: RenewalStatusCode; statusLine?: string; renewalSteps?: { label: string; done: boolean }[]; validityNote?: string; correctionRequested?: boolean;
};
const WALLET_STATUS: Record<WalletStatusCode, { tone: string; label: string }> = {
  VALID: { tone: "held", label: "Valid" }, EXPIRING: { tone: "unverified", label: "Expiring" }, EXPIRED: { tone: "expired", label: "Expired" },
  UNVERIFIED: { tone: "unverified", label: "Uploaded — verification required" }, COMPANY_REVIEW_DUE: { tone: "unverified", label: "Company review due" }, UNKNOWN: { tone: "unknown", label: "Unknown" },
};
const RENEWAL_LABEL: Record<RenewalStatusCode, string> = { RENEWAL_REQUESTED: "Renewal requested", BOOKED: "Booked", AWAITING_DOCUMENT: "Awaiting certificate", NONE: "" };
export type WalletHandoff = { handoffRef: string; code: string; status: string; worker: { label: string; step: number }; appointmentAt: Date | string | null; bookingReference: string | null; requestedAt: Date | string };
export type WalletData = {
  disclaimer: string;
  studied: { ref: string; courseCode: string; title: string; status: string; note: string | null }[];
  demonstrated: { evaluationRef: string; competencyCode: string; status: string; observedAt: Date | string }[];
  credentials: WalletCredential[];
  expiring: WalletExpiring[];
  arranged: WalletHandoff[];
};

const BOUNDARY_LABEL: Record<string, string> = {
  employer_issued: "Employer-issued", company_competency: "Company competency", regulator_issued: "Regulator-issued",
  external_provider: "External provider certificate", study_only: "Study / preparation only",
};

export type UploadForm = { code: string; boundary: string; issuer: string; certificateNumber: string; issuedAt: string; expiresAt: string; documentRef: string; backDocumentRef: string; restrictions: string; correctsHoldingRef?: string };

export function WalletPanel(props: {
  wallet: WalletData | null;
  policies: { qualificationCode: string; displayName: string; boundary: string; lifecycle: string }[];
  onRequestTraining: (code: string) => void;
  requesting: boolean;
  onUpload: (f: UploadForm) => void;
  uploading: boolean;
  onHandoffDone: (handoffRef: string) => void;
}) {
  const w = props.wallet;
  const [form, setForm] = useState<UploadForm>({ code: "", boundary: "external_provider", issuer: "", certificateNumber: "", issuedAt: "", expiresAt: "", documentRef: "", backDocumentRef: "", restrictions: "", correctsHoldingRef: "" });
  const policy = props.policies.find(p => p.qualificationCode === form.code);
  const set = (k: keyof UploadForm) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value, ...(k === "code" ? { boundary: props.policies.find(p => p.qualificationCode === e.target.value)?.boundary ?? f.boundary } : {}) }));
  if (!w) return <p className={muted}>Loading your wallet…</p>;
  const current = w.credentials.filter(c => c.current || c.verificationState === "unverified" || c.verificationState === "extracted");
  const history = w.credentials.filter(c => !current.includes(c));
  return (
    <div className="space-y-5" data-testid="wallet">
      <p className={muted}>{w.disclaimer}</p>

      <section className={card} aria-labelledby="wallet-held">
        <h2 id="wallet-held" className="text-lg font-semibold">Licences & certificates</h2>
        {!current.length && <p className={muted}>No credentials on file yet. Upload a photo or PDF through Records, then add it here — it stays unverified until safety/admin checks it.</p>}
        <ul className="mt-3 space-y-3">
          {current.map(c => {
            const tone = c.verificationState !== "verified" ? "unverified" : c.expiresAt && new Date(c.expiresAt) < new Date() ? "expired" : "held";
            const exp = w.expiring.find(e => e.code === c.code);
            return (
              <li key={c.holdingRef} className="rounded-xl border border-border p-3" data-testid={`credential-${c.code}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{c.displayName}</p>
                  <span className="flex flex-wrap gap-1">
                    {c.verificationState === "verified" && exp?.walletStatus
                      ? <Pill tone={WALLET_STATUS[exp.walletStatus].tone}>{WALLET_STATUS[exp.walletStatus].label}</Pill>
                      : <Pill tone={tone}>{c.verificationState === "verified" ? (tone === "expired" ? "Expired" : "Verified") : c.correction ? "Correction requested" : "Uploaded — verification required"}</Pill>}
                    {c.verificationState === "verified" && exp?.renewalStatus && exp.renewalStatus !== "NONE" && <Pill tone="unknown">{RENEWAL_LABEL[exp.renewalStatus]}</Pill>}
                  </span>
                </div>
                {c.verificationState === "verified" && exp?.statusLine && <p className="mt-1 text-sm font-medium">{exp.statusLine}</p>}
                {c.correction && (
                  <div className="mt-2 rounded-lg border border-amber-400/60 p-2 text-sm" role="note">
                    <p>Safety/admin asked for a correction: {c.correction.note}</p>
                    <button type="button" className={`${secondary} mt-2`} onClick={() => setForm(f => ({ ...f, code: c.code, boundary: c.boundary ?? f.boundary, correctsHoldingRef: c.holdingRef }))}>Upload a corrected record</button>
                  </div>
                )}
                {c.verificationState === "verified" && !!exp?.renewalSteps?.length && (
                  <ol className="mt-2 space-y-1 text-xs" aria-label="Renewal progress">
                    {exp.renewalSteps.map((st, i) => <li key={i} className={st.done ? "font-medium" : "text-muted-foreground"}>{st.done ? "✓" : "○"} {st.label}</li>)}
                  </ol>
                )}
                {c.verificationState === "verified" && exp?.validityNote && <p className="mt-1 text-xs text-muted-foreground">{exp.validityNote}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{BOUNDARY_LABEL[c.boundary ?? ""] ?? "Boundary not recorded"}{c.issuer ? ` · ${c.issuer}` : ""}{c.issuingJurisdiction ? ` · ${c.issuingJurisdiction}` : ""}{c.certificateNumber ? ` · No. ${c.certificateNumber}` : ""}</p>
                <p className="mt-1 text-sm">Issued {fmt(c.issuedAt)} · {c.lifecycle === "no_expiry_endorsement" ? "No renewal by rule (held while your licence is valid)" : `Expires ${fmt(c.expiresAt)}`}</p>
                {!!c.restrictions.length && <p className="mt-1 text-sm font-medium text-orange-800 dark:text-orange-200">Restrictions: {c.restrictions.join(", ")}</p>}
                {exp?.labels.map((l, i) => <p key={i} className="mt-1 text-xs text-muted-foreground">{l}</p>)}
                {exp?.canRequestTraining && <button type="button" className={`${primary} mt-3 w-full md:w-auto`} disabled={props.requesting} onClick={() => props.onRequestTraining(c.code)}>Request training / renewal</button>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className={card} aria-labelledby="wallet-requests">
        <h2 id="wallet-requests" className="text-lg font-semibold">My training requests</h2>
        <p className={muted}>A request or booking does not satisfy any work. Only a verified certificate does.</p>
        {!w.arranged.length && <p className={muted}>No open requests.</p>}
        <ul className="mt-3 space-y-3" data-testid="handoffs">
          {w.arranged.map(h => (
            <li key={h.handoffRef} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{h.code.replaceAll("_", " ")}</p><Pill tone={h.worker.step >= 5 ? "held" : "unknown"}>{h.worker.label}</Pill></div>
              <ol className="mt-2 flex gap-1" aria-label="Progress">{[1, 2, 3, 4, 5].map(s => <li key={s} className={`h-2 flex-1 rounded ${h.worker.step >= s ? "bg-primary" : "bg-muted"}`} />)}</ol>
              <p className="mt-2 text-xs text-muted-foreground">Requested {fmt(h.requestedAt)}{h.appointmentAt ? ` · Appointment ${new Date(h.appointmentAt).toLocaleString()}` : ""}{h.bookingReference ? ` · Ref ${h.bookingReference}` : ""}</p>
              {h.status === "BOOKED" && <button type="button" className={`${secondary} mt-3`} onClick={() => props.onHandoffDone(h.handoffRef)}>I finished the training</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className={card} aria-labelledby="wallet-upload">
        <h2 id="wallet-upload" className="text-lg font-semibold">{form.correctsHoldingRef ? "Upload a corrected record" : "Add a certificate or licence"}</h2>
        {form.correctsHoldingRef && <p className="text-sm" role="status">Correcting {form.code.replaceAll("_", " ")}. The earlier upload is kept in history; the corrected one is checked again.</p>}
        <p className={muted}>It is recorded as unverified. OCR or a photo is never verification — safety/admin checks it against the document or the issuer.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-sm">Credential
            <select className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.code} onChange={set("code")} aria-label="Credential">
              <option value="">Choose…</option>
              {props.policies.filter(p => p.boundary !== "study_only" && p.lifecycle !== "server_profile_expiry").map(p => <option key={p.qualificationCode} value={p.qualificationCode}>{p.displayName}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Issuer<input className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.issuer} onChange={set("issuer")} /></label>
          <label className="grid gap-1 text-sm">Certificate / licence number<input className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.certificateNumber} onChange={set("certificateNumber")} /></label>
          <label className="grid gap-1 text-sm">Issue date<input type="date" className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.issuedAt} onChange={set("issuedAt")} /></label>
          {policy?.lifecycle !== "no_expiry_endorsement" && <label className="grid gap-1 text-sm">Expiry date (as printed)<input type="date" className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.expiresAt} onChange={set("expiresAt")} /></label>}
          <label className="grid gap-1 text-sm">Front / PDF (Records reference)<input className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.documentRef} onChange={set("documentRef")} /></label>
          <label className="grid gap-1 text-sm">Back (Records reference)<input className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.backDocumentRef} onChange={set("backDocumentRef")} /></label>
          <label className="grid gap-1 text-sm">Restrictions (comma separated)<input className="min-h-12 rounded-xl border border-border bg-background px-3" value={form.restrictions} onChange={set("restrictions")} placeholder="e.g. PROVINCIAL_RESTRICTION" /></label>
        </div>
        <button type="button" data-testid="upload" className={`${primary} mt-4 w-full md:w-auto`} disabled={!form.code || !form.documentRef || props.uploading} onClick={() => props.onUpload(form)}>Add as unverified</button>
      </section>

      <section className={card} aria-labelledby="wallet-studied">
        <h2 id="wallet-studied" className="text-lg font-semibold">Studied · demonstrated</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {w.studied.map(s => <li key={s.ref}><span className="font-medium">{s.title}</span> — {s.status.replaceAll("_", " ")}{s.note ? <span className="block text-xs text-muted-foreground">{s.note}</span> : null}</li>)}
          {w.demonstrated.map(p => <li key={p.evaluationRef}><span className="font-medium">{p.competencyCode}</span> — practical {p.status.replaceAll("_", " ")} ({fmt(p.observedAt)})</li>)}
          {!w.studied.length && !w.demonstrated.length && <li className="text-muted-foreground">Nothing yet.</li>}
        </ul>
      </section>

      {!!history.length && (
        <details className={card}>
          <summary className="min-h-12 cursor-pointer py-3 font-semibold">History ({history.length})</summary>
          <ul className="mt-2 space-y-2 text-sm">{history.map(c => <li key={c.holdingRef}>{c.displayName} — {c.verificationState}{c.supersededByHoldingRef ? " (replaced by renewal)" : ""} · expired/expires {fmt(c.expiresAt)}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Study Centre: practice with immediate feedback                       */
/* ------------------------------------------------------------------ */

export type StudyCourse = {
  courseCode: string; title: string; jurisdiction: string; track: string; boundaryNotice: string; currentVersion: { ref: string; number: number } | null;
  moduleCount: number; bankSize: number; mockQuestionCount: number | null;
  enrolment: { assignmentRef: string; status: string; onCurrentVersion: boolean; resumeModule: string | null } | null;
  sources: { sourceRef: string; title: string; edition: string | null; url: string | null; reviewStatus: string }[];
};
export type PracticeQuestion = { questionCode: string; domain: string; prompt: string; options: string[]; sourceSection: string | null };
export type PracticeFeedback = { correct: boolean; correctPresentedIndex: number; explanation: string | null; source: { title: string | null; section: string | null; edition: string | null; url: string | null; reviewStatus: string | null }; studyThisTopic: { code: string; title: string } | null };
export type PracticeResult = { kind: string; scorePercent: number; reachedPracticeBar: boolean; weakAreas: { domain: string; scorePercent: number }[]; missed: { questionCode: string; domain: string; explanation: string | null; sourceSection: string | null }[]; notice: string };

export function StudyCentrePanel(props: {
  courses: StudyCourse[];
  onEnroll: (courseCode: string) => void;
  onOpen: (assignmentRef: string, kind: "PRACTICE" | "MOCK_EXAM") => void;
  onOpenLessons: (assignmentRef: string) => void;
  attempt: { attemptRef: string; kind: "PRACTICE" | "MOCK_EXAM"; notice: string; questions: PracticeQuestion[] } | null;
  feedback: Record<string, PracticeFeedback>;
  onAnswer: (questionCode: string, presentedIndex: number) => void;
  answers: Record<string, number>;
  onSubmit: () => void;
  result: PracticeResult | null;
  onBookmark: (questionCode: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { setIndex(0); }, [props.attempt?.attemptRef]);
  const q = props.attempt?.questions[index];
  const fb = q ? props.feedback[q.questionCode] : undefined;
  return (
    <div className="space-y-5" ref={top}>
      {!props.attempt && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="study-courses">
          {props.courses.map(c => (
            <section key={c.courseCode} className={card} aria-labelledby={`c-${c.courseCode}`}>
              <h2 id={`c-${c.courseCode}`} className="text-lg font-semibold">{c.title}</h2>
              <p className="text-xs text-muted-foreground">{c.jurisdiction} · {c.currentVersion ? `v${c.currentVersion.number}` : "not installed yet"} · {c.moduleCount} lessons · {c.bankSize} practice questions</p>
              <div className="mt-3"><BoundaryNotice>{c.boundaryNotice}</BoundaryNotice></div>
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground" aria-label="Sources">
                {c.sources.map(s => <li key={s.sourceRef}>Source: {s.url ? <a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}{s.edition ? ` (${s.edition})` : ""} — {s.reviewStatus === "reviewed" ? "reviewed" : "not yet reviewed by your company"}</li>)}
              </ul>
              <div className="mt-4 grid gap-2">
                {!c.enrolment && <button type="button" className={primary} onClick={() => props.onEnroll(c.courseCode)}>Start studying</button>}
                {c.enrolment && <>
                  <button type="button" className={primary} onClick={() => props.onOpenLessons(c.enrolment!.assignmentRef)}>{c.enrolment.resumeModule ? `Resume at ${c.enrolment.resumeModule}` : "Open lessons"}</button>
                  <button type="button" className={secondary} onClick={() => props.onOpen(c.enrolment!.assignmentRef, "PRACTICE")}>Practice (instant answers)</button>
                  {c.mockQuestionCount && <button type="button" className={secondary} onClick={() => props.onOpen(c.enrolment!.assignmentRef, "MOCK_EXAM")}>Mock exam ({c.mockQuestionCount} questions)</button>}
                  {!c.enrolment.onCurrentVersion && <p className="text-xs text-muted-foreground">A newer version of this course exists; your earlier attempts stay on the version you took.</p>}
                </>}
              </div>
            </section>
          ))}
        </div>
      )}

      {props.attempt && !props.result && q && (
        <section className={card} aria-live="polite" data-testid="practice">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.attempt.kind === "PRACTICE" ? "Practice" : "Mock exam"} · question {index + 1} of {props.attempt.questions.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">{props.attempt.notice}</p>
          <h2 className="mt-3 text-lg font-semibold leading-7">{q.prompt}</h2>
          {q.sourceSection && <p className="mt-1 text-xs text-muted-foreground">From: {q.sourceSection}</p>}
          <div className="mt-2"><ReadAloudButton text={`${q.prompt}. ${q.options.map((o, i) => `Option ${i + 1}: ${o}`).join(". ")}`} /></div>
          <div className="mt-4 grid gap-2" role="radiogroup" aria-label="Answers">
            {q.options.map((o, i) => {
              const chosen = props.answers[q.questionCode] === i;
              const right = fb && fb.correctPresentedIndex === i;
              const wrong = fb && chosen && !fb.correct;
              return <button key={i} type="button" role="radio" aria-checked={chosen} disabled={props.attempt!.kind === "PRACTICE" && !!fb} onClick={() => props.onAnswer(q.questionCode, i)}
                className={`${btn} text-left ${right ? "border-2 border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40" : wrong ? "border-2 border-red-600 bg-red-50 dark:bg-red-950/40" : chosen ? "border-2 border-primary bg-muted" : "border border-border bg-background"}`}>{o}</button>;
            })}
          </div>
          {fb && (
            <div className="mt-4 rounded-xl border border-border bg-muted p-3 text-sm leading-6" data-testid="feedback">
              <p className="font-semibold">{fb.correct ? "Correct." : "Not quite."}</p>
              {fb.explanation && <p>{fb.explanation}</p>}
              <p className="mt-1 text-xs text-muted-foreground">Source: {fb.source.url ? <a className="underline" href={fb.source.url} target="_blank" rel="noreferrer">{fb.source.title ?? "official source"}</a> : fb.source.title ?? "—"}{fb.source.edition ? ` (${fb.source.edition})` : ""}{fb.source.section ? ` · ${fb.source.section}` : ""}{fb.source.reviewStatus !== "reviewed" ? " · not yet reviewed by your company" : ""}</p>
              {fb.studyThisTopic && <p className="mt-1 text-xs">Study this topic: {fb.studyThisTopic.code} — {fb.studyThisTopic.title}</p>}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={secondary} disabled={index === 0} onClick={() => setIndex(i => i - 1)}>Back</button>
            <button type="button" className={secondary} onClick={() => props.onBookmark(q.questionCode)}>Bookmark</button>
            {index < props.attempt.questions.length - 1
              ? <button type="button" className={primary} onClick={() => setIndex(i => i + 1)}>Next</button>
              : <button type="button" className={primary} data-testid="finish" onClick={props.onSubmit}>Finish & score</button>}
          </div>
        </section>
      )}

      {props.result && (
        <section className={card} data-testid="practice-result">
          <h2 className="text-lg font-semibold">{props.result.kind === "MOCK_EXAM" ? "Mock exam" : "Practice"} score: {props.result.scorePercent}%</h2>
          <p className={muted}>{props.result.notice}</p>
          {!!props.result.weakAreas.length && <><h3 className="mt-3 font-semibold">Weak areas</h3><ul className="text-sm">{props.result.weakAreas.map(w => <li key={w.domain}>{w.domain.replaceAll("_", " ")} — {w.scorePercent}%</li>)}</ul></>}
          {!!props.result.missed.length && <><h3 className="mt-3 font-semibold">Review what you missed</h3><ul className="space-y-2 text-sm">{props.result.missed.map(m => <li key={m.questionCode}><span className="font-medium">{m.domain.replaceAll("_", " ")}</span>: {m.explanation}{m.sourceSection ? <span className="block text-xs text-muted-foreground">{m.sourceSection}</span> : null}</li>)}</ul></>}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tutor                                                                */
/* ------------------------------------------------------------------ */

export type TutorResult = { status: "GROUNDED" | "UNKNOWN_REFER_TO_AUTHORITY" | "REFUSED"; lines: string[]; citations: { sourceRef: string; title: string; edition: string | null; section: string | null; url: string | null }[]; referTo: { sourceRef: string; title: string; url: string | null }[]; practice: { code: string; prompt: string }[]; notice: string };
export function TutorPanel(props: { onAsk: (mode: "explain" | "quiz" | "more_examples", question: string) => void; asking: boolean; answer: TutorResult | null }) {
  const [q, setQ] = useState("");
  const a = props.answer;
  return (
    <section className={card} aria-labelledby="tutor">
      <h2 id="tutor" className="text-lg font-semibold">Explain this section</h2>
      <p className={muted}>Answers come only from approved training sources for this course version. If they do not support an answer, you will be told to check the official source.</p>
      <label className="mt-3 grid gap-1 text-sm">Your question<textarea className="min-h-24 rounded-xl border border-border bg-background p-3" value={q} onChange={e => setQ(e.target.value)} /></label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={q.trim().length < 2 || props.asking} onClick={() => props.onAsk("explain", q)}>Explain</button>
        <button type="button" className={secondary} disabled={q.trim().length < 2 || props.asking} onClick={() => props.onAsk("quiz", q)}>Quiz me</button>
        <button type="button" className={secondary} disabled={q.trim().length < 2 || props.asking} onClick={() => props.onAsk("more_examples", q)}>More practice</button>
      </div>
      {a && (
        <div className="mt-4 space-y-2 text-sm leading-6" data-testid="tutor-answer">
          <Pill tone={a.status === "GROUNDED" ? "held" : a.status === "REFUSED" ? "expired" : "unverified"}>{a.status === "GROUNDED" ? "From approved source" : a.status === "REFUSED" ? "Not something study can do" : "UNKNOWN — refer to authority"}</Pill>
          {a.lines.map((l, i) => <p key={i}>{l}</p>)}
          {a.practice.map(p => <p key={p.code} className="rounded-lg bg-muted p-2">{p.prompt}</p>)}
          {a.citations.map(c => <p key={`${c.sourceRef}${c.section}`} className="text-xs text-muted-foreground">Source: {c.url ? <a className="underline" href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : c.title}{c.edition ? ` (${c.edition})` : ""}{c.section ? ` · ${c.section}` : ""}</p>)}
          {a.referTo.map(r => <p key={r.sourceRef} className="text-xs text-muted-foreground">Check: {r.url ? <a className="underline" href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</p>)}
          <p className="text-xs text-muted-foreground">{a.notice}</p>
          {a.lines.length > 0 && <ReadAloudButton text={a.lines.join(" ")} />}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Library and pathway                                                  */
/* ------------------------------------------------------------------ */

export type LibrarySource = { sourceRef: string; authority: string; title: string; jurisdiction: string; edition: string | null; url: string | null; kind: string; licenceStatus: string; reviewStatus: string; authoritative: boolean; offline: { permitted: boolean } };
export function LibraryPanel({ sources }: { sources: LibrarySource[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="library">
      {sources.map(s => (
        <section key={s.sourceRef} className={card}>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{s.kind.replaceAll("_", " ")} · {s.jurisdiction}</p>
          <h2 className="mt-1 font-semibold">{s.title}</h2>
          <p className="text-sm">{s.authority}{s.edition ? ` · ${s.edition}` : ""}</p>
          <p className="mt-1 text-xs text-muted-foreground">{s.authoritative ? "Reviewed by your company" : "Not yet reviewed — study reference only"} · {s.offline.permitted ? "Offline copy approved" : "Opens the official source (no offline copy)"}</p>
          {s.url && !s.url.startsWith("internal://") && <a className={`${secondary} mt-3 inline-flex items-center`} href={s.url} target="_blank" rel="noreferrer">Open official source</a>}
        </section>
      ))}
    </div>
  );
}

export type PathwayView = { code: string; title: string; disclaimer: string; steps: { code: string; title: string; state: string; detail: string }[] };
export function PathwayPanel({ pathways }: { pathways: PathwayView[] }) {
  const label: Record<string, string> = { complete: "Done", in_progress: "In progress", not_started: "Not started", UNKNOWN_VERIFY_WITH_AUTHORITY: "UNKNOWN — verify with authority" };
  return (
    <div className="space-y-4" data-testid="pathway">
      {pathways.map(p => (
        <section key={p.code} className={card}>
          <h2 className="text-lg font-semibold">{p.title}</h2>
          <p className={muted}>{p.disclaimer}</p>
          <ol className="mt-3 space-y-2">
            {p.steps.map((s, i) => (
              <li key={s.code} className="flex gap-3 rounded-xl border border-border p-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">{i + 1}</span>
                <div><p className="font-medium">{s.title}</p><p className="text-xs text-muted-foreground"><Pill tone={s.state === "complete" ? "held" : s.state.startsWith("UNKNOWN") ? "unverified" : "unknown"}>{label[s.state] ?? s.state}</Pill> {s.detail}</p></div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Compliance dashboard and queue                                       */
/* ------------------------------------------------------------------ */

export type QueueItem = { handoffRef: string; status: string; employee: { userId: number; name: string | null }; credential: { code: string; displayName: string }; currentExpiry: Date | string | null; reason: string | null; latestVerified: { holdingRef: string; expiresAt: Date | string | null } | null; requiredBy: Date | string | null; dispatchImpact: string | null; requestedAt: Date | string; providerOptions: { official: { sourceRef: string; title: string; sourceUrl: string | null }[]; company: { vendorRef: string; name: string; phone: string | null; preferred: boolean }[] } };
export type Dashboard = { headlines: string[]; people: number; views: Record<string, unknown[] | null | unknown> };
const VIEW_LABELS: [string, string][] = [
  ["expiringSoon", "Expiring soon"], ["expired", "Expired"], ["missingRequired", "Missing required"], ["uploadedVerificationRequired", "Uploaded — verification required"],
  ["renewalRequested", "Renewal requested"], ["bookingRequired", "Booking required"], ["booked", "Booked"], ["awaitingCertificate", "Awaiting certificate"],
  ["qualificationUnknown", "Qualification unknown"], ["companyTrainingOverdue", "Company training overdue"], ["practicalPending", "Practical sign-off pending"],
  ["onboarding", "New employee onboarding"], ["studiedNotHeld", "Studied, not held"],
];
export function CompliancePanel(props: { dashboard: Dashboard | null; queue: QueueItem[]; onMark: (handoffRef: string, mark: "contacted" | "booked" | "awaiting_completion" | "awaiting_certificate") => void; onSweep: () => void; sweeping: boolean; sweepResult: { sent: number; suppressed: number } | null }) {
  const dash = props.dashboard;
  return (
    <div className="space-y-5" data-testid="compliance">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Training compliance</h2>
          <button type="button" className={secondary} disabled={props.sweeping} onClick={props.onSweep}>Send due renewal reminders</button>
        </div>
        {props.sweepResult && <p className="mt-2 text-sm">Sent {props.sweepResult.sent}; already sent (suppressed) {props.sweepResult.suppressed}.</p>}
        <ul className="mt-3 space-y-1 text-sm" data-testid="headlines">{(dash?.headlines ?? []).map((h, i) => <li key={i}>• {h}</li>)}</ul>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          {VIEW_LABELS.map(([k, label]) => { const v = dash?.views[k]; const n = Array.isArray(v) ? v.length : 0; return <div key={k} className="rounded-xl border border-border p-3"><p className="text-2xl font-semibold">{n}</p><p className="text-xs text-muted-foreground">{label}</p></div>; })}
        </div>
      </section>
      <section className={card} aria-labelledby="queue">
        <h2 id="queue" className="text-lg font-semibold">Training requests</h2>
        <p className={muted}>Status changes here never change dispatch readiness. Only a verified certificate does.</p>
        <ul className="mt-3 space-y-3" data-testid="queue">
          {props.queue.map(q => (
            <li key={q.handoffRef} className="rounded-xl border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{q.employee.name ?? `Employee ${q.employee.userId}`} — {q.credential.displayName}</p><Pill tone="unknown">{q.status.replaceAll("_", " ").toLowerCase()}</Pill></div>
              <p className="mt-1 text-xs text-muted-foreground">Current expiry {fmt(q.currentExpiry)} · Required by {fmt(q.requiredBy)} · Requested {fmt(q.requestedAt)} · Latest verified {q.latestVerified ? fmt(q.latestVerified.expiresAt) : "none"}</p>
              {q.reason && <p className="mt-1">Reason: {q.reason}</p>}
              {q.dispatchImpact && <p className="mt-1">Dispatch impact: {q.dispatchImpact}</p>}
              <p className="mt-1 text-xs">Official directory: {q.providerOptions.official.map(o => o.sourceUrl ? <a key={o.sourceRef} className="mr-2 underline" href={o.sourceUrl} target="_blank" rel="noreferrer">{o.title}</a> : <span key={o.sourceRef}>{o.title}</span>)}</p>
              {!!q.providerOptions.company.length && <p className="mt-1 text-xs">Company providers: {q.providerOptions.company.map(c => `${c.name}${c.preferred ? " (preferred)" : ""}${c.phone ? ` ${c.phone}` : ""}`).join(" · ")}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={secondary} onClick={() => props.onMark(q.handoffRef, "contacted")}>Contacted</button>
                <button type="button" className={secondary} onClick={() => props.onMark(q.handoffRef, "booked")}>Booked</button>
                <button type="button" className={secondary} onClick={() => props.onMark(q.handoffRef, "awaiting_certificate")}>Awaiting certificate</button>
              </div>
            </li>
          ))}
          {!props.queue.length && <li className={muted}>No open requests.</li>}
        </ul>
      </section>
    </div>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Award,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  GraduationCap,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RenewalQueuePanel, SourceReviewPanel, SystemExceptionsPanel, VerificationQueuePanel } from "./ComplianceOperationsView";
import { CompliancePanel, LibraryPanel, PathwayPanel, StudyCentrePanel, TutorPanel, WalletPanel, type PracticeFeedback, type PracticeResult, type TutorResult, type UploadForm } from "./TrainingWalletView";

function BoundaryBadge({ value }: { value: string }) {
  const label = value === "employer_certificate" ? "Employer certificate" : value === "company_certificate" ? "Company certificate" : value === "external_track_only" ? "External · track only" : "Knowledge only";
  return <Badge variant={value === "external_track_only" ? "outline" : "secondary"}>{label}</Badge>;
}

function statusText(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());
}

export default function TrainingAcademy() {
  const utils = trpc.useUtils();
  const catalog = trpc.academy.catalog.useQuery();
  const my = trpc.academy.myTraining.useQuery();
  const tickets = trpc.academy.ticketPortfolio.useQuery();
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const detail = trpc.academy.assignmentDetail.useQuery(
    { assignmentRef: selectedRef ?? "" },
    { enabled: !!selectedRef },
  );
  const [attempt, setAttempt] = useState<null | { attemptRef: string; attemptNumber: number; questions: { questionCode: string; domain: string; critical: boolean; prompt: string; options: string[] }[] }>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<null | { passed: boolean; scorePercent: number; domainFailures: string[]; criticalFailures: string[]; nextStatus: string }>(null);

  useEffect(() => {
    if (!selectedRef && my.data?.assignments[0]?.assignmentRef) setSelectedRef(my.data.assignments[0].assignmentRef);
  }, [my.data, selectedRef]);
  useEffect(() => { setAttempt(null); setAnswers({}); setResult(null); }, [selectedRef]);

  const complete = trpc.academy.moduleComplete.useMutation({
    onSuccess: async data => {
      toast.success(data.assessmentReady ? "Module complete · final assessment unlocked." : "Module complete.");
      await Promise.all([detail.refetch(), my.refetch()]);
    },
    onError: e => toast.error(e.message),
  });
  const openAssessment = trpc.academy.assessmentOpen.useMutation({
    onSuccess: data => { setAttempt(data); setAnswers({}); setResult(null); },
    onError: e => toast.error(e.message),
  });
  const submitAssessment = trpc.academy.assessmentSubmit.useMutation({
    onSuccess: async data => {
      setResult(data);
      if (data.passed) toast.success(`Passed · ${data.scorePercent}%`); else toast.error(`Assessment not passed · ${data.scorePercent}%`);
      await Promise.all([detail.refetch(), my.refetch(), tickets.refetch()]);
    },
    onError: e => toast.error(e.message),
  });
  const signCertificate = trpc.academy.certificateSignOwn.useMutation({
    onSuccess: async data => {
      toast.success(data.alreadyFinal ? "Certificate is already active." : "Employee signature captured · certificate activated.");
      await Promise.all([tickets.refetch(), my.refetch()]);
    },
    onError: e => toast.error(e.message),
  });

  /* ---- 0172: wallet, Study Centre, library, pathway, compliance ---- */
  const wallet = trpc.trainingWallet.myWallet.useQuery();
  const policies = trpc.trainingWallet.policies.useQuery();
  const study = trpc.academy.studyCentre.useQuery();
  const library = trpc.academy.studyLibrary.useQuery();
  const pathway = trpc.trainingWallet.pathway.useQuery();
  const dashboard = trpc.trainingWallet.complianceDashboard.useQuery(undefined, { retry: false });
  const queue = trpc.trainingWallet.handoffQueue.useQuery(undefined, { retry: false, enabled: dashboard.isSuccess });
  // 0174 — Compliance Operations queues. Each query is permission-gated server-side; a 403 just hides its panel.
  const ops = { enabled: dashboard.isSuccess, retry: false } as const;
  const renewalQueue = trpc.trainingWallet.renewalQueue.useQuery(undefined, ops);
  const verificationQueue = trpc.trainingWallet.verificationQueue.useQuery(undefined, ops);
  const sourceQueue = trpc.academy.sourceReviewQueue.useQuery(undefined, ops);
  const sweepRuns = trpc.trainingWallet.sweepRuns.useQuery(undefined, ops);
  const systemExceptions = trpc.surfaces.exceptions.useQuery({ category: "workforce" }, ops);
  const refreshOps = async () => { await Promise.all([verificationQueue.refetch(), renewalQueue.refetch(), dashboard.refetch(), queue.refetch()]); };
  const verify = trpc.trainingWallet.verify.useMutation({ onSuccess: async () => { toast.success("Verified. It now counts through the canonical rule."); await refreshOps(); }, onError: e => toast.error(e.message) });
  const reject = trpc.trainingWallet.reject.useMutation({ onSuccess: async () => { toast.success("Rejected."); await refreshOps(); }, onError: e => toast.error(e.message) });
  const requestCorrection = trpc.trainingWallet.requestCorrection.useMutation({ onSuccess: async () => { toast.success("Correction requested — the employee has been told."); await refreshOps(); }, onError: e => toast.error(e.message) });
  const submitCorrection = trpc.trainingWallet.submitCorrection.useMutation({ onSuccess: async r => { toast.success(r.notice); await wallet.refetch(); }, onError: e => toast.error(e.message) });
  const sourceAct = trpc.academy.sourceAct.useMutation({ onSuccess: async r => { toast.success(`Source is now ${r.reviewStatus.replaceAll("_", " ")}.`); await sourceQueue.refetch(); }, onError: e => toast.error(e.message) });
  const [practice, setPractice] = useState<null | { assignmentRef: string; attemptRef: string; kind: "PRACTICE" | "MOCK_EXAM"; notice: string; questions: { questionCode: string; domain: string; prompt: string; options: string[]; sourceSection: string | null }[] }>(null);
  const [practiceAnswers, setPracticeAnswers] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<Record<string, PracticeFeedback>>({});
  const [practiceResult, setPracticeResult] = useState<PracticeResult | null>(null);
  const [tutorAnswer, setTutorAnswer] = useState<TutorResult | null>(null);
  const [sweepResult, setSweepResult] = useState<{ sent: number; suppressed: number } | null>(null);
  const [tab, setTab] = useState("mine");
  const requestTraining = trpc.trainingWallet.requestTraining.useMutation({ onSuccess: async r => { toast.success(r.reused ? "You already have an open request — see its status below." : "Request sent to the office."); await wallet.refetch(); }, onError: e => toast.error(e.message) });
  const recordOwn = trpc.trainingWallet.recordOwn.useMutation({ onSuccess: async r => { toast.success(r.notice); await wallet.refetch(); }, onError: e => toast.error(e.message) });
  const handoffSelf = trpc.trainingWallet.handoffSelfUpdate.useMutation({ onSuccess: async () => { toast.success("Thanks — upload your certificate when you have it."); await wallet.refetch(); }, onError: e => toast.error(e.message) });
  const enroll = trpc.academy.studyEnroll.useMutation({ onSuccess: async r => { toast.success("Enrolled. Preparation only."); await Promise.all([study.refetch(), my.refetch()]); setSelectedRef(r.assignmentRef); }, onError: e => toast.error(e.message) });
  const practiceOpen = trpc.academy.practiceOpen.useMutation({ onError: e => toast.error(e.message) });
  const practiceAnswer = trpc.academy.practiceAnswer.useMutation({ onError: e => toast.error(e.message) });
  const practiceSubmit = trpc.academy.practiceSubmit.useMutation({ onSuccess: data => setPracticeResult(data), onError: e => toast.error(e.message) });
  const bookmark = trpc.academy.bookmarkToggle.useMutation({ onSuccess: r => toast.success(r.bookmarked ? "Bookmarked." : "Bookmark removed."), onError: e => toast.error(e.message) });
  const tutor = trpc.academy.tutor.useMutation({ onSuccess: data => setTutorAnswer(data), onError: e => toast.error(e.message) });
  const handoffUpdate = trpc.trainingWallet.handoffUpdate.useMutation({ onSuccess: async () => { toast.success("Updated. Dispatch readiness is unchanged until a certificate is verified."); await Promise.all([queue.refetch(), dashboard.refetch()]); }, onError: e => toast.error(e.message) });
  const sweep = trpc.trainingWallet.renewalSweep.useMutation({ onSuccess: r => setSweepResult(r), onError: e => toast.error(e.message) });
  const resume = trpc.academy.moduleResume.useMutation();
  const onUpload = (f: UploadForm) => {
    const record = {
      code: f.code, boundary: f.boundary as never, issuer: f.issuer || undefined, certificateNumber: f.certificateNumber || undefined,
      issuedAt: f.issuedAt ? new Date(f.issuedAt) : null, expiresAt: f.expiresAt ? new Date(f.expiresAt) : null,
      documentRef: f.documentRef || undefined, backDocumentRef: f.backDocumentRef || undefined,
      restrictions: f.restrictions ? f.restrictions.split(",").map(x => x.trim()).filter(Boolean) : undefined,
    };
    // 0174: a correction is a new record naming the one it corrects; the earlier upload is not edited.
    if (f.correctsHoldingRef) submitCorrection.mutate({ ...record, correctsHoldingRef: f.correctsHoldingRef });
    else recordOwn.mutate(record);
  };
  const openPractice = async (assignmentRef: string, kind: "PRACTICE" | "MOCK_EXAM") => {
    const data = await practiceOpen.mutateAsync({ assignmentRef, kind });
    setPractice({ ...data, assignmentRef }); setPracticeAnswers({}); setFeedback({}); setPracticeResult(null);
  };

  const selected = detail.data;
  const progress = useMemo(() => {
    if (!selected?.modules.length) return 0;
    return Math.round(selected.modules.filter(m => m.status === "completed" && !m.stale).length / selected.modules.length * 100);
  }, [selected]);

  return (
    <div className="min-h-full bg-[#f6f8fb] p-4 text-[#172033] md:p-7">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="overflow-hidden rounded-[28px] border border-[#dfe5ee] bg-[#10243f] p-6 text-white shadow-[0_20px_60px_rgba(31,52,85,.12)] md:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#9fb0c7]"><GraduationCap className="h-4 w-4" /> LeaseOS · v22.22</div>
              <h1 className="text-3xl font-semibold tracking-[-0.04em] md:text-4xl">Training Academy</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-[#c1cddd]">Version-controlled learning, assessments, practical competency and credential tracking. Online learning never manufactures an external licence, endorsement or third-party certificate.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric value={catalog.data?.counts.courses ?? "—"} label="courses" />
              <Metric value={catalog.data?.counts.totalQuestions ?? "—"} label="questions" />
              <Metric value={my.data?.assignments.length ?? "—"} label="assigned" />
            </div>
          </div>
        </header>

        <Tabs value={tab} onValueChange={setTab} className="space-y-5">
          <TabsList className="flex h-auto min-h-12 flex-wrap gap-1 rounded-xl bg-white p-1 shadow-sm">
            <TabsTrigger value="mine" className="min-h-10 rounded-lg">My Training</TabsTrigger>
            <TabsTrigger value="wallet" className="min-h-10 rounded-lg">My Wallet</TabsTrigger>
            <TabsTrigger value="study" className="min-h-10 rounded-lg">Driver Study Centre</TabsTrigger>
            <TabsTrigger value="library" className="min-h-10 rounded-lg">Study Library</TabsTrigger>
            <TabsTrigger value="pathway" className="min-h-10 rounded-lg">Career Path</TabsTrigger>
            <TabsTrigger value="catalog" className="min-h-10 rounded-lg">Course Catalog</TabsTrigger>
            <TabsTrigger value="tickets" className="min-h-10 rounded-lg">Tickets & Qualifications</TabsTrigger>
            {dashboard.isSuccess && <TabsTrigger value="compliance" className="min-h-10 rounded-lg">Training Compliance</TabsTrigger>}
          </TabsList>

          <TabsContent value="wallet">
            <WalletPanel wallet={wallet.data ?? null} policies={policies.data?.policies ?? []} onRequestTraining={code => requestTraining.mutate({ qualificationCode: code })} requesting={requestTraining.isPending} onUpload={onUpload} uploading={recordOwn.isPending} onHandoffDone={ref => handoffSelf.mutate({ handoffRef: ref, to: "TRAINING_COMPLETED" })} />
          </TabsContent>

          <TabsContent value="study" className="space-y-5">
            <StudyCentrePanel
              courses={study.data ?? []}
              onEnroll={code => enroll.mutate({ courseCode: code })}
              onOpenLessons={ref => { setSelectedRef(ref); setTab("mine"); }}
              onOpen={(ref, kind) => { void openPractice(ref, kind).catch(() => undefined); }}
              attempt={practice}
              feedback={feedback}
              answers={practiceAnswers}
              onAnswer={(code, idx) => {
                setPracticeAnswers(a => ({ ...a, [code]: idx }));
                if (practice?.kind === "PRACTICE") void practiceAnswer.mutateAsync({ attemptRef: practice.attemptRef, questionCode: code, presentedIndex: idx }).then(fb => setFeedback(f => ({ ...f, [code]: fb }))).catch(() => undefined);
              }}
              onSubmit={() => practice && practiceSubmit.mutate({ attemptRef: practice.attemptRef, answers: practiceAnswers })}
              result={practiceResult}
              onBookmark={code => practice && bookmark.mutate({ assignmentRef: practice.assignmentRef, questionCode: code })}
            />
            {(practice || practiceResult) && <Button variant="outline" className="min-h-12 rounded-xl" onClick={() => { setPractice(null); setPracticeResult(null); }}>Back to courses</Button>}
          </TabsContent>

          <TabsContent value="library"><LibraryPanel sources={library.data ?? []} /></TabsContent>
          <TabsContent value="pathway"><PathwayPanel pathways={pathway.data ?? []} /></TabsContent>
          {dashboard.isSuccess && <TabsContent value="compliance">
            <div className="space-y-5">
              <CompliancePanel dashboard={dashboard.data ?? null} queue={queue.data ?? []} onMark={(ref, mark) => handoffUpdate.mutate({ handoffRef: ref, mark })} onSweep={() => sweep.mutate()} sweeping={sweep.isPending} sweepResult={sweepResult} />
              {renewalQueue.data && <RenewalQueuePanel rows={renewalQueue.data.rows} notice={renewalQueue.data.notice} />}
              {verificationQueue.data && <VerificationQueuePanel items={verificationQueue.data} busy={verify.isPending || reject.isPending || requestCorrection.isPending}
                onVerify={v => verify.mutate(v)} onReject={(holdingRef, reason) => reject.mutate({ holdingRef, reason })} onRequestCorrection={(holdingRef, note) => requestCorrection.mutate({ holdingRef, note })} />}
              {sourceQueue.data && <SourceReviewPanel sources={sourceQueue.data} busy={sourceAct.isPending} onAct={(sourceRef, action, note, successorRef) => sourceAct.mutate({ sourceRef, action, note, successorRef })} />}
              {sweepRuns.data && <SystemExceptionsPanel runs={sweepRuns.data.runs} notice={sweepRuns.data.notice}
                exceptions={(systemExceptions.data?.items ?? []).filter(x => x.key.startsWith("sweep-failure:")).map(x => ({ key: x.key, title: x.title, reason: x.reason }))} />}
            </div>
          </TabsContent>}

          <TabsContent value="mine" className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
              <Card className="h-fit rounded-2xl border-[#dfe5ee]">
                <CardHeader><CardTitle className="text-base">Assigned training</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {my.isLoading && <Quiet>Loading assignments…</Quiet>}
                  {!my.isLoading && !my.data?.assignments.length && <Quiet>No Academy assignments are currently assigned to your account.</Quiet>}
                  {my.data?.assignments.map(a => (
                    <button key={a.assignmentRef} onClick={() => setSelectedRef(a.assignmentRef)} className={`w-full rounded-xl border p-4 text-left transition ${selectedRef === a.assignmentRef ? "border-[#ff6b42] bg-[#fff5f0]" : "border-[#e4e9f0] bg-white hover:border-[#bdc8d6]"}`}>
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 rounded-lg bg-[#edf2f8] p-2"><BookOpenCheck className="h-4 w-4" /></div>
                        <div className="min-w-0 flex-1"><p className="font-semibold leading-5">{a.course.title}</p><p className="mt-1 text-xs text-[#6e7f96]">{statusText(a.status)} · v{a.version.number}</p></div>
                        <ChevronRight className="h-4 w-4 text-[#8fa0b5]" />
                      </div>
                      {!!a.missingModules.length && <p className="mt-3 text-xs text-[#6e7f96]">{a.missingModules.length} required module{a.missingModules.length === 1 ? "" : "s"} remaining</p>}
                    </button>
                  ))}
                </CardContent>
              </Card>

              <div className="space-y-5">
                {!selectedRef && <Card className="rounded-2xl border-[#dfe5ee]"><CardContent className="p-8"><Quiet>Select an assignment to begin.</Quiet></CardContent></Card>}
                {detail.isLoading && selectedRef && <Card className="rounded-2xl border-[#dfe5ee]"><CardContent className="p-8"><Quiet>Opening current course version…</Quiet></CardContent></Card>}
                {selected && (
                  <>
                    <Card className="rounded-2xl border-[#dfe5ee]">
                      <CardContent className="p-6">
                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                          <div><div className="flex flex-wrap gap-2"><BoundaryBadge value={selected.course.credentialBoundary} />{selected.course.requiresPractical && <Badge variant="outline">Practical sign-off required</Badge>}</div><h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">{selected.course.title}</h2><p className="mt-1 text-sm text-[#6e7f96]">{selected.course.code} · version {selected.version.number} · {statusText(selected.assignment.status)}</p></div>
                          <div className="w-full md:w-56"><div className="mb-2 flex justify-between text-xs font-medium"><span>Modules</span><span>{progress}%</span></div><Progress value={progress} /></div>
                        </div>
                        {selected.course.credentialBoundary === "external_track_only" && <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><div className="flex gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><p>This learning track can prepare and document company competency, but LeaseOS cannot issue the external credential. The actual credential must be independently verified.</p></div></div>}
                      </CardContent>
                    </Card>

                    <div className="space-y-3">
                      {selected.modules.map((m, index) => {
                        const done = m.status === "completed" && !m.stale;
                        return <Card key={m.moduleCode} className={`rounded-2xl ${done ? "border-emerald-200" : m.stale ? "border-amber-300" : "border-[#dfe5ee]"}`}>
                          <CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${done ? "bg-emerald-100 text-emerald-800" : "bg-[#edf2f8] text-[#40546e]"}`}>{done ? <CheckCircle2 className="h-5 w-5" /> : index + 1}</div><div><CardTitle className="text-base">{m.title}</CardTitle><p className="mt-1 text-xs text-[#6e7f96]">{m.domain} · {m.estimatedMinutes ?? "—"} min · {m.moduleCode}</p></div></div><Badge variant={done ? "secondary" : "outline"}>{m.stale ? "Version changed" : done ? "Complete" : "Required"}</Badge></div></CardHeader>
                          <CardContent className="space-y-3">
                            {m.blocks.map(b => <div key={b.code} className="rounded-xl border border-[#e6ebf1] bg-[#fbfcfe] p-4"><p className="text-sm font-semibold">{b.title}</p><div className="mt-2 space-y-2 text-sm leading-6 text-[#52657d]">{b.body.map((line, i) => <p key={i}>{line}</p>)}</div></div>)}
                            {!done && <div className="flex justify-end"><Button disabled={complete.isPending} onClick={() => { resume.mutate({ assignmentRef: selected.assignment.ref, moduleCode: m.moduleCode }); complete.mutate({ assignmentRef: selected.assignment.ref, moduleCode: m.moduleCode }); }} className="min-h-12 rounded-xl bg-[#132a4a] hover:bg-[#1c3a62]">{complete.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-2 h-4 w-4" />}Complete current module</Button></div>}
                          </CardContent>
                        </Card>;
                      })}
                    </div>

                    <AssessmentPanel
                      ready={selected.assessment.ready}
                      reason={selected.assessment.reason}
                      assignmentRef={selected.assignment.ref}
                      attempt={attempt}
                      answers={answers}
                      result={result}
                      opening={openAssessment.isPending}
                      submitting={submitAssessment.isPending}
                      onOpen={() => openAssessment.mutate({ assignmentRef: selected.assignment.ref })}
                      onAnswer={(code, answer) => setAnswers(v => ({ ...v, [code]: answer }))}
                      onSubmit={() => attempt && submitAssessment.mutate({ attemptRef: attempt.attemptRef, answers })}
                    />
                    <TutorPanel asking={tutor.isPending} answer={tutorAnswer} onAsk={(mode, question) => tutor.mutate({ assignmentRef: selected.assignment.ref, mode, question })} />
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="catalog">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {catalog.data?.courses.map(c => <Card key={c.courseCode} className="rounded-2xl border-[#dfe5ee]"><CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div className="rounded-xl bg-[#edf2f8] p-2.5"><GraduationCap className="h-5 w-5" /></div><Badge variant={c.installed ? "secondary" : "outline"}>{c.installed ? "Installed" : "Catalog seed"}</Badge></div><CardTitle className="pt-3 text-lg leading-6">{c.title}</CardTitle></CardHeader><CardContent><div className="mb-4 flex flex-wrap gap-2"><BoundaryBadge value={c.credentialBoundary} />{c.requiresPractical && <Badge variant="outline">Practical</Badge>}</div><div className="grid grid-cols-2 gap-2 text-xs text-[#6e7f96]"><span>{c.moduleCount} modules</span><span>{c.questionBankSize} bank questions</span><span>{c.jurisdiction}</span><span>{c.qualificationCode ?? "No credential"}</span></div>{c.warning && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{c.warning}</p>}</CardContent></Card>)}
            </div>
          </TabsContent>

          <TabsContent value="tickets">
            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="rounded-2xl border-[#dfe5ee]"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Award className="h-5 w-5" /> LeaseOS certificates</CardTitle></CardHeader><CardContent className="space-y-3">{!tickets.data?.certificates.length && <Quiet>No LeaseOS Academy certificates have been issued.</Quiet>}{tickets.data?.certificates.map(c => <div key={c.certificateRef} className="space-y-2"><Ticket title={c.qualificationCode} refText={c.certificateRef} detail={`${c.credentialBoundary.replaceAll("_", " ")} · ${statusText(c.status)} · issued ${new Date(c.issuedAt).toLocaleDateString()}${c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleDateString()}` : ""}${c.retentionUntil ? ` · retained through ${new Date(c.retentionUntil).toLocaleDateString()}` : ""}`} active={c.status === "active" && !c.revokedAt} />{c.status === "pending_signature" && !c.revokedAt && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm font-semibold text-amber-950">Employee signature required</p><p className="mt-1 text-xs leading-5 text-amber-900">By selecting Sign & activate, you electronically acknowledge and sign the certificate issued in your name. LeaseOS binds this acknowledgement to your authenticated account, certificate payload and signature timestamp.</p><div className="mt-3 flex justify-end"><Button disabled={signCertificate.isPending} onClick={() => signCertificate.mutate({ certificateRef: c.certificateRef, method: "electronic_ack", capturedOffline: false })} className="rounded-xl bg-[#132a4a] hover:bg-[#1c3a62]">{signCertificate.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Award className="mr-2 h-4 w-4" />}Sign & activate</Button></div></div>}</div>)}</CardContent></Card>
              <Card className="rounded-2xl border-[#dfe5ee]"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-5 w-5" /> Qualification portfolio</CardTitle></CardHeader><CardContent className="space-y-3">{!tickets.data?.qualifications.length && <Quiet>No Academy qualifications are recorded.</Quiet>}{tickets.data?.qualifications.map(q => <Ticket key={q.qualificationRef} title={q.qualificationCode} refText={q.qualificationRef} detail={`${q.sourceKind.replaceAll("_", " ")} · ${statusText(q.status)}${q.expiresAt ? ` · expires ${new Date(q.expiresAt).toLocaleDateString()}` : ""}`} active={q.status === "current"} />)}</CardContent></Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function AssessmentPanel(props: {
  ready: boolean; reason: string | null; assignmentRef: string;
  attempt: null | { attemptRef: string; attemptNumber: number; questions: { questionCode: string; domain: string; critical: boolean; prompt: string; options: string[] }[] };
  answers: Record<string, number>; result: null | { passed: boolean; scorePercent: number; domainFailures: string[]; criticalFailures: string[]; nextStatus: string };
  opening: boolean; submitting: boolean; onOpen: () => void; onAnswer: (code: string, answer: number) => void; onSubmit: () => void;
}) {
  if (!props.ready && !props.attempt && !props.result) return <Card className="rounded-2xl border-[#dfe5ee]"><CardContent className="flex gap-3 p-6"><div className="rounded-xl bg-[#edf2f8] p-2.5"><LockKeyhole className="h-5 w-5" /></div><div><p className="font-semibold">Final assessment locked</p><p className="mt-1 text-sm text-[#6e7f96]">{props.reason ?? "Complete every current-version required module first."}</p></div></CardContent></Card>;
  if (props.result) return <Card className={`rounded-2xl ${props.result.passed ? "border-emerald-200" : "border-red-200"}`}><CardContent className="p-6"><div className="flex items-start gap-3">{props.result.passed ? <CheckCircle2 className="h-6 w-6 text-emerald-600" /> : <TriangleAlert className="h-6 w-6 text-red-600" />}<div><p className="text-lg font-semibold">{props.result.passed ? "Assessment passed" : "Assessment not passed"} · {props.result.scorePercent}%</p><p className="mt-1 text-sm text-[#6e7f96]">Next status: {statusText(props.result.nextStatus)}</p>{!!props.result.domainFailures.length && <p className="mt-2 text-sm text-red-700">Domain minimum not met: {props.result.domainFailures.join(", ")}</p>}{!!props.result.criticalFailures.length && <p className="mt-2 text-sm text-red-700">Critical misses: {props.result.criticalFailures.join(", ")}</p>}</div></div></CardContent></Card>;
  if (!props.attempt) return <Card className="rounded-2xl border-[#dfe5ee]"><CardContent className="flex flex-col gap-4 p-6 md:flex-row md:items-center md:justify-between"><div><p className="font-semibold">Final assessment unlocked</p><p className="mt-1 text-sm text-[#6e7f96]">The attempt snapshots the exact course version, policy, question set and presented answer order.</p></div><Button onClick={props.onOpen} disabled={props.opening} className="rounded-xl bg-[#ff6b42] hover:bg-[#ed5c35]">Open assessment</Button></CardContent></Card>;
  const unanswered = props.attempt.questions.filter(q => props.answers[q.questionCode] === undefined).length;
  return <Card className="rounded-2xl border-[#dfe5ee]"><CardHeader><CardTitle className="text-lg">Final assessment · attempt {props.attempt.attemptNumber}</CardTitle><p className="text-sm text-[#6e7f96]">{props.attempt.questions.length - unanswered}/{props.attempt.questions.length} answered</p></CardHeader><CardContent className="space-y-5">{props.attempt.questions.map((q, qi) => <div key={q.questionCode} className="rounded-xl border border-[#e3e8ef] p-4"><div className="flex gap-2"><span className="font-semibold">{qi + 1}.</span><div className="flex-1"><p className="font-medium leading-6">{q.prompt}</p><p className="mt-1 text-xs uppercase tracking-wide text-[#8393a8]">{q.domain}{q.critical ? " · critical" : ""}</p><div className="mt-3 grid gap-2">{q.options.map((option, oi) => <button key={oi} onClick={() => props.onAnswer(q.questionCode, oi)} className={`rounded-lg border px-3 py-2 text-left text-sm transition ${props.answers[q.questionCode] === oi ? "border-[#ff6b42] bg-[#fff5f0]" : "border-[#dfe5ee] hover:bg-[#f7f9fc]"}`}>{String.fromCharCode(65 + oi)}. {option}</button>)}</div></div></div></div>)}<div className="flex items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-[#6e7f96]">{unanswered ? `${unanswered} question${unanswered === 1 ? "" : "s"} unanswered` : "Ready to submit"}</p><Button disabled={unanswered > 0 || props.submitting} onClick={props.onSubmit} className="rounded-xl bg-[#132a4a] hover:bg-[#1c3a62]">Submit assessment</Button></div></CardContent></Card>;
}

function Metric({ value, label }: { value: string | number; label: string }) { return <div className="min-w-[72px] rounded-xl bg-white/10 px-3 py-2"><div className="text-xl font-semibold">{value}</div><div className="text-[10px] uppercase tracking-wider text-[#aebdd0]">{label}</div></div>; }
function Quiet({ children }: { children: ReactNode }) { return <p className="rounded-xl bg-[#f6f8fb] p-4 text-sm leading-6 text-[#6e7f96]">{children}</p>; }
function Ticket({ title, refText, detail, active }: { title: string; refText: string; detail: string; active: boolean }) { return <div className="rounded-xl border border-[#e1e7ee] p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{title}</p><p className="mt-1 break-all font-mono text-[11px] text-[#8797aa]">{refText}</p><p className="mt-2 text-xs text-[#6e7f96]">{detail}</p></div><Badge variant={active ? "secondary" : "outline"}>{active ? "Current" : "Inactive"}</Badge></div></div>; }

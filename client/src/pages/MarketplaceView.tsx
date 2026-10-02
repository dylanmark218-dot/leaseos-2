/**
 * P10.5 — the Marketplace, the view. Pure: facts in through props, actions out through callbacks.
 *
 * Six screens over the marketplace procedures and nothing else: the Job Board (postings this
 * organization may see, one opened at a time with its requirements, discussion, the bidder's own
 * verified readiness and a draft), My Bids (every revision beside the picture now), Invitations
 * (invite-only tenders this organization was asked into), Awards (what was awarded, either way),
 * Active Contracts (issued and dispatched), Completed Work (nothing yet, and it says so).
 *
 * It decides nothing. Sealed pricing arrives already withheld; a readiness picture arrives already
 * evaluated; a client reads the projection it was given. It never recomputes a verdict from the
 * rows, never shows a price the server withheld, and never calls "lowest" a winner.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";

export type MarketplaceTab = "board" | "bids" | "invitations" | "awards" | "contracts" | "completed";

export type PostingState = "draft" | "published" | "bidding" | "bidding_closed" | "awarded" | "contracted" | "dispatched" | "active" | "completed" | "closed" | "cancelled";
export type BidState = "draft" | "submitted" | "withdrawn" | "shortlisted" | "accepted" | "rejected";
export type CheckResult = "PASS" | "WARN" | "BLOCK" | "UNKNOWN";

export type Window = { open: true; closesAt: string | Date | null; remainingMs: number | null } | { open: false; reason: string };

export type PostingRow = {
  postingRef: string;
  title: string;
  workType: string;
  operatingArea: string | null;
  pickupLocation: string | null;
  destination: string | null;
  unitsRequired: number | null;
  equipmentType: string | null;
  requestedStart: string | Date | null;
  biddingClosesAt: string | Date | null;
  state: PostingState;
  visibility: "open" | "sealed";
  distribution: "public" | "invite_only";
  biddingWindow: Window;
  isClient: boolean;
  version: number;
  clientOrgRef: string;
};

export type Requirements = {
  workerQualificationCodes: string[];
  organizationDocTypes: string[];
  tdgRequired: boolean;
  insurance: { coverageType: string; minimumLimitCents: number | null; additionalInsuredRequired: boolean } | null;
  equipmentClasses: string[];
  jurisdiction: string | null;
  clientSpecific: string[];
};

export type PostingDetail = PostingRow & {
  description: string | null;
  requirements: Requirements;
  liveBidCount: number;
  openBidRange: { liveBids: number; withTotal: number; lowestCents: number | null; highestCents: number | null } | null;
  award: { awardRef: string; contractorOrgRef: string; state: string; comparableTotalCents: number | null; currency: string; rationale: string | null } | null;
  invitations: { invitationRef: string; invitedOrgRef: string; status: string }[];
};

export type Clarification = { clarificationRef: string; kind: "question" | "notice"; status: "open" | "answered" | "published"; askerOrgRef: string | null; question: string; answer: string | null; mine: boolean };

/** The bidder's own picture, in full. */
export type Readiness = {
  verdict: "submittable" | "blocked";
  checks: { check: string; result: CheckResult; blocking: boolean; detail: string }[];
  notEvaluated: { capability: string; decidedBy: string }[];
  dependencyFingerprint: string;
};

/** What the client is given about a bidder: eligibility and results, never detail. */
export type ReadinessProjection = { eligibility: "eligible" | "eligible_with_warnings" | "not_currently_eligible"; checks: { check: string; result: CheckResult }[]; blockerCount: number; warningCount: number };

export type BidDraft = { pricingType: "fixed_price" | "unit_rate" | "hourly"; amountCents: string; unitsOffered: string; unit: "LOAD" | "M3" | "TONNE" | "KM" | "DAY" | "EACH"; exclusions: string; notes: string };

export type ClientBidRow = {
  bidRef: string;
  bidderOrgRef: string;
  state: BidState;
  revisionCount: number;
  pricing: { visible: true; summary: string; comparableTotalCents: number | null } | { visible: false; reason: string };
  submissionReadiness: ReadinessProjection | null;
  currentReadiness: ReadinessProjection | null;
  readinessChangedSinceSubmission: boolean | null;
  unitsOffered: number | null;
};

export type MyBidRow = {
  bidRef: string;
  posting: { postingRef: string; title: string; state: PostingState } | null;
  state: BidState;
  version: number;
  revisions: { revisionNumber: number; submittedAt: string | Date; summary: string; comparableTotalCents: number | null; readinessVerdict: string | null }[];
  currentReadiness: Readiness | null;
  readinessChangedSinceSubmission: boolean | null;
};

export type ContractRow = { contractRef: string; postingTitle: string | null; clientOrgRef: string; contractorOrgRef: string; isClient: boolean; isContractor: boolean; state: "issued" | "dispatched" | "cancelled"; jobCode: string; chainNumber: string; dispatchPostingNumber: string | null };

export type MarketplaceViewProps = {
  tab: MarketplaceTab; onTab: (t: MarketplaceTab) => void;
  busy: boolean;
  /* board */
  postings: PostingRow[]; selectedRef: string | null; onSelect: (postingRef: string | null) => void; detail: PostingDetail | null;
  clarifications: Clarification[];
  onAsk: (postingRef: string, question: string) => void; onAnswer: (clarificationRef: string, answer: string) => void; onPublishClarification: (clarificationRef: string) => void; onNotice: (postingRef: string, notice: string) => void;
  /* client controls */
  onPublish: (postingRef: string, version: number) => void; onOpenBidding: (postingRef: string, version: number) => void; onCloseBidding: (postingRef: string, version: number) => void; onCancel: (postingRef: string, version: number, reason: string) => void;
  clientBids: ClientBidRow[]; onShortlist: (bidRef: string) => void; onAward: (postingRef: string, bidRef: string, rationale: string, version: number) => void; onIssueContract: (postingRef: string, version: number) => void;
  onNewPosting: (draft: { title: string; workType: string; operatingArea: string; unitsRequired: string; biddingClosesAt: string; visibility: "open" | "sealed"; distribution: "public" | "invite_only" }) => void;
  /* bidder controls */
  readiness: Readiness | null; myBidOnSelected: MyBidRow | null;
  onSaveDraft: (postingRef: string, draft: BidDraft) => void; onSubmit: (bidRef: string, version: number) => void; onWithdraw: (bidRef: string, version: number) => void;
  /* other tabs */
  myBids: MyBidRow[]; contracts: ContractRow[]; onDispatch: (contractRef: string) => void;
};

const money = (c: number | null, currency = "CAD") => (c == null ? "—" : (c / 100).toLocaleString(undefined, { style: "currency", currency }));
const when = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString() : "—");
const tabs: { key: MarketplaceTab; label: string }[] = [
  { key: "board", label: "Job Board" }, { key: "bids", label: "My Bids" }, { key: "invitations", label: "Invitations" },
  { key: "awards", label: "Awards" }, { key: "contracts", label: "Active Contracts" }, { key: "completed", label: "Completed Work" },
];

/** The design system's six-state vocabulary; icon and word carry the meaning, colour reinforces it. */
function Status({ result }: { result: CheckResult | "PENDING" }) {
  const map: Record<string, { mark: string; word: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    PASS: { mark: "✓", word: "Ready", variant: "default" }, WARN: { mark: "!", word: "Review", variant: "secondary" },
    BLOCK: { mark: "×", word: "Blocked", variant: "destructive" }, UNKNOWN: { mark: "?", word: "Unknown", variant: "outline" }, PENDING: { mark: "○", word: "Pending", variant: "outline" },
  };
  const s = map[result]!;
  return <Badge variant={s.variant} aria-label={`${s.word}`}>{s.mark} {s.word}</Badge>;
}

const eligibilityWord = (e: ReadinessProjection["eligibility"]) => (e === "eligible" ? "Eligible" : e === "eligible_with_warnings" ? "Eligible with warnings" : "Not currently eligible");
const windowText = (w: Window) => (w.open ? (w.remainingMs != null ? `Bidding open · ${Math.max(0, Math.round(w.remainingMs / 3_600_000))} h left` : "Bidding open · no deadline") : `Bidding not open (${w.reason.replace(/_/g, " ")})`);

export function MarketplaceView(p: MarketplaceViewProps) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [cancelReason, setCancelReason] = useState("");
  const [draft, setDraft] = useState<BidDraft>({ pricingType: "fixed_price", amountCents: "", unitsOffered: "", unit: "LOAD", exclusions: "", notes: "" });
  const [newPosting, setNewPosting] = useState({ title: "", workType: "", operatingArea: "", unitsRequired: "", biddingClosesAt: "", visibility: "sealed" as "open" | "sealed", distribution: "public" as "public" | "invite_only" });
  const d = p.detail;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="marketplace">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Marketplace">
        {tabs.map(t => <Button key={t.key} role="tab" aria-selected={p.tab === t.key} variant={p.tab === t.key ? "default" : "outline"} size="sm" onClick={() => p.onTab(t.key)}>{t.label}</Button>)}
      </div>

      {p.tab === "board" && (
        <div className="grid gap-4 md:grid-cols-5">
          <Card className="md:col-span-2">
            <CardHeader><CardTitle>Job Board</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <ul className="space-y-2" data-testid="posting-list">
                {p.postings.map(x => (
                  <li key={x.postingRef}>
                    <button type="button" className={`w-full rounded border p-2 text-left ${p.selectedRef === x.postingRef ? "border-primary" : ""}`} onClick={() => p.onSelect(x.postingRef)} aria-pressed={p.selectedRef === x.postingRef}>
                      <div className="flex items-center justify-between gap-2"><span className="font-medium">{x.title}</span><Badge variant="outline">{x.state.replace(/_/g, " ")}</Badge></div>
                      <div className="text-xs text-muted-foreground">{x.workType}{x.operatingArea ? ` · ${x.operatingArea}` : ""}{x.unitsRequired ? ` · ${x.unitsRequired} unit(s)` : ""}{x.isClient ? " · yours" : ""}{x.distribution === "invite_only" ? " · invite-only" : ""}{x.visibility === "sealed" ? " · sealed" : ""}</div>
                      <div className="text-xs">{windowText(x.biddingWindow)}</div>
                    </button>
                  </li>
                ))}
                {p.postings.length === 0 && <li className="text-muted-foreground">No postings you can see yet.</li>}
              </ul>
              <fieldset className="space-y-2 rounded border p-2" data-testid="new-posting">
                <legend className="px-1 text-xs text-muted-foreground">Post work (as the client)</legend>
                <Input aria-label="Posting title" placeholder="Produced water haul — Fox Creek" value={newPosting.title} onChange={e => setNewPosting({ ...newPosting, title: e.target.value })} />
                <Input aria-label="Work type" placeholder="FLUID_HAULING" value={newPosting.workType} onChange={e => setNewPosting({ ...newPosting, workType: e.target.value.toUpperCase() })} />
                <Input aria-label="Operating area" placeholder="Fox Creek" value={newPosting.operatingArea} onChange={e => setNewPosting({ ...newPosting, operatingArea: e.target.value })} />
                <Input aria-label="Units required" placeholder="4" value={newPosting.unitsRequired} onChange={e => setNewPosting({ ...newPosting, unitsRequired: e.target.value })} />
                <Input aria-label="Bids close at" type="datetime-local" value={newPosting.biddingClosesAt} onChange={e => setNewPosting({ ...newPosting, biddingClosesAt: e.target.value })} />
                <div className="flex gap-2">
                  <label className="text-xs">Pricing visibility <select aria-label="Visibility" className="ml-1 rounded border p-1" value={newPosting.visibility} onChange={e => setNewPosting({ ...newPosting, visibility: e.target.value as "open" | "sealed" })}><option value="sealed">sealed</option><option value="open">open</option></select></label>
                  <label className="text-xs">Distribution <select aria-label="Distribution" className="ml-1 rounded border p-1" value={newPosting.distribution} onChange={e => setNewPosting({ ...newPosting, distribution: e.target.value as "public" | "invite_only" })}><option value="public">public</option><option value="invite_only">invite-only</option></select></label>
                </div>
                <Button size="sm" data-testid="create-posting" disabled={p.busy || newPosting.title.trim().length < 3 || !/^[A-Z][A-Z0-9_]*$/.test(newPosting.workType)} onClick={() => p.onNewPosting(newPosting)}>Create draft posting</Button>
              </fieldset>
            </CardContent>
          </Card>

          <div className="space-y-4 md:col-span-3">
            {!d && <Card><CardContent className="p-4 text-sm text-muted-foreground">Select a posting to read it.</CardContent></Card>}
            {d && (
              <>
                <Card data-testid="posting-detail">
                  <CardHeader><CardTitle>{d.title}</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex flex-wrap gap-1"><Badge variant="outline">{d.state.replace(/_/g, " ")}</Badge><Badge variant="outline">{d.visibility}</Badge><Badge variant="outline">{d.distribution.replace(/_/g, "-")}</Badge>{d.isClient && <Badge>your posting</Badge>}</div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                      <dt className="text-muted-foreground">Work</dt><dd>{d.workType}{d.equipmentType ? ` · ${d.equipmentType}` : ""}</dd>
                      <dt className="text-muted-foreground">Where</dt><dd>{d.pickupLocation ?? d.operatingArea ?? "—"}{d.destination ? ` → ${d.destination}` : ""}</dd>
                      <dt className="text-muted-foreground">Units</dt><dd>{d.unitsRequired ?? "—"}</dd>
                      <dt className="text-muted-foreground">Start</dt><dd>{when(d.requestedStart)}</dd>
                      <dt className="text-muted-foreground">Bidding</dt><dd>{windowText(d.biddingWindow)}{d.biddingClosesAt ? ` · closes ${when(d.biddingClosesAt)}` : ""}</dd>
                      <dt className="text-muted-foreground">Live bids</dt><dd>{d.liveBidCount}{d.openBidRange && d.openBidRange.withTotal > 0 ? ` · range ${money(d.openBidRange.lowestCents)} – ${money(d.openBidRange.highestCents)}` : ""}{d.visibility === "sealed" ? " · prices sealed until bidding closes" : ""}</dd>
                    </dl>
                    {d.description && <p className="whitespace-pre-wrap">{d.description}</p>}
                    <div data-testid="requirements">
                      <div className="font-medium">Requirements</div>
                      <ul className="list-inside list-disc">
                        {d.requirements.workerQualificationCodes.map(c => <li key={c}>Workers hold {c}</li>)}
                        {d.requirements.tdgRequired && <li>Dangerous goods on the haul (TDG)</li>}
                        {d.requirements.organizationDocTypes.map(c => <li key={c}>Organization document on record: {c}</li>)}
                        {d.requirements.insurance && <li>{d.requirements.insurance.coverageType} cover{d.requirements.insurance.minimumLimitCents != null ? ` ≥ ${money(d.requirements.insurance.minimumLimitCents)}` : ""}{d.requirements.insurance.additionalInsuredRequired ? ", additional insured" : ""}</li>}
                        {d.requirements.equipmentClasses.map(c => <li key={c}>Units of class {c}</li>)}
                        {d.requirements.clientSpecific.map(c => <li key={c}>{c} <span className="text-xs text-muted-foreground">(client-stated; not machine-checked)</span></li>)}
                        {d.requirements.workerQualificationCodes.length + d.requirements.organizationDocTypes.length + d.requirements.equipmentClasses.length + d.requirements.clientSpecific.length === 0 && !d.requirements.insurance && !d.requirements.tdgRequired && <li className="text-muted-foreground">None stated.</li>}
                      </ul>
                    </div>
                    {d.award && (
                      <div className="rounded border p-2" data-testid="award">
                        <div className="font-medium">Awarded to {d.award.contractorOrgRef} <Badge variant="outline">{d.award.state}</Badge></div>
                        <div>{d.award.comparableTotalCents != null ? money(d.award.comparableTotalCents, d.award.currency) : "price not shared with you"}</div>
                        {d.award.rationale && <div className="text-xs text-muted-foreground">Reason: {d.award.rationale}</div>}
                      </div>
                    )}
                    {d.isClient && (
                      <div className="flex flex-wrap gap-2" data-testid="client-controls">
                        {d.state === "draft" && <Button size="sm" disabled={p.busy} onClick={() => p.onPublish(d.postingRef, d.version)}>Publish</Button>}
                        {d.state === "published" && <Button size="sm" disabled={p.busy} onClick={() => p.onOpenBidding(d.postingRef, d.version)}>Open bidding</Button>}
                        {d.state === "bidding" && <Button size="sm" disabled={p.busy} onClick={() => p.onCloseBidding(d.postingRef, d.version)}>Close bidding</Button>}
                        {d.state === "awarded" && <Button size="sm" disabled={p.busy} onClick={() => p.onIssueContract(d.postingRef, d.version)}>Issue contract</Button>}
                        {["draft", "published", "bidding", "bidding_closed", "awarded"].includes(d.state) && (
                          <span className="flex items-center gap-1"><Input aria-label="Cancellation reason" className="h-8 w-56" placeholder="reason to cancel" value={cancelReason} onChange={e => setCancelReason(e.target.value)} /><Button size="sm" variant="outline" disabled={p.busy || cancelReason.trim().length < 3} onClick={() => p.onCancel(d.postingRef, d.version, cancelReason)}>Cancel posting</Button></span>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {d.isClient && (
                  <Card data-testid="client-bids">
                    <CardHeader><CardTitle>Bids ({p.clientBids.length})</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      {p.clientBids.length === 0 && <div className="text-muted-foreground">No bids yet.</div>}
                      {p.clientBids.map(b => (
                        <div key={b.bidRef} className="rounded border p-2" data-testid={`client-bid-${b.bidRef}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{b.bidderOrgRef}</span>
                            <span className="flex gap-1"><Badge variant="outline">{b.state}</Badge><Badge variant="outline">rev {b.revisionCount}</Badge>{b.unitsOffered != null && <Badge variant="outline">{b.unitsOffered} unit(s)</Badge>}</span>
                          </div>
                          <div>{b.pricing.visible ? b.pricing.summary : <span className="text-muted-foreground">Price withheld: {b.pricing.reason}</span>}</div>
                          {b.currentReadiness && (
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              <span className="text-xs text-muted-foreground">Readiness now:</span>
                              <Badge variant={b.currentReadiness.eligibility === "not_currently_eligible" ? "destructive" : b.currentReadiness.eligibility === "eligible_with_warnings" ? "secondary" : "default"}>{eligibilityWord(b.currentReadiness.eligibility)}</Badge>
                              {b.readinessChangedSinceSubmission && <Badge variant="outline">changed since submission</Badge>}
                              {b.currentReadiness.checks.filter(c => c.result !== "PASS").map(c => <span key={c.check} className="text-xs">{c.check} <Status result={c.result} /></span>)}
                            </div>
                          )}
                          {(b.state === "submitted" || b.state === "shortlisted") && d.state === "bidding_closed" && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {b.state === "submitted" && <Button size="sm" variant="outline" disabled={p.busy} onClick={() => p.onShortlist(b.bidRef)}>Shortlist</Button>}
                              <Input aria-label={`Award rationale for ${b.bidderOrgRef}`} className="h-8 w-72" placeholder="why this bid (at least ten characters)" value={rationale[b.bidRef] ?? ""} onChange={e => setRationale({ ...rationale, [b.bidRef]: e.target.value })} />
                              <Button size="sm" data-testid={`award-${b.bidRef}`} disabled={p.busy || (rationale[b.bidRef] ?? "").trim().length < 10} onClick={() => p.onAward(d.postingRef, b.bidRef, rationale[b.bidRef]!, d.version)}>Award</Button>
                            </div>
                          )}
                        </div>
                      ))}
                      <p className="text-xs text-muted-foreground">Price is one consideration. The award is yours, with your reason; it is never decided by the lowest number.</p>
                    </CardContent>
                  </Card>
                )}

                {!d.isClient && (
                  <Card data-testid="bidder-panel">
                    <CardHeader><CardTitle>Your bid</CardTitle></CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      {p.readiness && (
                        <div data-testid="readiness">
                          <div className="flex items-center gap-2"><span className="font-medium">Your readiness</span><Badge variant={p.readiness.verdict === "submittable" ? "default" : "destructive"}>{p.readiness.verdict === "submittable" ? "✓ Eligible to submit" : "× Blocked"}</Badge></div>
                          <ul className="mt-1 space-y-0.5">
                            {p.readiness.checks.map(c => <li key={c.check} className="flex items-start gap-2"><Status result={c.result} /><span><span className="font-mono text-xs">{c.check}</span> — {c.detail}</span></li>)}
                          </ul>
                          <div className="text-xs text-muted-foreground">Not decided here: {p.readiness.notEvaluated.map(n => `${n.capability.replace(/_/g, " ")} (${n.decidedBy})`).join("; ")}.</div>
                        </div>
                      )}
                      {p.myBidOnSelected && (
                        <div className="rounded border p-2" data-testid="my-bid">
                          <div className="flex items-center justify-between"><span>Bid {p.myBidOnSelected.bidRef}</span><Badge variant="outline">{p.myBidOnSelected.state}</Badge></div>
                          {p.myBidOnSelected.revisions.map(r => <div key={r.revisionNumber} className="text-xs">rev {r.revisionNumber} · {r.summary} · {when(r.submittedAt)}</div>)}
                          <div className="mt-1 flex gap-2">
                            {p.myBidOnSelected.state === "draft" || p.myBidOnSelected.state === "withdrawn" ? <Button size="sm" data-testid="submit-bid" disabled={p.busy || p.readiness?.verdict !== "submittable"} onClick={() => p.onSubmit(p.myBidOnSelected!.bidRef, p.myBidOnSelected!.version)}>Submit bid</Button> : null}
                            {(p.myBidOnSelected.state === "submitted" || p.myBidOnSelected.state === "shortlisted") && d.state === "bidding" ? <Button size="sm" variant="outline" disabled={p.busy} onClick={() => p.onWithdraw(p.myBidOnSelected!.bidRef, p.myBidOnSelected!.version)}>Withdraw</Button> : null}
                          </div>
                          {p.readiness?.verdict === "blocked" && (p.myBidOnSelected.state === "draft" || p.myBidOnSelected.state === "withdrawn") && <div className="text-xs text-muted-foreground">You can keep preparing this draft; submission needs every blocking row cleared on record.</div>}
                        </div>
                      )}
                      {(!p.myBidOnSelected || p.myBidOnSelected.state === "draft" || p.myBidOnSelected.state === "withdrawn") && (
                        <fieldset className="space-y-2 rounded border p-2" data-testid="bid-draft">
                          <legend className="px-1 text-xs text-muted-foreground">Draft</legend>
                          <label className="text-xs">Pricing <select aria-label="Pricing type" className="ml-1 rounded border p-1" value={draft.pricingType} onChange={e => setDraft({ ...draft, pricingType: e.target.value as BidDraft["pricingType"] })}><option value="fixed_price">fixed price</option><option value="unit_rate">unit rate</option><option value="hourly">hourly</option></select></label>
                          {draft.pricingType === "unit_rate" && <label className="ml-2 text-xs">per <select aria-label="Rate unit" className="ml-1 rounded border p-1" value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value as BidDraft["unit"] })}>{["LOAD", "M3", "TONNE", "KM", "DAY", "EACH"].map(u => <option key={u} value={u}>{u}</option>)}</select></label>}
                          <Input aria-label={draft.pricingType === "fixed_price" ? "Total in cents" : "Rate in cents"} placeholder={draft.pricingType === "fixed_price" ? "1480000" : "48500"} value={draft.amountCents} onChange={e => setDraft({ ...draft, amountCents: e.target.value.replace(/[^0-9]/g, "") })} />
                          <Input aria-label="Units offered" placeholder={String(d.unitsRequired ?? 1)} value={draft.unitsOffered} onChange={e => setDraft({ ...draft, unitsOffered: e.target.value.replace(/[^0-9]/g, "") })} />
                          <Input aria-label="Exclusions" placeholder="e.g. disposal fees" value={draft.exclusions} onChange={e => setDraft({ ...draft, exclusions: e.target.value })} />
                          <Textarea aria-label="Notes" placeholder="notes to the client" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} />
                          <Button size="sm" data-testid="save-draft" disabled={p.busy || !/^\d+$/.test(draft.amountCents) || !/^[1-9]\d*$/.test(draft.unitsOffered)} onClick={() => p.onSaveDraft(d.postingRef, draft)}>Save draft</Button>
                        </fieldset>
                      )}
                    </CardContent>
                  </Card>
                )}

                <Card data-testid="discussion">
                  <CardHeader><CardTitle>Questions and clarifications</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {p.clarifications.length === 0 && <div className="text-muted-foreground">Nothing asked yet.</div>}
                    {p.clarifications.map(c => (
                      <div key={c.clarificationRef} className="rounded border p-2">
                        <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{c.kind === "notice" ? "Notice from the client" : c.askerOrgRef ? `Question from ${c.askerOrgRef}` : "Question (asker withheld)"}</span><Badge variant="outline">{c.status}</Badge></div>
                        <div>{c.question}</div>
                        {c.answer && <div className="mt-1 border-l-2 pl-2">{c.answer}</div>}
                        {d.isClient && c.status === "open" && (
                          <div className="mt-1 flex gap-2"><Input aria-label={`Answer ${c.clarificationRef}`} className="h-8" value={answers[c.clarificationRef] ?? ""} onChange={e => setAnswers({ ...answers, [c.clarificationRef]: e.target.value })} /><Button size="sm" disabled={p.busy || !(answers[c.clarificationRef] ?? "").trim()} onClick={() => p.onAnswer(c.clarificationRef, answers[c.clarificationRef]!)}>Answer privately</Button></div>
                        )}
                        {d.isClient && c.status === "answered" && <Button size="sm" variant="outline" className="mt-1" disabled={p.busy} onClick={() => p.onPublishClarification(c.clarificationRef)}>Publish to all bidders</Button>}
                      </div>
                    ))}
                    {!d.isClient && (d.state === "published" || d.state === "bidding") && (
                      <div className="flex gap-2"><Input aria-label="Your question" placeholder="Is disposal included in the bid?" value={question} onChange={e => setQuestion(e.target.value)} /><Button size="sm" disabled={p.busy || question.trim().length < 5} onClick={() => { p.onAsk(d.postingRef, question); setQuestion(""); }}>Ask</Button></div>
                    )}
                    {d.isClient && (d.state === "published" || d.state === "bidding") && (
                      <div className="flex gap-2"><Input aria-label="Notice to all bidders" placeholder="Road ban lifted on the lease road" value={notice} onChange={e => setNotice(e.target.value)} /><Button size="sm" disabled={p.busy || notice.trim().length < 5} onClick={() => { p.onNotice(d.postingRef, notice); setNotice(""); }}>Issue notice</Button></div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {p.tab === "bids" && (
        <Card>
          <CardHeader><CardTitle>My Bids</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="my-bids">
            {p.myBids.length === 0 && <div className="text-muted-foreground">No bids yet.</div>}
            {p.myBids.map(b => (
              <div key={b.bidRef} className="rounded border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => { if (b.posting) { p.onSelect(b.posting.postingRef); p.onTab("board"); } }}>{b.posting?.title ?? "(posting unavailable)"}</button>
                  <span className="flex gap-1"><Badge variant="outline">{b.state}</Badge>{b.posting && <Badge variant="outline">posting {b.posting.state.replace(/_/g, " ")}</Badge>}</span>
                </div>
                {b.revisions.map(r => <div key={r.revisionNumber} className="text-xs">rev {r.revisionNumber} · {r.summary} · submitted {when(r.submittedAt)} · readiness at submission: {r.readinessVerdict ?? "—"}</div>)}
                {b.currentReadiness && (
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                    <span className="text-muted-foreground">Readiness now:</span>
                    <Badge variant={b.currentReadiness.verdict === "submittable" ? "default" : "destructive"}>{b.currentReadiness.verdict === "submittable" ? "✓ Ready" : "× Blocked"}</Badge>
                    {b.readinessChangedSinceSubmission && <Badge variant="outline">changed since submission</Badge>}
                    {b.currentReadiness.checks.filter(c => c.result !== "PASS").map(c => <span key={c.check}>{c.check}: {c.detail}</span>)}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {p.tab === "invitations" && (
        <Card>
          <CardHeader><CardTitle>Invitations</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="invitations">
            {p.postings.filter(x => x.distribution === "invite_only" && !x.isClient).map(x => (
              <button key={x.postingRef} type="button" className="block w-full rounded border p-2 text-left" onClick={() => { p.onSelect(x.postingRef); p.onTab("board"); }}>
                <div className="flex items-center justify-between gap-2"><span className="font-medium">{x.title}</span><Badge variant="outline">{x.state.replace(/_/g, " ")}</Badge></div>
                <div className="text-xs text-muted-foreground">{x.clientOrgRef} invited your organization · {windowText(x.biddingWindow)}</div>
              </button>
            ))}
            {p.postings.filter(x => x.distribution === "invite_only" && !x.isClient).length === 0 && <div className="text-muted-foreground">No invitations.</div>}
          </CardContent>
        </Card>
      )}

      {p.tab === "awards" && (
        <Card>
          <CardHeader><CardTitle>Awards</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="awards">
            {p.postings.filter(x => ["awarded", "contracted", "dispatched", "active", "completed", "closed"].includes(x.state)).map(x => (
              <button key={x.postingRef} type="button" className="block w-full rounded border p-2 text-left" onClick={() => { p.onSelect(x.postingRef); p.onTab("board"); }}>
                <div className="flex items-center justify-between gap-2"><span className="font-medium">{x.title}</span><Badge variant="outline">{x.state.replace(/_/g, " ")}</Badge></div>
                <div className="text-xs text-muted-foreground">{x.isClient ? "awarded by you" : "see the posting for the award"}</div>
              </button>
            ))}
            {p.myBids.filter(b => b.state === "accepted").map(b => <div key={b.bidRef} className="rounded border p-2"><span className="font-medium">{b.posting?.title}</span> <Badge>your bid was awarded</Badge></div>)}
            {p.myBids.filter(b => b.state === "rejected").map(b => <div key={b.bidRef} className="rounded border p-2 text-muted-foreground">{b.posting?.title} — not awarded</div>)}
            {p.postings.filter(x => ["awarded", "contracted", "dispatched", "active", "completed", "closed"].includes(x.state)).length + p.myBids.filter(b => b.state === "accepted" || b.state === "rejected").length === 0 && <div className="text-muted-foreground">No awards yet.</div>}
          </CardContent>
        </Card>
      )}

      {p.tab === "contracts" && (
        <Card>
          <CardHeader><CardTitle>Active Contracts</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="contracts">
            {p.contracts.filter(c => c.state !== "cancelled").map(c => (
              <div key={c.contractRef} className="rounded border p-2" data-testid={`contract-${c.contractRef}`}>
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{c.postingTitle ?? c.contractRef}</span><Badge variant="outline">{c.state}</Badge></div>
                <div className="text-xs text-muted-foreground">Job {c.jobCode} · chain {c.chainNumber} · {c.isClient ? `contractor ${c.contractorOrgRef}` : `client ${c.clientOrgRef}`}{c.dispatchPostingNumber ? ` · dispatch ${c.dispatchPostingNumber}` : ""}</div>
                {c.isContractor && c.state === "issued" && <Button size="sm" className="mt-1" data-testid={`dispatch-${c.contractRef}`} disabled={p.busy} onClick={() => p.onDispatch(c.contractRef)}>Dispatch (create the job's slots)</Button>}
                {c.state === "dispatched" && <div className="text-xs">Slots created; staffing and the readiness gate continue on the Dispatch screen.</div>}
              </div>
            ))}
            {p.contracts.filter(c => c.state !== "cancelled").length === 0 && <div className="text-muted-foreground">No contracts.</div>}
          </CardContent>
        </Card>
      )}

      {p.tab === "completed" && (
        <Card>
          <CardHeader><CardTitle>Completed Work</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="completed">
            {p.postings.filter(x => x.state === "completed" || x.state === "closed").map(x => <div key={x.postingRef} className="rounded border p-2">{x.title} <Badge variant="outline">{x.state}</Badge></div>)}
            {p.postings.filter(x => x.state === "completed" || x.state === "closed").length === 0 && <div className="text-muted-foreground">Nothing completed yet. A posting reaches here when its job closes out; that door is P10.7, and no work is called complete before it.</div>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

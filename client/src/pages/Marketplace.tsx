/** P10.5 — the Marketplace, the container: wires the pure view to marketplace.* and nothing else. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { MarketplaceView, type BidDraft, type ClientBidRow, type ContractRow, type MarketplaceTab, type MyBidRow, type PostingDetail, type PostingRow, type Readiness, type ReadinessProjection } from "./MarketplaceView";

const money = (c: number | null | undefined, currency: string) => (c == null ? "—" : (c / 100).toLocaleString(undefined, { style: "currency", currency }));

/** A revision's pricing as one line. The server has already decided whether the viewer may see it. */
function pricingSummary(pr: { pricingType: string; currency: string; fixedTotalCents: number | null; components: { code: string; unit: string; rateCents: number }[]; comparableTotalCents: number | null }): string {
  if (pr.pricingType === "fixed_price") return `${money(pr.fixedTotalCents, pr.currency)} fixed`;
  const parts = pr.components.map(c => `${money(c.rateCents, pr.currency)}/${c.unit}${c.code !== "RATE" && c.code !== "HOURLY" ? ` ${c.code}` : ""}`);
  return `${parts.join(" + ")}${pr.comparableTotalCents != null ? ` ≈ ${money(pr.comparableTotalCents, pr.currency)}` : " (no comparable total)"}`;
}

const asProjection = (v: unknown): ReadinessProjection | null => (v && typeof v === "object" && "eligibility" in (v as object) ? (v as ReadinessProjection) : null);

export default function Marketplace() {
  const [tab, setTab] = useState<MarketplaceTab>("board");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const err = (e: { message: string }) => toast.error(e.message);
  const refresh = () => { void utils.marketplace.invalidate(); };
  const m = <T,>(msg: string | ((r: T) => string)) => ({ onSuccess: (r: T) => { toast.success(typeof msg === "string" ? msg : msg(r)); refresh(); }, onError: err });

  const postings = trpc.marketplace.postingsList.useQuery({});
  const detail = trpc.marketplace.postingGet.useQuery({ postingRef: selectedRef ?? "" }, { enabled: selectedRef !== null });
  const isClient = !!detail.data?.isClient;
  const clarifications = trpc.marketplace.clarifications.useQuery({ postingRef: selectedRef ?? "" }, { enabled: selectedRef !== null });
  const readiness = trpc.marketplace.bidReadiness.useQuery({ postingRef: selectedRef ?? "" }, { enabled: selectedRef !== null && detail.data !== undefined && !isClient });
  const clientBids = trpc.marketplace.bidsForPosting.useQuery({ postingRef: selectedRef ?? "" }, { enabled: selectedRef !== null && isClient });
  const myBids = trpc.marketplace.bidsMine.useQuery({});
  const contracts = trpc.marketplace.contractsMine.useQuery();

  const postingCreate = trpc.marketplace.postingCreate.useMutation(m<{ postingRef: string }>(r => { setSelectedRef(r.postingRef); return "Draft posting created"; }));
  const publish = trpc.marketplace.postingPublish.useMutation(m("Published"));
  const open = trpc.marketplace.postingOpenBidding.useMutation(m<{ notifiedOrganizations: number }>(r => `Bidding open — ${r.notifiedOrganizations} following organization(s) told`));
  const close = trpc.marketplace.postingCloseBidding.useMutation(m("Bidding closed"));
  const cancel = trpc.marketplace.postingCancel.useMutation(m("Posting cancelled"));
  const shortlist = trpc.marketplace.bidShortlist.useMutation(m("Shortlisted"));
  const award = trpc.marketplace.award.useMutation(m<{ contractorOrgRef: string }>(r => `Awarded to ${r.contractorOrgRef}`));
  const issue = trpc.marketplace.contractIssue.useMutation(m<{ jobCode: string; chainNumber: string }>(r => `Contract issued — job ${r.jobCode}, chain ${r.chainNumber}`));
  const ask = trpc.marketplace.questionAsk.useMutation(m("Question sent to the client"));
  const answer = trpc.marketplace.questionAnswer.useMutation(m("Answered privately"));
  const publishClarification = trpc.marketplace.clarificationPublish.useMutation(m<{ notifiedOrganizations: number }>(r => `Published to ${r.notifiedOrganizations} organization(s)`));
  const notice = trpc.marketplace.noticeIssue.useMutation(m("Notice issued"));
  const saveDraft = trpc.marketplace.bidDraftSave.useMutation(m("Draft saved"));
  const submit = trpc.marketplace.bidSubmit.useMutation(m<{ revisionNumber: number }>(r => `Submitted as revision ${r.revisionNumber}`));
  const withdraw = trpc.marketplace.bidWithdraw.useMutation(m("Withdrawn — the submitted revision stays on record"));
  const dispatch = trpc.marketplace.contractDispatch.useMutation(m<{ roleIds: number[]; alreadyDispatched: boolean }>(r => (r.alreadyDispatched ? "Already dispatched" : `Dispatched — ${r.roleIds.length} slot(s) created`)));
  const busy = [postingCreate, publish, open, close, cancel, shortlist, award, issue, ask, answer, publishClarification, notice, saveDraft, submit, withdraw, dispatch].some(x => x.isPending);

  const rows: PostingRow[] = (postings.data ?? []).map(x => ({
    postingRef: x.postingRef, title: x.title, workType: x.workType, operatingArea: x.operatingArea, pickupLocation: x.pickupLocation, destination: x.destination, unitsRequired: x.unitsRequired,
    equipmentType: x.equipmentType, requestedStart: x.requestedStart, biddingClosesAt: x.biddingClosesAt, state: x.state, visibility: x.visibility, distribution: x.distribution, biddingWindow: x.biddingWindow, isClient: x.isClient, version: x.version, clientOrgRef: x.clientOrgRef,
  }));
  const d = detail.data;
  const detailView: PostingDetail | null = d ? {
    ...rows.find(r => r.postingRef === d.postingRef) ?? { postingRef: d.postingRef, title: d.title, workType: d.workType, operatingArea: d.operatingArea, pickupLocation: d.pickupLocation, destination: d.destination, unitsRequired: d.unitsRequired, equipmentType: d.equipmentType, requestedStart: d.requestedStart, biddingClosesAt: d.biddingClosesAt, state: d.state, visibility: d.visibility, distribution: d.distribution, biddingWindow: d.biddingWindow, isClient: d.isClient, version: d.version, clientOrgRef: d.clientOrgRef },
    description: d.description, requirements: d.requirements, liveBidCount: d.liveBidCount, openBidRange: d.openBidRange, award: d.award, invitations: d.invitations.map(i => ({ invitationRef: i.invitationRef, invitedOrgRef: i.invitedOrgRef, status: i.status })),
  } : null;

  const mine: MyBidRow[] = (myBids.data ?? []).map(b => ({
    bidRef: b.bidRef, posting: b.posting, state: b.state, version: b.version,
    revisions: b.revisions.map(r => ({ revisionNumber: r.revisionNumber, submittedAt: r.submittedAt, summary: r.pricing.visible ? pricingSummary(r.pricing) : "withheld", comparableTotalCents: r.pricing.visible ? r.pricing.comparableTotalCents : null, readinessVerdict: r.submissionReadiness && "verdict" in r.submissionReadiness ? r.submissionReadiness.verdict : null })),
    currentReadiness: (b.currentReadiness as Readiness | null) ?? null,
    readinessChangedSinceSubmission: b.readinessChangedSinceSubmission,
  }));
  const clientRows: ClientBidRow[] = (clientBids.data ?? []).map(b => ({
    bidRef: b.bidRef, bidderOrgRef: b.bidderOrgRef, state: b.state, revisionCount: b.revisionCount,
    pricing: b.current?.pricing.visible ? { visible: true, summary: pricingSummary(b.current.pricing), comparableTotalCents: b.current.pricing.comparableTotalCents } : { visible: false, reason: b.pricingWithheld ?? "withheld" },
    submissionReadiness: asProjection(b.current?.submissionReadiness), currentReadiness: asProjection(b.currentReadiness), readinessChangedSinceSubmission: b.readinessChangedSinceSubmission, unitsOffered: b.current?.unitsOffered ?? null,
  }));
  const contractRows: ContractRow[] = (contracts.data ?? []).map(c => ({ contractRef: c.contractRef, postingTitle: null, clientOrgRef: c.clientOrgRef, contractorOrgRef: c.contractorOrgRef, isClient: c.isClient, isContractor: c.isContractor, state: c.state, jobCode: c.jobCode, chainNumber: c.chainNumber, dispatchPostingNumber: c.dispatchPostingNumber }));

  const contentFrom = (draft: BidDraft) => {
    const cents = Number(draft.amountCents);
    const base = { currency: "CAD", exclusions: draft.exclusions.split(";").map(s => s.trim()).filter(Boolean), qualifications: { certifications: [], permits: [], dangerousGoods: [], insuranceLiabilityCents: null, equipmentTypes: [] }, unitsOffered: Number(draft.unitsOffered), availableFrom: null, notes: draft.notes.trim() || null, attachments: [] };
    if (draft.pricingType === "fixed_price") return { ...base, pricingType: "fixed_price" as const, fixedTotalCents: cents, components: [] };
    if (draft.pricingType === "hourly") return { ...base, pricingType: "hourly" as const, fixedTotalCents: null, components: [{ code: "HOURLY", label: "Per hour per unit", unit: "HOUR" as const, rateCents: cents, estimatedQuantityMillis: null }] };
    return { ...base, pricingType: "unit_rate" as const, fixedTotalCents: null, components: [{ code: "RATE", label: `Per ${draft.unit}`, unit: draft.unit, rateCents: cents, estimatedQuantityMillis: null }] };
  };

  return (
    <MarketplaceView
      tab={tab} onTab={setTab} busy={busy}
      postings={rows} selectedRef={selectedRef} onSelect={setSelectedRef} detail={detailView}
      clarifications={(clarifications.data ?? []).map(c => ({ clarificationRef: c.clarificationRef, kind: c.kind, status: c.status, askerOrgRef: c.askerOrgRef, question: c.question, answer: c.answer, mine: c.mine }))}
      onAsk={(postingRef, question) => ask.mutate({ postingRef, question })} onAnswer={(clarificationRef, a) => answer.mutate({ clarificationRef, answer: a })} onPublishClarification={clarificationRef => publishClarification.mutate({ clarificationRef })} onNotice={(postingRef, n) => notice.mutate({ postingRef, notice: n })}
      onPublish={(postingRef, expectedVersion) => publish.mutate({ postingRef, expectedVersion })} onOpenBidding={(postingRef, expectedVersion) => open.mutate({ postingRef, expectedVersion })} onCloseBidding={(postingRef, expectedVersion) => close.mutate({ postingRef, expectedVersion })} onCancel={(postingRef, expectedVersion, reason) => cancel.mutate({ postingRef, expectedVersion, reason })}
      clientBids={clientRows} onShortlist={bidRef => shortlist.mutate({ bidRef })} onAward={(postingRef, bidRef, rationale, expectedVersion) => award.mutate({ postingRef, bidRef, rationale, expectedVersion })} onIssueContract={(postingRef, expectedVersion) => issue.mutate({ postingRef, expectedVersion })}
      onNewPosting={n => postingCreate.mutate({ title: n.title, workType: n.workType, operatingArea: n.operatingArea || null, unitsRequired: /^\d+$/.test(n.unitsRequired) ? Number(n.unitsRequired) : null, biddingClosesAt: n.biddingClosesAt ? new Date(n.biddingClosesAt) : null, visibility: n.visibility, distribution: n.distribution })}
      readiness={!isClient ? ((readiness.data as Readiness | undefined) ?? null) : null} myBidOnSelected={mine.find(b => b.posting?.postingRef === selectedRef) ?? null}
      onSaveDraft={(postingRef, draft) => saveDraft.mutate({ postingRef, content: contentFrom(draft) })} onSubmit={(bidRef, expectedVersion) => submit.mutate({ bidRef, expectedVersion })} onWithdraw={(bidRef, expectedVersion) => withdraw.mutate({ bidRef, expectedVersion })}
      myBids={mine} contracts={contractRows} onDispatch={contractRef => dispatch.mutate({ contractRef })}
    />
  );
}

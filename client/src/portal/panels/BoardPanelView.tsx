/**
 * 0182/0183 — the Board: conversations and open work, for a phone in a cab.
 *
 * Pure: every word comes from `boardModel`, every value from props. The container reads the server
 * and the device's queue and hands both over; this renders them and reports what was tapped.
 *
 * Two things it never does. It never shows a message as the recipient's until the server has it —
 * a queued message sits under the conversation with its own state, apart from what the server
 * returned. And it never offers "Interested" as if it were taking the work: the card says what is on
 * record, what is not established, and that dispatch gives the work.
 */
import { useState } from "react";
import type { SyncState } from "@/runtime/contracts";
import type { ShiftResponse } from "@/runtime/boardQueue";
import {
  BOARD_TABS, MARK_GLYPH, MARK_WORDS, TAB_LABELS, presentResponse, presentSend, tabBadge,
  type BoardChannel, type BoardTab, type OpenWorkCard,
} from "../boardModel";

export type Loadable<T> = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; value: T };

export type MessageRow = {
  messageRef: string;
  authorLabel: string;
  mine: boolean;
  priority: "normal" | "important" | "urgent" | "emergency";
  body: string;
  deviceCreatedAt: Date;
  serverReceivedAt: Date | null;
  requiresAcknowledgement: boolean;
  /** null: not in this message's audience, which is not the same as having acknowledged it. */
  acknowledgedByMe: boolean | null;
  /** An acknowledgement of this message waiting on the device, if one is. */
  pendingAcknowledgement: SyncState | null;
};

export type PendingMessage = { localId: string; body: string; state: SyncState; lastError: string | null; capturedAt: Date };

export type WorkRow = { postRef: string; title: string; requiredRole: string; startsAt: Date; place: string; overtime: boolean; myResponse: string | null };

export type BoardPanelViewProps = {
  online: boolean;
  /** False in a browser with no native shell: the queue lives only as long as this page. */
  durableQueue: boolean;
  tab: BoardTab;
  onTab: (tab: BoardTab) => void;
  channels: Loadable<BoardChannel[]>;
  visibleChannels: BoardChannel[];
  selectedChannel: string | null;
  onSelectChannel: (channelRef: string) => void;
  messages: Loadable<MessageRow[]> | { kind: "none" };
  pendingMessages: PendingMessage[];
  onSend: (body: string, priority: "normal" | "important") => void;
  onAcknowledge: (messageRef: string) => void;
  work: Loadable<WorkRow[]>;
  selectedPost: string | null;
  onSelectPost: (postRef: string) => void;
  card: Loadable<OpenWorkCard> | { kind: "none" };
  myResponse: string | null;
  pendingResponse: { response: string; state: SyncState; lastError: string | null } | null;
  onRespond: (postRef: string, response: ShiftResponse) => void;
  offerAnswer: { kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string };
  onAnswerOffer: (offerRef: string, decision: "accepted" | "declined") => void;
  queueSummary: { waiting: number; refused: number };
  onRetry: () => void;
  /** A write this device could not keep (signed out, organization not settled). Stays until the next write. */
  writeNotice?: string | null;
};

const when = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const TONE: Record<string, string> = {
  pending: "bg-[#fff4e5] text-[#8a4b0a]", ok: "bg-[#e6f4ea] text-[#1e6b3a]", failed: "bg-[#fdecec] text-[#b42318]", attention: "bg-[#fdecec] text-[#b42318]",
  unknown: "bg-[#eef2f7] text-[#394b63]", blocked: "bg-[#fdecec] text-[#b42318]",
};
const PRIORITY_TONE: Record<MessageRow["priority"], string> = {
  normal: "", important: "bg-[#eef2f7] text-[#172033]", urgent: "bg-[#fff4e5] text-[#8a4b0a]", emergency: "bg-[#b42318] text-white",
};

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-lg bg-[#fdecec] p-3 text-sm text-[#b42318]">
      Could not load: {message} <button onClick={onRetry} className="min-h-[44px] inline-flex items-center ml-2 underline">Try again</button>
    </div>
  );
}

function SendBadge({ state }: { state: SyncState }) {
  const p = presentSend(state);
  return <span className={`rounded-full px-2 py-0.5 text-xs ${TONE[p.tone]}`}>{p.label}</span>;
}

function Conversation(props: BoardPanelViewProps) {
  const [draft, setDraft] = useState("");
  const [important, setImportant] = useState(false);
  const { messages } = props;
  return (
    <section aria-label="Conversation" className="min-w-0 flex-1">
      {messages.kind === "none" && <p className="text-sm text-[#5b6b82]">Choose a conversation.</p>}
      {messages.kind === "loading" && <p className="text-sm text-[#5b6b82]">Loading messages…</p>}
      {messages.kind === "failed" && <Failed message={messages.message} onRetry={props.onRetry} />}
      {messages.kind === "loaded" && (
        <>
          {messages.value.length === 0 && props.pendingMessages.length === 0 && <p className="text-sm text-[#5b6b82]">No messages yet.</p>}
          <ol className="space-y-2">
            {messages.value.map(m => (
              <li key={m.messageRef} className={`rounded-xl border p-3 ${m.mine ? "border-[#c9d6ea] bg-[#f4f7fc]" : "border-[#dfe5ee] bg-white"}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#5b6b82]">
                  <span>{m.authorLabel}</span>
                  <span>{when(m.deviceCreatedAt)}</span>
                  {m.priority !== "normal" && <span className={`rounded-full px-2 py-0.5 font-medium ${PRIORITY_TONE[m.priority]}`}>{m.priority}</span>}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
                {m.requiresAcknowledgement && m.acknowledgedByMe === false && (
                  m.pendingAcknowledgement
                    ? <div className="mt-2 text-xs">Your acknowledgement: <SendBadge state={m.pendingAcknowledgement} /></div>
                    : <button onClick={() => props.onAcknowledge(m.messageRef)} className="min-h-[44px] mt-2 rounded-lg bg-[#132a4a] px-3 py-1 text-sm text-white">Acknowledge</button>
                )}
                {m.requiresAcknowledgement && m.acknowledgedByMe === true && <div className="mt-2 text-xs text-[#1e6b3a]">You acknowledged this.</div>}
              </li>
            ))}
            {props.pendingMessages.map(p => (
              <li key={p.localId} className="rounded-xl border border-dashed border-[#c9d6ea] bg-[#f4f7fc] p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#5b6b82]"><span>You</span><span>{when(p.capturedAt)}</span><SendBadge state={p.state} /></div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{p.body}</p>
                {p.lastError && p.state !== "synchronized" && <p className="mt-1 text-xs text-[#b42318]">{p.lastError}</p>}
              </li>
            ))}
          </ol>
          <form
            className="mt-3 space-y-2"
            onSubmit={e => { e.preventDefault(); const body = draft.trim(); if (!body) return; props.onSend(body, important ? "important" : "normal"); setDraft(""); setImportant(false); }}
          >
            <label htmlFor="board-compose" className="block text-sm font-medium">Message</label>
            <textarea id="board-compose" value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={4000}
              className="w-full rounded-lg border border-[#c9d6ea] p-2 text-sm" />
            <div className="flex items-center gap-3">
              <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={important} onChange={e => setImportant(e.target.checked)} /> Important</label>
              <button type="submit" disabled={!draft.trim()} className="min-h-[44px] ml-auto rounded-lg bg-[#132a4a] px-4 py-1.5 text-sm text-white disabled:opacity-50">
                {props.online ? "Send" : "Queue to send"}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

function OpenWork(props: BoardPanelViewProps) {
  const { work, card } = props;
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <section aria-label="Open work" className="md:w-72">
        {work.kind === "loading" && <p className="text-sm text-[#5b6b82]">Loading open work…</p>}
        {work.kind === "failed" && <Failed message={work.message} onRetry={props.onRetry} />}
        {work.kind === "loaded" && (work.value.length === 0 ? <p className="text-sm text-[#5b6b82]">No open work right now.</p> : (
          <ul className="space-y-2">
            {work.value.map(w => (
              <li key={w.postRef}>
                <button onClick={() => props.onSelectPost(w.postRef)} aria-pressed={props.selectedPost === w.postRef}
                  className={`min-h-[44px] w-full rounded-xl border p-3 text-left ${props.selectedPost === w.postRef ? "border-[#132a4a] bg-[#f4f7fc]" : "border-[#dfe5ee] bg-white"}`}>
                  <span className="block font-medium">{w.title}</span>
                  <span className="block text-xs text-[#5b6b82]">{w.requiredRole} · {w.place} · {when(w.startsAt)}{w.overtime ? " · overtime" : ""}</span>
                  {w.myResponse && <span className="mt-1 block text-xs text-[#1e6b3a]">{presentResponse(w.myResponse)}</span>}
                </button>
              </li>
            ))}
          </ul>
        ))}
      </section>
      <section aria-label="Post" className="min-w-0 flex-1">
        {card.kind === "none" && <p className="text-sm text-[#5b6b82]">Choose a post to see what it needs and what is on record for you.</p>}
        {card.kind === "loading" && <p className="text-sm text-[#5b6b82]">Checking what is on record…</p>}
        {card.kind === "failed" && <Failed message={card.message} onRetry={props.onRetry} />}
        {card.kind === "loaded" && <Card {...props} shown={card.value} />}
      </section>
    </div>
  );
}

function Card(props: BoardPanelViewProps & { shown: OpenWorkCard }) {
  const c = props.shown;
  const answered = presentResponse(props.myResponse);
  return (
    <article className="rounded-2xl border border-[#dfe5ee] bg-white p-4">
      <h3 className="text-lg font-semibold">{c.title}</h3>
      <ul className="mt-1 text-sm text-[#394b63]">{c.facts.map(f => <li key={f}>{f}</li>)}</ul>
      <h4 className="mt-3 text-sm font-medium">Requirements</h4>
      <ul className="mt-1 space-y-1 text-sm">
        {c.requirements.map(r => (
          <li key={r.label} className="flex gap-2">
            <span aria-hidden="true" className="w-4 text-center font-semibold">{MARK_GLYPH[r.mark]}</span>
            <span>{r.label} <span className="sr-only">— {MARK_WORDS[r.mark]}</span>{r.detail && <span className="text-[#5b6b82]"> — {r.detail}</span>}</span>
          </li>
        ))}
      </ul>
      <p className={`mt-3 inline-block rounded-full px-3 py-1 text-xs ${TONE[c.verdict.tone]}`}>{c.verdict.label}</p>
      <p className="mt-2 text-xs text-[#5b6b82]">{c.availability}</p>
      {c.offer && (
        <div className="mt-3 rounded-lg bg-[#f4f7fc] p-3 text-sm">
          <p>{c.offer.label}</p>
          {c.offer.answerable && (
            <div className="mt-2 flex gap-2">
              <button onClick={() => props.onAnswerOffer(c.offer!.offerRef, "accepted")} disabled={!props.online || props.offerAnswer.kind === "pending"} className="min-h-[44px] rounded-lg bg-[#132a4a] px-3 py-1 text-white disabled:opacity-50">Accept offer</button>
              <button onClick={() => props.onAnswerOffer(c.offer!.offerRef, "declined")} disabled={!props.online || props.offerAnswer.kind === "pending"} className="min-h-[44px] rounded-lg bg-[#eef2f7] px-3 py-1 disabled:opacity-50">Decline offer</button>
            </div>
          )}
          {c.offer.answerable && !props.online && <p className="mt-1 text-xs text-[#5b6b82]">Answering an offer needs a connection.</p>}
          {props.offerAnswer.kind === "failed" && <p role="alert" className="mt-1 text-xs text-[#b42318]">{props.offerAnswer.message}</p>}
        </div>
      )}
      {answered && <p className="mt-3 text-sm text-[#1e6b3a]">{answered}.</p>}
      {props.pendingResponse && (
        <p className="mt-2 text-xs">Your answer ({props.pendingResponse.response.replace(/_/g, " ")}): <SendBadge state={props.pendingResponse.state} />
          {props.pendingResponse.lastError && <span className="ml-1 text-[#b42318]">{props.pendingResponse.lastError}</span>}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => props.onRespond(c.postRef, "interested")} disabled={!c.canRespond} className="min-h-[44px] rounded-lg bg-[#132a4a] px-3 py-1.5 text-sm text-white disabled:opacity-50">Interested</button>
        <button onClick={() => props.onRespond(c.postRef, "available")} disabled={!c.canRespond} className="min-h-[44px] rounded-lg bg-[#eef2f7] px-3 py-1.5 text-sm disabled:opacity-50">Available</button>
        <button onClick={() => props.onRespond(c.postRef, "declined")} disabled={!c.canDecline} className="min-h-[44px] rounded-lg bg-[#eef2f7] px-3 py-1.5 text-sm disabled:opacity-50">Decline</button>
      </div>
      {c.actionNote && <p className="mt-2 text-xs text-[#5b6b82]">{c.actionNote}</p>}
      <p className="mt-2 text-xs text-[#5b6b82]">Answering records what you would take. Dispatch gives the work, and the readiness check runs then.</p>
    </article>
  );
}

export function BoardPanelView(props: BoardPanelViewProps) {
  const channels = props.channels.kind === "loaded" ? props.channels.value : [];
  return (
    <section className="rounded-2xl border border-[#dfe5ee] bg-white p-4" aria-label="Board">
      {!props.online && (
        <p role="status" className="mb-3 rounded-lg bg-[#eef2f7] p-2 text-sm text-[#394b63]">
          Offline — what you send is kept on this device and sent when a connection returns.
          {!props.durableQueue && " This browser keeps it only while this page is open."}
        </p>
      )}
      {props.writeNotice && (
        <p role="alert" className="mb-3 rounded-lg bg-[#fdecec] p-2 text-sm text-[#b42318]">Not kept: {props.writeNotice}</p>
      )}
      {(props.queueSummary.waiting > 0 || props.queueSummary.refused > 0) && (
        <p role="status" className="mb-3 text-xs text-[#5b6b82]">
          {props.queueSummary.waiting > 0 && `${props.queueSummary.waiting} waiting on this device. `}
          {props.queueSummary.refused > 0 && `${props.queueSummary.refused} refused by the server and kept. `}
          <button onClick={props.onRetry} className="min-h-[44px] inline-flex items-center underline">Send now</button>
        </p>
      )}
      <nav aria-label="Board sections" className="mb-4 flex flex-wrap gap-1">
        {BOARD_TABS.map(t => {
          const badge = tabBadge(t, channels);
          return (
            <button key={t} onClick={() => props.onTab(t)} aria-pressed={props.tab === t}
              className={`min-h-[44px] rounded-full px-3 py-1 text-sm ${props.tab === t ? "bg-[#132a4a] text-white" : "bg-[#eef2f7] text-[#172033]"}`}>
              {TAB_LABELS[t]}{badge > 0 && <span className="ml-1">· {badge}<span className="sr-only"> waiting for your acknowledgement</span></span>}
            </button>
          );
        })}
      </nav>
      {props.tab === "open_work" ? <OpenWork {...props} /> : (
        <div className="flex flex-col gap-4 md:flex-row">
          <section aria-label="Conversations" className="md:w-64">
            {props.channels.kind === "loading" && <p className="text-sm text-[#5b6b82]">Loading conversations…</p>}
            {props.channels.kind === "failed" && <Failed message={props.channels.message} onRetry={props.onRetry} />}
            {props.channels.kind === "loaded" && (props.visibleChannels.length === 0 ? <p className="text-sm text-[#5b6b82]">Nothing here.</p> : (
              <ul className="space-y-1">
                {props.visibleChannels.map(c => (
                  <li key={c.channelRef}>
                    <button onClick={() => props.onSelectChannel(c.channelRef)} aria-pressed={props.selectedChannel === c.channelRef}
                      className={`min-h-[44px] w-full rounded-lg px-3 py-2 text-left text-sm ${props.selectedChannel === c.channelRef ? "bg-[#f4f7fc] font-medium" : ""}`}>
                      {c.name}{c.unacknowledged > 0 && <span className="ml-1 text-[#b42318]">· {c.unacknowledged}<span className="sr-only"> waiting for your acknowledgement</span></span>}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          </section>
          <Conversation {...props} />
        </div>
      )}
    </section>
  );
}

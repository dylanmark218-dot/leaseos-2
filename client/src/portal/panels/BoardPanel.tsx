/**
 * 0205/0206 — the Board, the container.
 *
 * Reads come from the server: `board.mine` (the conversations this person may open),
 * `board.read` (one of them), `shifts.list` and `shifts.get` (open work, with the person's own
 * preview). Writes — a message, an acknowledgement, an answer to a post — go through the device's
 * board queue, never straight to the server, so the same code path works with and without signal
 * and nothing is shown as sent before the server answered.
 *
 * THE QUEUE. The native shell sets `window.leaseosRuntime.boardQueue` over its encrypted store.
 * Without the shell there is no durable store to hold it, so the browser fallback keeps the queue
 * in memory — the adapter this runtime has always used for exactly that — and the screen says the
 * queue lasts only while the page is open. It does not pretend to be the vault.
 *
 * Checkpoint 5 — the queue is opened for the signed-in person in the organization the session acts
 * for (`orgKey` from PortalShell's `portals.mine`, the person from `auth.me`) and closed when either is
 * missing. Opening restores what that person left waiting — queued stays queued, never "sent" — and
 * nobody else's captures are listed or sent. A write with no scope open is refused on screen.
 *
 * Answering an offer is the one write that goes straight to the server: an accepted offer is read
 * by a dispatcher deciding who gets the work, and one queued on a phone for hours is an answer
 * nobody can see. The button says it needs a connection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { BoardQueue, errorCode, NoScope, type BoardTransport, type ShiftResponse } from "@/runtime/boardQueue";
import { MemoryKeystore, MemoryStore, MemoryVault } from "@/runtime/adapters/memory";
import type { LocalCapture } from "@/runtime/contracts";
import { channelsForTab, presentOpenWork, type BoardTab } from "../boardModel";
import { BoardPanelView, type Loadable, type MessageRow, type WorkRow } from "./BoardPanelView";

type Runtime = { boardQueue?: BoardQueue };

let browserFallback: BoardQueue | null = null;

/*
 * The browser fallback outlives any one mount of the panel, so it cannot hold one mount's
 * mutations. It sends through whichever mount is current; with none mounted, a send has no answer
 * and the capture simply waits in the queue, which is the right outcome.
 */
const liveTransport: { current: BoardTransport | null } = { current: null };
const need = (): BoardTransport => {
  if (!liveTransport.current) throw new Error("The board is not open; kept on this device");
  return liveTransport.current;
};
const delegating: BoardTransport = {
  post: input => need().post(input),
  acknowledge: input => need().acknowledge(input),
  respond: input => need().respond(input),
};

function queueFor(): { queue: BoardQueue; durable: boolean } {
  const native = (globalThis as { leaseosRuntime?: Runtime }).leaseosRuntime?.boardQueue;
  if (native) return { queue: native, durable: true };
  if (!browserFallback) {
    const clock = { now: () => new Date() };
    const keystore = new MemoryKeystore(clock);
    browserFallback = new BoardQueue({
      store: new MemoryStore(), vault: new MemoryVault(keystore), clock,
      connectivity: { online: async () => (typeof navigator === "undefined" ? true : navigator.onLine) },
      transport: delegating,
    });
  }
  return { queue: browserFallback, durable: false };
}

const loadable = <T,>(q: { isPending: boolean; isError: boolean; error: { message: string } | null }, value: () => T): Loadable<T> =>
  q.isError ? { kind: "failed", message: q.error?.message ?? "Request failed" } : q.isPending ? { kind: "loading" } : { kind: "loaded", value: value() };

export function BoardPanel({ online, orgKey }: { online: boolean; orgKey: string | null }) {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<BoardTab>("inbox");
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedPost, setSelectedPost] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalCapture[]>([]);
  const [writeNotice, setWriteNotice] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState<string | null>(null);
  const [offerAnswer, setOfferAnswer] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string }>({ kind: "idle" });

  // The three writes the queue makes, as hooks, so the portal contract can see them.
  const postMessage = trpc.board.post.useMutation();
  const acknowledgeMessage = trpc.board.acknowledge.useMutation();
  const respondToPost = trpc.shifts.respond.useMutation();
  liveTransport.current = { post: postMessage.mutateAsync, acknowledge: acknowledgeMessage.mutateAsync, respond: respondToPost.mutateAsync };
  useEffect(() => () => { liveTransport.current = null; }, []);
  const { queue, durable } = useMemo(() => queueFor(), []);

  const me = trpc.auth.me.useQuery();
  const mine = trpc.board.mine.useQuery(undefined, { refetchInterval: 60_000 });
  const read = trpc.board.read.useQuery({ channelRef: selectedChannel ?? "" }, { enabled: !!selectedChannel });
  const work = trpc.shifts.list.useQuery({ includeInactive: false });
  const post = trpc.shifts.get.useQuery({ postRef: selectedPost ?? "" }, { enabled: !!selectedPost });

  const refreshLocal = useCallback(async () => setLocal(await queue.list()), [queue]);
  const flush = useCallback(async () => {
    await queue.flush();
    await refreshLocal();
    await Promise.all([utils.board.read.invalidate(), utils.board.mine.invalidate(), utils.shifts.list.invalidate(), utils.shifts.get.invalidate()]);
  }, [queue, refreshLocal, utils]);

  // Open the queue for this person in this organization — restoring what they left — or close it.
  const userId = me.data?.id ?? null;
  useEffect(() => {
    let live = true;
    void (async () => {
      if (orgKey && userId) await queue.open({ orgKey, userId });
      else await queue.close();
      if (!live) return;
      setScopeOpen(orgKey && userId ? `${orgKey}:${userId}` : null);
      await refreshLocal();
    })();
    return () => { live = false; };
  }, [queue, orgKey, userId, refreshLocal]);
  // Every time signal returns, and once the scope is open: send what is waiting.
  useEffect(() => { if (online && scopeOpen) void flush(); }, [online, scopeOpen, flush]);

  const enqueue = async (write: () => Promise<unknown>) => {
    try { await write(); setWriteNotice(null); } catch (e) { setWriteNotice(e instanceof NoScope ? e.message : "This device could not keep it; nothing was sent"); return; }
    await refreshLocal();
    if (online) await flush();
  };

  const answerOffer = trpc.shifts.offerRespond.useMutation({
    onMutate: () => setOfferAnswer({ kind: "pending" }),
    onSuccess: () => setOfferAnswer({ kind: "idle" }),
    onError: e => setOfferAnswer({ kind: "failed", message: errorCode(e) === "PRECONDITION_FAILED" ? e.message : `Not answered: ${e.message}` }),
    onSettled: () => { void utils.shifts.get.invalidate(); void utils.shifts.list.invalidate(); },
  });

  const channels = loadable(mine, () => mine.data!.channels.map(c => ({ channelRef: c.channelRef, type: c.type, name: c.name, unacknowledged: c.unacknowledged })));
  const visibleChannels = channels.kind === "loaded" ? channelsForTab(tab, channels.value) : [];

  const myId = userId;
  const pendingAckFor = (messageRef: string) => {
    const a = local.filter(c => c.kind === "board_acknowledgement" && c.fields.messageRef === messageRef).pop();
    return a && a.syncState !== "synchronized" ? a.syncState : null;
  };
  const serverRefs = new Set((read.data?.messages ?? []).map(m => m.messageRef));
  const messages: Loadable<MessageRow[]> | { kind: "none" } = !selectedChannel ? { kind: "none" } : loadable(read, () => read.data!.messages.map(m => ({
    messageRef: m.messageRef,
    authorLabel: m.authorUserId === myId ? "You" : m.authorStanding === "former" ? `${m.authorLabel} (former member)` : m.authorLabel,
    mine: m.authorUserId === myId,
    priority: m.priority,
    body: m.body,
    deviceCreatedAt: new Date(m.deviceCreatedAt),
    serverReceivedAt: m.serverReceivedAt ? new Date(m.serverReceivedAt) : null,
    requiresAcknowledgement: m.requiresAcknowledgement,
    acknowledgedByMe: m.acknowledgedByMe,
    pendingAcknowledgement: pendingAckFor(m.messageRef),
  })));
  // A message the server already returns is shown once, from the server; until then, from the device.
  const pendingMessages = local
    .filter(c => c.kind === "board_message" && c.fields.channelRef === selectedChannel && !(c.fields.serverRef && serverRefs.has(String(c.fields.serverRef))))
    .map(c => ({ localId: c.localId, body: String(c.fields.body ?? ""), state: c.syncState, lastError: c.lastError, capturedAt: new Date(c.capturedAt) }));

  const workRows = loadable(work, () => work.data!.posts.map((p): WorkRow => ({
    postRef: p.postRef, title: p.title, requiredRole: p.requiredRole, startsAt: new Date(p.startsAt),
    place: p.location ?? p.regionCode ?? "Location not given", overtime: p.overtime, myResponse: p.myResponse,
  })));

  const card = !selectedPost ? { kind: "none" as const } : loadable(post, () => presentOpenWork(
    {
      ...post.data!.post, startsAt: new Date(post.data!.post.startsAt), endsAt: new Date(post.data!.post.endsAt),
      requiredQualifications: post.data!.post.requiredQualifications, requiredEquipmentClass: post.data!.post.requiredEquipmentClass,
    },
    post.data!.me ? { ...post.data!.me } : null,
    post.data!.myOffer ? { offerRef: post.data!.myOffer.offerRef, status: post.data!.myOffer.status, expiresAt: post.data!.myOffer.expiresAt ? new Date(post.data!.myOffer.expiresAt) : null } : null,
  ));
  const myResponse = selectedPost ? (work.data?.posts.find(p => p.postRef === selectedPost)?.myResponse ?? null) : null;
  const lastResponse = local.filter(c => c.kind === "shift_response" && c.fields.postRef === selectedPost).pop();
  const pendingResponse = lastResponse && lastResponse.syncState !== "synchronized"
    ? { response: String(lastResponse.fields.response), state: lastResponse.syncState, lastError: lastResponse.lastError }
    : null;

  const queueSummary = {
    waiting: local.filter(c => c.syncState === "queued" || c.syncState === "syncing" || c.syncState === "saved_locally").length,
    refused: local.filter(c => c.syncState === "failed" || c.syncState === "conflict").length,
  };

  return (
    <BoardPanelView
      online={online}
      durableQueue={durable}
      tab={tab}
      onTab={t => { setTab(t); setSelectedChannel(null); }}
      channels={channels}
      visibleChannels={visibleChannels}
      selectedChannel={selectedChannel}
      onSelectChannel={setSelectedChannel}
      messages={messages}
      pendingMessages={pendingMessages}
      onSend={(body, priority) => { if (selectedChannel) void enqueue(() => queue.message({ channelRef: selectedChannel, body, priority })); }}
      onAcknowledge={messageRef => void enqueue(() => queue.acknowledge({ messageRef, channelRef: selectedChannel ?? undefined }))}
      work={workRows}
      selectedPost={selectedPost}
      onSelectPost={setSelectedPost}
      card={card}
      myResponse={myResponse}
      pendingResponse={pendingResponse}
      onRespond={(postRef, response: ShiftResponse) => void enqueue(() => queue.respond({ postRef, response }))}
      offerAnswer={offerAnswer}
      onAnswerOffer={(offerRef, decision) => answerOffer.mutate({ offerRef, decision })}
      queueSummary={queueSummary}
      writeNotice={writeNotice}
      onRetry={() => { void flush(); void mine.refetch(); void work.refetch(); if (selectedChannel) void read.refetch(); if (selectedPost) void post.refetch(); }}
    />
  );
}

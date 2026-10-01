/**
 * 0205/0206 — the board's offline queue: a message, an acknowledgement, a response to open work.
 *
 * Built on the outbox that already exists, not beside it: the same `LocalStore`, the same six
 * states, the same rule that nothing unaccepted is deleted. What differs is the channel. A board
 * capture is sent straight to its own procedure (`board.post`, `board.acknowledge`,
 * `shifts.respond`) with the capture's `localId` as the client mutation id — never packaged for
 * `sync.receivePackage`, which would make a conversation an evidence record.
 *
 * Three rules, each one a failure it prevents:
 *
 *   NOTHING IS SHOWN AS SENT BEFORE THE SERVER SAID SO. A capture is `synchronized` only from the
 *   server's own reply carrying its reference. Until then it is saved, queued or sending, and the
 *   screen says which. For a stop-work order, a tick that meant "on this tablet" is the lie that
 *   gets somebody hurt.
 *
 *   A RETRY IS THE SAME RECORD. The mutation id is the `localId`, fixed at capture. A send that
 *   reached the server and lost its reply is retried with the same id, and the server answers with
 *   what it already wrote. `requeue` is for "no answer"; `failed` is for "the server said no".
 *
 *   ACKNOWLEDGEMENTS GO FIRST. A safety acknowledgement queued behind forty chat messages is a
 *   supervisor chasing somebody who already said yes.
 *
 * Checkpoint 5 — whose queue it is, and what a restart finds.
 *
 *   SCOPED. Every capture is written under a scope — the organization key and the signed-in person —
 *   and is listed and sent only under that same scope. With no scope open (signed out, organization
 *   unsettled) the queue lists nothing, sends nothing and accepts nothing. Switching from
 *   organization A to B hides A's waiting messages and does not send them as B; signing out and in as
 *   somebody else shows that person none of the previous person's. The records are not deleted —
 *   nothing unaccepted ever is — they wait, encrypted where the store is, for their own scope.
 *
 *   HONEST AFTER A RESTART. `hydrate()` is the first thing a queue does under a scope. A capture
 *   found `syncing` was sent and never answered; it goes back to `queued` with that said, and the
 *   next flush resends it with the same mutation id, which the server answers with what it already
 *   wrote. Nothing is ever marked sent from the device's own records: `synchronized` comes only from
 *   a server reply. A refused capture keeps its refusal until somebody retries it.
 *
 *   NO BODIES IN ERRORS. `lastError` is shown on screen and may reach diagnostics. A transport error
 *   that echoes the text it failed to send is scrubbed before it is kept.
 *
 * Durability is the store's, not this class's: over the native encrypted store the queue survives a
 * restart; over the browser fallback's memory store it lasts as long as the page, and the screen says
 * so. This class behaves the same over both, which is what the restart tests exercise.
 */
import { Outbox } from "./outbox";
import { isDirectCapture, sameScope, type CaptureScope, type Clock, type Connectivity, type FileVault, type LocalCapture, type LocalStore } from "./contracts";

export type BoardPriority = "normal" | "important" | "urgent" | "emergency";
export type ShiftResponse = "interested" | "available" | "request_assignment" | "declined";

/** The three procedures, as the queue needs them. The container supplies them from the tRPC client. */
export interface BoardTransport {
  post(input: { channelRef: string; body: string; priority: BoardPriority; deviceCreatedAt: Date; deviceId: string; clientMutationId: string }): Promise<{ messageRef: string; replayed?: boolean }>;
  acknowledge(input: { messageRef: string; deviceAcknowledgedAt: Date }): Promise<{ state: string }>;
  respond(input: { postRef: string; response: ShiftResponse; note?: string; deviceCreatedAt: Date; deviceId: string; clientMutationId: string }): Promise<{ recorded: boolean; replayed?: boolean }>;
}

/** Codes a server uses to say no. Anything without one is a transport failure, and is retried. */
const REFUSALS = new Set(["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "PRECONDITION_FAILED", "PAYLOAD_TOO_LARGE", "UNPROCESSABLE_CONTENT"]);

/** The tRPC error code on an error, wherever the client put it; null when the server never answered. */
export function errorCode(e: unknown): string | null {
  const x = e as { data?: { code?: unknown } | null; code?: unknown } | null;
  const code = x?.data?.code ?? x?.code;
  return typeof code === "string" ? code : null;
}

const ORDER: Record<string, number> = { board_acknowledgement: 0, board_message: 1, shift_response: 2 };

export type FlushOutcome = { attempted: boolean; reason: string; sent: number; requeued: number; failed: number; conflicts: number };
export type HydrateOutcome = { restored: number; interrupted: number; refused: number };

/** What a capture found mid-send after a restart is told. */
export const INTERRUPTED = "Interrupted before the server answered — will be resent with the same id, and the server will not record it twice";

/** A queue with no scope open refuses to take anything: there is nobody to send it as. */
export class NoScope extends Error {
  constructor() { super("Not signed in to an organization on this device — nothing was kept"); this.name = "NoScope"; }
}

/** Keep an error message without the text it failed to send. */
function scrub(message: string, c: LocalCapture): string {
  const body = typeof c.fields.body === "string" ? c.fields.body.trim() : "";
  const out = body.length >= 3 ? message.split(body).join("[message text]") : message;
  return out.slice(0, 300);
}

export class BoardQueue {
  private outbox: Outbox;
  private flushing: Promise<FlushOutcome> | null = null;
  private current: CaptureScope | null = null;

  constructor(private deps: { store: LocalStore; vault: FileVault; clock: Clock; connectivity: Connectivity; transport: BoardTransport }) {
    this.outbox = new Outbox(deps.store, deps.vault, deps.clock);
  }

  /** The scope the queue is open under, or null. */
  scope(): CaptureScope | null { return this.current ? { ...this.current } : null; }

  /**
   * Open the queue for a person in an organization, and restore what they left waiting. Opening a
   * different scope closes the previous one first: its captures stay stored and stop being visible.
   */
  async open(scope: CaptureScope): Promise<HydrateOutcome> {
    if (!scope.orgKey || !Number.isInteger(scope.userId) || scope.userId <= 0) throw new Error("A queue scope names an organization and a signed-in person");
    if (!sameScope(this.current, scope)) {
      // Switch first, then let a running flush notice and stop: the previous scope's captures must
      // not go out under the new session.
      this.current = { orgKey: scope.orgKey, userId: scope.userId };
      if (this.flushing) await this.flushing.catch(() => undefined);
    }
    return this.hydrate();
  }

  /** Sign-out, or an organization that is not settled: list nothing, send nothing, take nothing. */
  async close(): Promise<void> {
    this.current = null;
    if (this.flushing) await this.flushing.catch(() => undefined);
  }

  /**
   * Restore honest states for this scope after a restart. `syncing` → `queued` with the reason;
   * a capture written but never queued (the app died between the two writes) → `queued`. Refused
   * and conflicting captures keep their reason. Nothing becomes `synchronized` here.
   */
  async hydrate(): Promise<HydrateOutcome> {
    const out: HydrateOutcome = { restored: 0, interrupted: 0, refused: 0 };
    for (const c of await this.mine()) {
      if (c.syncState === "syncing") { await this.outbox.requeue(c.localId, INTERRUPTED); out.interrupted++; out.restored++; }
      else if (c.syncState === "saved_locally") { await this.outbox.queue(c.localId); out.restored++; }
      else if (c.syncState === "queued") out.restored++;
      else if (c.syncState === "failed" || c.syncState === "conflict") out.refused++;
    }
    return out;
  }

  /** Retry one refused or conflicting capture, by the person who wrote it. */
  async retry(localId: string): Promise<LocalCapture> {
    const c = (await this.mine()).find(x => x.localId === localId);
    if (!c) throw new Error("No such capture waiting on this device");
    if (c.syncState === "conflict") {
      // The outbox moves a conflict back only through failed; the reason stays until the resend answers.
      await this.outbox.markFailed(c.localId, c.lastError ?? "Conflict");
    }
    return this.outbox.queue(c.localId);
  }

  private async mine(): Promise<LocalCapture[]> {
    const scope = this.current;
    if (!scope) return [];
    return (await this.deps.store.listCaptures()).filter(c => isDirectCapture(c.kind) && sameScope(c.scope, scope));
  }

  private async write(draft: Parameters<Outbox["saveDraft"]>[0]): Promise<LocalCapture> {
    const scope = this.current;
    if (!scope) throw new NoScope();
    const c = await this.outbox.saveDraft(draft);
    // Scoped before it is queued: a capture that crashed between the two writes is unscoped, and an
    // unscoped capture is never listed or sent — the safe way for that to fail.
    c.scope = { ...scope };
    await this.deps.store.putCapture(c);
    return this.outbox.queue(c.localId);
  }

  /**
   * The device identity the server keys a retry on. The enrolled device reference when there is
   * one; otherwise a local id minted once and kept, which says "this browser" and nothing more.
   */
  async deviceId(): Promise<string> {
    const enrolled = await this.deps.store.getMeta("deviceRef");
    if (enrolled) return enrolled;
    const local = await this.deps.store.getMeta("boardDeviceId");
    if (local) return local;
    const minted = `WEB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await this.deps.store.setMeta("boardDeviceId", minted);
    return minted;
  }

  /** Compose a message. Saved and queued at once: a message is complete when it is written. */
  async message(args: { channelRef: string; body: string; priority?: BoardPriority }): Promise<LocalCapture> {
    return this.write({ kind: "board_message", formKey: null, title: "Message", category: "board", fields: { channelRef: args.channelRef, body: args.body, priority: args.priority ?? "normal" } });
  }

  /** Acknowledge a bulletin. The device's clock travels with it; the server keeps its own beside it. */
  async acknowledge(args: { messageRef: string; channelRef?: string }): Promise<LocalCapture> {
    return this.write({ kind: "board_acknowledgement", formKey: null, title: "Acknowledgement", category: "board", fields: { messageRef: args.messageRef, channelRef: args.channelRef ?? null } });
  }

  /** Answer an open-work post. Assigns nothing, here or on the server. */
  async respond(args: { postRef: string; response: ShiftResponse; note?: string }): Promise<LocalCapture> {
    return this.write({ kind: "shift_response", formKey: null, title: "Response", category: "open_work", fields: { postRef: args.postRef, response: args.response, note: args.note ?? null } });
  }

  /** This scope's board captures on this device, oldest first, whatever their state. Nobody else's. */
  async list(): Promise<LocalCapture[]> {
    return (await this.mine()).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.localId.localeCompare(b.localId));
  }

  /**
   * Send what is waiting. One flush at a time: a second call while one runs waits for it rather
   * than sending the same capture twice in parallel. `syncing` is included — a capture left there
   * by a crash was sent and never answered, which the same mutation id resolves.
   */
  flush(): Promise<FlushOutcome> {
    if (!this.flushing) this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushOnce(): Promise<FlushOutcome> {
    const out: FlushOutcome = { attempted: false, reason: "", sent: 0, requeued: 0, failed: 0, conflicts: 0 };
    const scope = this.current;
    if (!scope) return { ...out, reason: "Not signed in to an organization — nothing is sent" };
    if (!(await this.deps.connectivity.online())) return { ...out, reason: "Offline — kept on this device and sent when a connection returns" };
    const waiting = (await this.deps.store.listCaptures({ syncState: ["queued", "syncing"] }))
      .filter(c => isDirectCapture(c.kind) && sameScope(c.scope, scope))
      .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || a.capturedAt.localeCompare(b.capturedAt) || a.localId.localeCompare(b.localId));
    if (!waiting.length) return { ...out, reason: "Nothing waiting" };
    out.attempted = true;
    const deviceId = await this.deviceId();

    for (const c of waiting) {
      // Signed out or switched organization mid-flush: stop. What is left waits for its own scope.
      if (!sameScope(this.current, scope)) break;
      if (c.syncState === "queued") await this.outbox.markSyncing(c.localId, `direct:${c.kind}`);
      try {
        const serverRef = await this.send(c, deviceId);
        await this.outbox.setServerRef(c.localId, serverRef);
        await this.outbox.markSynchronized(c.localId);
        out.sent++;
      } catch (e) {
        const code = errorCode(e);
        const message = scrub((e as Error)?.message ?? String(e), c);
        if (code === "CONFLICT") { await this.outbox.markConflict(c.localId, message); out.conflicts++; }
        else if (code && REFUSALS.has(code)) { await this.outbox.markFailed(c.localId, `${code}: ${message}`); out.failed++; }
        else {
          // No answer: the connection dropped, or the server faulted. Retried with the same id.
          await this.outbox.requeue(c.localId, message);
          out.requeued++;
          // The link is down; the rest would fail the same way and each would count an attempt.
          break;
        }
      }
    }
    out.reason = `${out.sent} sent${out.requeued ? `, ${out.requeued} waiting for a connection` : ""}${out.failed ? `, ${out.failed} refused and kept` : ""}${out.conflicts ? `, ${out.conflicts} need attention` : ""}`;
    return out;
  }

  private async send(c: LocalCapture, deviceId: string): Promise<string> {
    const f = c.fields as Record<string, unknown>;
    const at = new Date(c.capturedAt);
    switch (c.kind) {
      case "board_message": {
        const r = await this.deps.transport.post({ channelRef: String(f.channelRef), body: String(f.body), priority: (f.priority as BoardPriority) ?? "normal", deviceCreatedAt: at, deviceId, clientMutationId: c.localId });
        return r.messageRef;
      }
      case "board_acknowledgement": {
        await this.deps.transport.acknowledge({ messageRef: String(f.messageRef), deviceAcknowledgedAt: at });
        return String(f.messageRef);
      }
      case "shift_response": {
        await this.deps.transport.respond({ postRef: String(f.postRef), response: f.response as ShiftResponse, ...(f.note ? { note: String(f.note) } : {}), deviceCreatedAt: at, deviceId, clientMutationId: c.localId });
        return String(f.postRef);
      }
      default:
        throw new Error(`${c.kind} is not a board capture`);
    }
  }
}

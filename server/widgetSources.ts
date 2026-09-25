/**
 * B28 — the tile reader: one read per tile, bound to the real procedures.
 *
 * Every read goes through `appRouter.createCaller` as the acting user, so each
 * tile is authorized and audited by the procedure it names — the board itself
 * audits only that a person opened it (see `BoardAudit`).
 *
 * PROMOTION IS PER WIDGET. A widget whose source has not been promoted on this
 * branch answers `unknown` with the reason on its face. It does not answer with
 * an empty list, a zero, or a guess. (`myDay` is promoted first because it is
 * self-scoped, wired, and depends on no regulatory figure.)
 */
import { asClaimVerification, complianceDocumentValidity } from "./_core/complianceDocumentValidity";
import type { ValidityState } from "./_core/documentValidity";
import type { TileReader } from "./_core/widgetService";
import type { RoleActor } from "./_core/roleActor";
import type { WidgetPayload } from "./_core/widgetPayload";
import { operatorIdFromRecord, type OperatorId, type OperatorResolution } from "./_core/operatorIdentity";

const NOT_PROMOTED = (widgetKey: string): WidgetPayload<unknown> => ({
  state: "unknown",
  reason: `${widgetKey} is not promoted on this branch yet (Remaining Build Register P0.5, step 6); its source procedure is mapped but no reader has been written for it`,
});

type JobRow = { id: number; jobCode: string; status?: string | null };
type TripRow = { id: number; tripNumber: string; jobId: number | null; unitId: number | null; operatorId: number | null; status?: string | null };
type DocRow = { id: number; ownerType: string; ownerId: number; docType: string; title: string | null; expiresAt: Date | string | null; verificationStatus: string | null };
type Caller = {
  surfaces: {
    myDay: () => Promise<unknown>;
    inbox: () => Promise<unknown>;
    exceptions: (input: { category?: string; limit: number }) => Promise<unknown>;
  };
  hos: { status: (input: { operatorId: OperatorId; lookbackDays: number; at: Date }) => Promise<unknown> };
  /** The legacy FieldRoute lists live under fieldRoute.*; their procedure names are jobs.list / trips.list / documents.list. */
  fieldRoute: {
    jobs: { list: () => Promise<readonly JobRow[]> };
    trips: { list: () => Promise<readonly TripRow[]> };
    identity: { documents: { list: () => Promise<readonly DocRow[]> } };
  };
};
type Readiness = (subject: { operatorId: OperatorId; unitId: number | null; trailerId: number | null; jobId: number | null }) => Promise<unknown>;

/** A subject reference is a string the client chose; it is matched, never trusted as an id. */
const byRef = <T extends { id: number }>(rows: readonly T[], ref: string, code: (r: T) => string | null | undefined) =>
  rows.find(r => code(r) === ref || String(r.id) === ref) ?? null;
const numericRef = (ref: string | null): number | null => ref && /^\d{1,10}$/.test(ref) ? Number(ref) : null;

/** The records vault's words for the engine's states. Presentation only; the decision is the engine's. */
const VAULT_WORD: Readonly<Record<ValidityState, "current" | "expiring" | "expired" | "unverified" | "rejected" | "missing">> = {
  in_force: "current", expiring: "expiring", expired: "expired", unverified: "unverified", rejected: "rejected", none: "missing",
};

/**
 * Document expiry states, as the records vault names them; the tile shows the state, not a number.
 * C1b-3: decided by `complianceDocumentValidity` for this one row, then worded for the vault.
 */
export function expiryState(doc: DocRow, now: Date, warnDays: number): "current" | "expiring" | "expired" | "unverified" | "rejected" | "missing" {
  const claim = { docType: doc.docType, expiresAt: doc.expiresAt == null ? null : new Date(doc.expiresAt), verificationStatus: asClaimVerification(doc.verificationStatus) };
  return VAULT_WORD[complianceDocumentValidity([claim], doc.docType, now, warnDays).state];
}

const SYSTEM = () => ({ source: "system_inferred" as const, verification: "unverified" as const, exact: true, observedAt: new Date() });
const failed = (what: string, e: unknown): WidgetPayload<unknown> =>
  ({ state: "failed", reason: e instanceof Error ? `${what}: ${e.message}` : `${what} could not be read` });
const intOption = (options: Readonly<Record<string, unknown>> | null, key: string, fallback: number, min: number, max: number) => {
  const v = options?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
};

/**
 * The self-scoped tiles (hosRemaining, documentExpiry, unitReadiness) are about the caller as an
 * operator, so they need the caller's operator id — which is not their user id (see
 * `_core/operatorIdentity`). `operatorOf` resolves it through `operators.userId` in the acting
 * scope; it is asked at most once per board, and only if one of those tiles is on it. No record,
 * or more than one, and those tiles say `unknown` — they never fall back to the user id.
 */
export function widgetReaderFor(actor: RoleActor, callerFor: (userId: number) => Caller, operatorOf: () => Promise<OperatorResolution>, readiness?: Readiness): TileReader {
  const caller = callerFor(actor.userId);
  let resolution: Promise<OperatorResolution> | null = null;
  const self = async (): Promise<{ ok: true; operatorId: OperatorId } | { ok: false; payload: WidgetPayload<unknown> }> => {
    const r = await (resolution ??= operatorOf());
    if (r.kind === "resolved") return { ok: true, operatorId: r.operatorId };
    return {
      ok: false,
      payload: {
        state: "unknown",
        reason: r.kind === "none"
          ? "this person has no operator record in the acting organization"
          : "more than one operator record names this person in the acting organization; which one is theirs is not decided here",
      },
    };
  };
  return async (task) => {
    if (task.deviceLocal) {
      return { state: "unknown", reason: "device-local tile: the field runtime resolves this on the device, never the server" };
    }
    switch (task.widgetKey) {
      case "myDay": {
        try {
          const value = await caller.surfaces.myDay();
          return {
            state: "ok", value,
            provenance: { source: "system_inferred", verification: "unverified", exact: true, observedAt: new Date() },
            deepLink: { portal: "driver", route: "/portal/driver" },
          };
        } catch (e) {
          return { state: "failed", reason: e instanceof Error ? e.message : "My Day could not be read" };
        }
      }
      /* Promoted one per commit, in the locked order. Each reads as the acting user through its own procedure. */
      case "inbox": {
        try { return { state: "ok", value: await caller.surfaces.inbox(), provenance: SYSTEM(), deepLink: { portal: "office", route: "/portal/office" } }; }
        catch (e) { return failed("Inbox", e); }
      }
      case "exceptions": {
        try {
          const limit = intOption(task.options, "limit", 10, 3, 50);
          const severity = task.options?.["severity"];
          const value = await caller.surfaces.exceptions(severity === "blocking" ? { category: "blocking", limit } : { limit });
          return { state: "ok", value, provenance: SYSTEM(), deepLink: { portal: "office", route: "/portal/office" } };
        } catch (e) { return failed("Exceptions", e); }
      }
      case "hosRemaining": {
        // Reached only when the planner does not mark the tile device-local (a
        // driver's own board resolves HOS on the tablet from cached duty status).
        // The HOS engine's own states pass through untouched: every figure on the
        // branch is an unverified candidate until a person promotes one (P9), and
        // the tile shows exactly that — it never rounds UNKNOWN to a number.
        try {
          const me = await self();
          if (!me.ok) return me.payload;
          const value = await caller.hos.status({ operatorId: me.operatorId, lookbackDays: 16, at: new Date() });
          return { state: "ok", value, provenance: { ...SYSTEM(), exact: false }, deepLink: { portal: "driver", route: "/portal/driver" } };
        } catch (e) { return failed("Hours of service", e); }
      }
      /* ---- step 7: the resolved sources, read through the procedures whose permissions govern them ---- */
      case "activeJob": {
        if (!task.subjectRef) return { state: "unknown", reason: "no job selected for this tile" };
        try {
          const job = byRef(await caller.fieldRoute.jobs.list(), task.subjectRef, j => j.jobCode);
          return job
            ? { state: "ok", value: job, provenance: SYSTEM(), deepLink: { portal: "office", route: `/portal/office?job=${encodeURIComponent(job.jobCode)}` } }
            : { state: "unknown", reason: `no job matches ${task.subjectRef} among the jobs this person may read` };
        } catch (e) { return failed("Active job", e); }
      }
      case "activeTrip": {
        if (!task.subjectRef) return { state: "unknown", reason: "no trip selected for this tile" };
        try {
          const trip = byRef(await caller.fieldRoute.trips.list(), task.subjectRef, t => t.tripNumber);
          return trip
            ? { state: "ok", value: trip, provenance: SYSTEM(), deepLink: { portal: "driver", route: `/portal/driver?trip=${encodeURIComponent(trip.tripNumber)}` } }
            : { state: "unknown", reason: `no trip matches ${task.subjectRef} among the trips this person may read` };
        } catch (e) { return failed("Active trip", e); }
      }
      case "documentExpiry": {
        // Self-scoped: this operator's own documents, in the vault's own states.
        try {
          const me = await self();
          if (!me.ok) return me.payload;
          const now = new Date();
          const warnDays = intOption(task.options, "warnDays", 30, 1, 180);
          const limit = intOption(task.options, "limit", 8, 3, 30);
          const mine = (await caller.fieldRoute.identity.documents.list()).filter(d => d.ownerType === "operator" && d.ownerId === me.operatorId);
          const rows = mine.map(d => ({ id: d.id, docType: d.docType, title: d.title, expiresAt: d.expiresAt, state: expiryState(d, now, warnDays) }))
            .sort((a, b) => (a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity) - (b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity))
            .slice(0, limit);
          return { state: "ok", value: { warnDays, documents: rows, total: mine.length }, provenance: SYSTEM(), deepLink: { portal: "driver", route: "/portal/driver" } };
        } catch (e) { return failed("Document expiry", e); }
      }
      case "unitReadiness": {
        // Readiness of this operator with the selected unit, composed by the same
        // composer dispatch uses. Authorized by readiness.read (the widget's procedure).
        const unitId = numericRef(task.subjectRef);
        if (!unitId) return { state: "unknown", reason: task.subjectRef ? `unit reference ${task.subjectRef} is not a unit id` : "no unit selected for this tile" };
        if (!readiness) return { state: "unknown", reason: "readiness composer not bound to this board" };
        try {
          const me = await self();
          if (!me.ok) return me.payload;
          const r = await readiness({ operatorId: me.operatorId, unitId, trailerId: null, jobId: null });
          return { state: "ok", value: r, provenance: SYSTEM(), deepLink: { portal: "office", route: `/portal/office?unit=${unitId}` } };
        } catch (e) { return failed("Unit readiness", e); }
      }
      case "dispatchReadiness": {
        // Job-scoped: the operator and unit come from the job's dispatched trip,
        // never from the tile. No trip with both means no readiness answer.
        if (!task.subjectRef) return { state: "unknown", reason: "no job selected for this tile" };
        if (!readiness) return { state: "unknown", reason: "readiness composer not bound to this board" };
        try {
          const job = byRef(await caller.fieldRoute.jobs.list(), task.subjectRef, j => j.jobCode);
          if (!job) return { state: "unknown", reason: `no job matches ${task.subjectRef} among the jobs this person may read` };
          const trip = (await caller.fieldRoute.trips.list()).filter(t => t.jobId === job.id && t.operatorId && t.unitId).sort((a, b) => b.id - a.id)[0];
          if (!trip) return { state: "unknown", reason: `job ${job.jobCode} has no dispatched trip with an operator and a unit` };
          const r = await readiness({ operatorId: operatorIdFromRecord(trip.operatorId!), unitId: trip.unitId, trailerId: null, jobId: job.id });
          return { state: "ok", value: { jobCode: job.jobCode, tripNumber: trip.tripNumber, readiness: r }, provenance: SYSTEM(), deepLink: { portal: "office", route: `/portal/office?job=${encodeURIComponent(job.jobCode)}` } };
        } catch (e) { return failed("Dispatch readiness", e); }
      }
      case "search":
      case "trackingLookup":
        // On demand: the tile carries no query in its options (see the registry),
        // so there is nothing to read until a person types one. The client asks
        // surfaces.search / surfaces.timeline directly at that moment.
        return { state: "unknown", reason: `${task.widgetKey === "search" ? "type a query" : "enter a tracking number"} in the tile; results are read on demand` };
      case "syncStatus":
        // Device-local, by the registry's own offline classification. The queue lives on the device,
        // so the server cannot answer this and must not appear to: no count, no "failed", no
        // borrowed number from a push endpoint. The tile reads `Outbox.status()` itself. The
        // registry's `procedure: "sync.receivePackage"` is there because the type demands a
        // procedure name, and the permission it lends (`sync.push_own`) governs pushing, not
        // reading your own queue — see docs/b28/... and server/_core/widgetSourceContract.ts, which
        // splits the three questions the one field conflates. Naming it here beats a server reader
        // that would have to invent the answer.
        return { state: "unknown", reason: "the sync queue is on this device; the tile reads it locally and the server has no view of it" };
      default:
        return NOT_PROMOTED(task.widgetKey);
    }
  };
}

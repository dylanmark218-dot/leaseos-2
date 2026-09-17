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
import type { TileReader } from "./_core/widgetService";
import type { RoleActor } from "./_core/roleActor";
import type { WidgetPayload } from "./_core/widgetPayload";

const NOT_PROMOTED = (widgetKey: string): WidgetPayload<unknown> => ({
  state: "unknown",
  reason: `${widgetKey} is not promoted on this branch yet (Remaining Build Register P0.5, step 6); its source procedure is mapped but no reader has been written for it`,
});

type Caller = {
  surfaces: {
    myDay: () => Promise<unknown>;
    inbox: () => Promise<unknown>;
    exceptions: (input: { category?: string; limit: number }) => Promise<unknown>;
  };
  hos: { status: (input: { operatorId: number; lookbackDays: number; at: Date }) => Promise<unknown> };
};

const SYSTEM = () => ({ source: "system_inferred" as const, verification: "unverified" as const, exact: true, observedAt: new Date() });
const failed = (what: string, e: unknown): WidgetPayload<unknown> =>
  ({ state: "failed", reason: e instanceof Error ? `${what}: ${e.message}` : `${what} could not be read` });
const intOption = (options: Readonly<Record<string, unknown>> | null, key: string, fallback: number, min: number, max: number) => {
  const v = options?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
};

export function widgetReaderFor(actor: RoleActor, callerFor: (userId: number) => Caller): TileReader {
  const caller = callerFor(actor.userId);
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
          const value = await caller.hos.status({ operatorId: actor.userId, lookbackDays: 16, at: new Date() });
          return { state: "ok", value, provenance: { ...SYSTEM(), exact: false }, deepLink: { portal: "driver", route: "/portal/driver" } };
        } catch (e) { return failed("Hours of service", e); }
      }
      default:
        return NOT_PROMOTED(task.widgetKey);
    }
  };
}

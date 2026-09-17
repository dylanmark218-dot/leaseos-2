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

type Caller = { surfaces: { myDay: () => Promise<unknown> } };

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
      default:
        return NOT_PROMOTED(task.widgetKey);
    }
  };
}

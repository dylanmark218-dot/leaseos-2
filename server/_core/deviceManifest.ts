/**
 * B25 — what the server tells a device to work out for itself.
 *
 * Pure. No network.
 *
 * A truck in a coulee cannot call `boardResolve`, and the two tiles a driver
 * most needs there — hours remaining and whether their paperwork has left the
 * device — are exactly the two the server cannot answer without the device's
 * own log. So the device computes them. That is a real transfer of work, and it
 * must not become a transfer of authority.
 *
 * The shape that keeps those separate: **authorization happens before a task is
 * emitted.** `planBoard` has already checked the acting role's permission for
 * every tile; a task only exists for one that passed. The manifest therefore
 * carries no permission, no procedure name and no scope — nothing the client
 * could reinterpret in its own favour, because there is nothing left to
 * interpret. A client that fabricates a task gets a tile with no server
 * counterpart, and every action behind it still runs its own gate.
 *
 * What the manifest does carry is a **contract version**. Deployed clients
 * outlive server deploys — a phone in a truck may not open the app store for a
 * month — so the server must be able to look at a client's version and refuse
 * to hand it a task shape it cannot read safely. TypeScript cannot enforce
 * anything across that gap.
 */

import type { ResolvePlan, ResolveTask } from "./widgetDashboard";
import type { RoleActor } from "./roleActor";

/**
 * The device-local contract version.
 *
 * Bump on any change to `DeviceWidgetTask` or to what a resolver is expected to
 * do with it. The rule below is deliberately blunt: same major, or no task.
 */
export const WIDGET_RUNTIME_VERSION = 1 as const;

/**
 * What kind of local source answers this task.
 *
 * A type, not a procedure name. The client maps it to one of its own resolvers,
 * so the manifest never names anything server-side that a client could try to
 * call, and an unknown type is a tile the client declines rather than guesses.
 */
export type DeviceSourceType = "hos_log" | "sync_queue" | "trip_state";

/** Which local source each device-local widget uses. Server-side mapping. */
const DEVICE_SOURCES: Readonly<Record<string, DeviceSourceType>> = {
  hosRemaining: "hos_log",
  syncStatus: "sync_queue",
  activeTrip: "trip_state",
};

export type DeviceWidgetTask = {
  instanceRef: string;
  widgetKey: string;
  variant: string;
  sourceType: DeviceSourceType;
  /** Validated options only — integers, enumerations, booleans. Never free text. */
  options: Readonly<Record<string, unknown>> | null;
  subjectRef: string | null;
  /** Freshness budget for the local answer, when the widget declares one. */
  maxStaleMinutes: number | null;
  /** The contract this task is written against. */
  runtimeVersion: number;
};

export type DeviceManifest = {
  runtimeVersion: number;
  /** Bound to the actor so a cached manifest cannot be replayed as someone else. */
  userId: number;
  roleKey: string;
  orgRef: string;
  issuedAt: Date;
  tasks: readonly DeviceWidgetTask[];
  /**
   * Device-local tiles that were authorized but could not be issued, and why.
   *
   * Listed rather than dropped, same rule as a withheld tile: a client that
   * receives eight tasks and knows nothing of the ninth will render a gap.
   */
  declined: readonly { instanceRef: string; widgetKey: string; reason: string }[];
};

export type ManifestRefusal = { code: "CLIENT_TOO_OLD" | "CLIENT_TOO_NEW"; detail: string };

export type ManifestResult =
  | { ok: true; manifest: DeviceManifest }
  | { ok: false; refusal: ManifestRefusal };

/**
 * Build the manifest for an already-planned, already-authorized board.
 *
 * Takes the plan rather than the layout, so there is no path to a task for a
 * tile that failed authorization: withheld tiles are in `plan.settled`, and
 * this function only reads `plan.tasks`.
 */
export function buildDeviceManifest(
  plan: ResolvePlan,
  actor: RoleActor,
  clientRuntimeVersion: number,
  now: Date = new Date(),
): ManifestResult {
  if (!Number.isInteger(clientRuntimeVersion) || clientRuntimeVersion < WIDGET_RUNTIME_VERSION) {
    // Degrade to nothing rather than to something the client will misread. The
    // board still works: these tiles resolve server-side while online, and read
    // as unavailable offline, which is true for that client.
    return {
      ok: false,
      refusal: {
        code: "CLIENT_TOO_OLD",
        detail: `this client speaks widget runtime ${clientRuntimeVersion}; the server issues ${WIDGET_RUNTIME_VERSION}`,
      },
    };
  }
  if (clientRuntimeVersion > WIDGET_RUNTIME_VERSION) {
    return {
      ok: false,
      refusal: {
        code: "CLIENT_TOO_NEW",
        detail: `this client speaks widget runtime ${clientRuntimeVersion}; the server issues ${WIDGET_RUNTIME_VERSION}`,
      },
    };
  }

  const tasks: DeviceWidgetTask[] = [];
  const declined: { instanceRef: string; widgetKey: string; reason: string }[] = [];

  for (const task of plan.tasks) {
    if (!task.deviceLocal) continue;

    const sourceType = DEVICE_SOURCES[task.widgetKey];
    if (!sourceType) {
      // The registry says device-local and nothing here knows how. A wiring
      // gap, named rather than silently issued as a server-only tile.
      declined.push({
        instanceRef: task.instanceRef, widgetKey: task.widgetKey,
        reason: `no local source is mapped for "${task.widgetKey}"`,
      });
      continue;
    }

    tasks.push({
      instanceRef: task.instanceRef,
      widgetKey: task.widgetKey,
      variant: task.variant,
      sourceType,
      options: task.options,
      subjectRef: task.subjectRef,
      maxStaleMinutes: task.maxStaleMinutes,
      runtimeVersion: WIDGET_RUNTIME_VERSION,
    });
  }

  return {
    ok: true,
    manifest: {
      runtimeVersion: WIDGET_RUNTIME_VERSION,
      userId: actor.userId, roleKey: actor.roleKey, orgRef: actor.tenantId,
      issuedAt: now, tasks, declined,
    },
  };
}

/**
 * Fields a manifest must never contain.
 *
 * Asserted by a test that walks the serialized manifest, because the leak this
 * guards against is the kind that arrives by someone adding a convenient field
 * to `DeviceWidgetTask` years from now.
 */
export const FORBIDDEN_MANIFEST_KEYS: readonly string[] = [
  "permission", "permissions", "procedure", "sql", "query", "token", "secret",
  "tenantId", "scope", "grants", "roles",
];

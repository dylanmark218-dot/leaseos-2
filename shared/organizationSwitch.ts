/**
 * What a device must do when the person switches acting organization.
 *
 * 0170 gave a genuinely multi-organization person a way to say which company
 * they are working for. On the server that is enough: `resolveActingScope`
 * re-reads the selection on every request, so the next query is already scoped
 * to the new organization and nothing is cached across it.
 *
 * A field device is the opposite of that. It is an offline-first store holding
 * captures, cached records, resolved permissions and a sync queue, all of it
 * built up under the OLD organization and none of it re-derived per request. So
 * the switch that costs the server nothing is, on the handset, the moment two
 * companies' material is closest to being mixed — and mixing it is precisely
 * what the invariant forbids: no caller may receive, infer, mutate, link or
 * SYNCHRONIZE another organization's data because two records share an
 * identifier or a device state.
 *
 * This module is the contract for that moment. It is pure and it decides
 * nothing about presentation: it takes the state the device is in and returns
 * the ordered steps, or the reason the switch cannot proceed. The runtime
 * executes the steps; the server tells it the facts.
 *
 * ## The rule
 *
 * **A device holds material for exactly one organization at a time.**
 *
 * Not "namespaced so both can coexist". The namespace exists underneath the
 * rule, not instead of it: it means a residue that survives an interrupted
 * purge — a power cut mid-switch, a killed process — can never be READ as the
 * new organization's, because it is filed under a key the new organization
 * never looks in. Defence in depth for a purge that is the actual mechanism.
 *
 * ## The one thing that stops a switch
 *
 * Unsent captures. A driver with twelve unsynchronized tickets who switches
 * company must not have them pushed into the new company's book, and must not
 * have them silently destroyed either — they are evidence, and this system's
 * standing rule is that evidence is retained, never deleted. There is no
 * correct automatic answer, so the switch is REFUSED while unsent work exists,
 * with the count and the organization it belongs to. That is the only case
 * where a person is asked anything, which is what "no unnecessary UI" leaves
 * room for: everything else happens without a dialog.
 *
 * ## Why re-enrolment can be required
 *
 * A device is bound to one organization by `fieldDevices.orgRef`, and since F6
 * the server's device lookup is scoped, so a device bound to A cannot activate,
 * rotate, revoke or sync while its holder acts as B — every one of those
 * answers NOT_FOUND. That is correct (a device is a piece of one company's
 * fleet) but it means a switch can leave the handset unable to sync at all. The
 * plan says so up front rather than letting it be discovered as a string of
 * unexplained not-founds.
 */

/** Where the device files everything it holds for one organization. */
export type SyncNamespace = string;

/**
 * The storage key prefix for an organization's material.
 *
 * `orgRef` is opaque to this function on purpose — it is not parsed, matched or
 * abbreviated, only prefixed — so a namespace can never collide with another by
 * being a prefix of it, and a caller cannot reach a different organization's
 * namespace by choosing a clever reference. The single tenant (no membership)
 * gets its own namespace like anybody else rather than the bare root, so
 * "unattributed" material is not what a fresh install reads by default.
 */
export function syncNamespace(orgRef: string | null): SyncNamespace {
  return orgRef === null ? "org:~unattributed" : `org:${orgRef}`;
}

export type DeviceSwitchState = {
  /** The organization the device's stored material belongs to; null on a fresh install. */
  holding: string | null;
  /** The organization being switched to. */
  target: string | null;
  /** The organization this device is enrolled in, from `fieldDevices.orgRef`; null if never enrolled or legacy. */
  deviceBoundTo: string | null;
  /** Captures on the device that the server has not accepted: queued, syncing, failed or in conflict. */
  unsentCaptures: number;
};

export type SwitchStep =
  /** Stop the sync engine before anything else, so nothing in flight lands under the new scope. */
  | { step: "halt_sync" }
  /** Forget resolved permissions and role answers; they were computed for the old organization. */
  | { step: "reload_permissions" }
  /** Drop every cached record, list and derived view built from the old organization's data. */
  | { step: "purge_tenant_cache"; of: SyncNamespace }
  /** Point the store at the new organization's namespace. */
  | { step: "switch_namespace"; from: SyncNamespace; to: SyncNamespace }
  /** This device cannot sync as the target organization until it is enrolled there. */
  | { step: "reenrol_device"; boundTo: string | null; requiredFor: string | null }
  /** Fetch the new organization's working set. */
  | { step: "resync" };

export type SwitchPlan =
  | { outcome: "no_change"; steps: [] }
  | { outcome: "blocked"; reason: string; unsentCaptures: number; belongingTo: string | null; steps: [] }
  | { outcome: "switch"; steps: SwitchStep[] };

/**
 * The ordered steps for this switch, or why it cannot happen.
 *
 * The order is load-bearing and is not the order the steps were listed in when
 * this was specified:
 *
 *   halt_sync           first, always. Every later step changes what a package
 *                       would be sent under, so a sync still running during any
 *                       of them is the exact accident being prevented.
 *   reload_permissions  before the purge, not after. Permissions decide what
 *                       the UI will even ask for; dropping the cache first
 *                       leaves a window where the old organization's answers
 *                       are used to request the new one's data.
 *   purge_tenant_cache  before the namespace moves, so it is unambiguous WHICH
 *                       namespace is being emptied. Purging after the switch
 *                       would name the new one and, on a retry, delete the
 *                       material just fetched.
 *   switch_namespace    now that the old one is empty.
 *   reenrol_device      only when the device is not bound to the target; it is
 *                       a statement of fact, and resync will fail until it is
 *                       done.
 *   resync              last, and only now is anything fetched.
 */
export function organizationSwitchPlan(state: DeviceSwitchState): SwitchPlan {
  if (state.holding === state.target) return { outcome: "no_change", steps: [] };

  /*
   * Refused while unsent work exists — before any step is emitted, so a caller
   * that ignores `outcome` and walks `steps` still does nothing. The captures
   * belong to `holding`: they were taken under it, and that is the only book
   * they may ever be sent to.
   */
  if (state.unsentCaptures > 0) {
    return {
      outcome: "blocked",
      reason: "Unsent captures belong to the organization they were taken under and cannot follow this device into another one. Synchronize them first, or have them released by someone who can.",
      unsentCaptures: state.unsentCaptures,
      belongingTo: state.holding,
      steps: [],
    };
  }

  const steps: SwitchStep[] = [
    { step: "halt_sync" },
    { step: "reload_permissions" },
    { step: "purge_tenant_cache", of: syncNamespace(state.holding) },
    { step: "switch_namespace", from: syncNamespace(state.holding), to: syncNamespace(state.target) },
  ];
  if (state.deviceBoundTo !== state.target) {
    steps.push({ step: "reenrol_device", boundTo: state.deviceBoundTo, requiredFor: state.target });
  }
  steps.push({ step: "resync" });
  return { outcome: "switch", steps };
}

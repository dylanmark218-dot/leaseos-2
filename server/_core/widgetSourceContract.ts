/**
 * B28C — three contracts B23 accidentally made one.
 *
 * DESIGN ONLY. Nothing imports this yet and the registry is unchanged; it
 * exists so the model can be argued about and tested before a migration that
 * touches twelve registrations and every test that reads them.
 *
 * B23 gave every widget a `procedure: ProcedureName` and derived its permission
 * from that name. For a server widget the three questions happen to share one
 * answer, so the conflation was invisible:
 *
 *   may this role see the widget?   → permissionForProcedure(procedure)
 *   where does the data come from?  → procedure
 *   where does the truth originate? → whatever the procedure calls
 *
 * `syncStatus` is where it breaks. It is device-local: the answer comes from
 * the device's own outbox, and the 0088 evidence contains no `sync.*` procedure
 * and no own-scoped permission anywhere in 62 procedures. `sync.status` exists
 * only because the registry type demanded one. A fabricated procedure name is
 * not a small untidiness — it is a name that will be searched for on the branch
 * and not found, and the natural response to that is to write it.
 *
 * So: authorization, data source and domain engine are separate fields. They
 * may still coincide, and for most server widgets they will.
 */

import type { ProcedureName } from "./recordsAuthorization";
import type { DeviceSourceType } from "./deviceManifest";

/**
 * What makes the widget offerable to the acting role.
 *
 * A device-local widget still has to be authorized — the question is only
 * whether the thing that authorizes it is the same thing that fetches it.
 *
 * `unresolved` is a legitimate value and the honest one for `syncStatus` today:
 * the 0088 snapshot does not show what governs "may this person see their own
 * device's sync state", and the candidates (a domain permission, a dedicated
 * widget permission, a static role policy, or no permission at all) are not
 * distinguishable from here.
 */
export type AuthorizationContract =
  | { kind: "procedure"; procedure: ProcedureName }
  | { kind: "permission"; permission: string; evidence: string }
  | { kind: "unresolved"; question: string };

/** Where the value is read. Not necessarily where it is authorized. */
export type DataSourceContract =
  | { kind: "server"; procedure: ProcedureName }
  | { kind: "device_local"; resolver: DeviceSourceType };

/** Where the truth originates, for the dependency graph. */
export type DomainEngineContract = {
  engine: string;
  confidence: "CONFIRMED" | "PARTIAL" | "NO_EVIDENCE";
  evidence?: string;
};

export type WidgetSourceContract = {
  authorization: AuthorizationContract;
  data: DataSourceContract;
  domain: DomainEngineContract;
};

/**
 * The current twelve expressed in the three-part model.
 *
 * Only the rows the evidence can fill are filled. This is a reading of the
 * registry, not a replacement for it.
 */
export const SOURCE_CONTRACTS: Readonly<Record<string, WidgetSourceContract>> = {
  hosRemaining: {
    authorization: { kind: "procedure", procedure: "hos.status" },
    data: { kind: "server", procedure: "hos.status" },
    domain: { engine: "HOS status engine (selectProfile + computeClocks + determine)", confidence: "CONFIRMED", evidence: "0088 worktree diff" },
  },
  dispatchReadiness: {
    authorization: { kind: "unresolved", question: "the dispatch permission map was not in this worktree; dispatch.read is a guess" },
    data: { kind: "server", procedure: "dispatch.readiness" },
    domain: { engine: "composeReadiness (readinessComposer.ts)", confidence: "CONFIRMED", evidence: "0088 worktree diff" },
  },
  syncStatus: {
    // The whole reason this model exists.
    authorization: { kind: "unresolved", question: "what authorizes a driver to see their own device's sync state? No sync.* procedure and no own-scoped permission exist in evidence." },
    data: { kind: "device_local", resolver: "sync_queue" },
    domain: { engine: "device outbox / syncEngine", confidence: "PARTIAL", evidence: "outbox and syncEngine appear client-side in the 0088 diff" },
  },
};

/**
 * Does this widget carry a server procedure it does not need?
 *
 * The check that would have caught `sync.status` at registration.
 */
export const hasFabricatedProcedure = (c: WidgetSourceContract): boolean =>
  c.data.kind === "device_local" && c.authorization.kind === "procedure";

/** Whether every part of the contract is settled. Required for PRODUCTION. */
export const contractConfirmed = (c: WidgetSourceContract): boolean =>
  c.authorization.kind !== "unresolved" && c.domain.confidence === "CONFIRMED";

/**
 * What the agent can do, which is deliberately less than what a driver can do.
 *
 * Every tool is a thin wrapper over a tRPC server-side caller built with the
 * **driver's** context. There is no service account, so there is no powerful
 * identity for an injected instruction to be tricked into borrowing: the agent
 * inherits exactly the permissions of the person it is working for, checked by
 * the same `roleProcedure` middleware that checks that person's own requests,
 * and recorded in the same authorization decisions table.
 *
 * Each tool maps to exactly one existing procedure. Not a gate that dispatches
 * on a string, not a helper that takes a procedure name — one function, one
 * procedure, chosen in advance. A tool that could name its own target would be
 * a tool whose authority is whatever the prompt talked it into.
 *
 * ## Three categories, and one that does not exist
 *
 *   **read**       — trip context, open tickets, unit specs, approved documents.
 *   **propose**    — everything lands pending. Nothing commits.
 *   **human_step** — creates a task for a person. The agent cannot complete it.
 *
 * There is no commit category, no delete, no permission or mode change, no
 * payment, and no outbound email or web. That is the injection defence: the
 * dangerous combination is private data plus untrusted text plus a way to send
 * something out, and the third leg is simply absent. The worst an injected
 * instruction achieves is a proposal a human declines.
 *
 * `server/_core/actionGateway.ts` already holds the risk ladder and the
 * never-autonomous list. This registry is narrower than that gateway on
 * purpose: the gateway describes what any agent might request, and this
 * describes what the Secretary is wired to. Where they overlap the gateway
 * wins, because it also sees approval binding and target revisions.
 */

import { NEVER_AUTONOMOUS } from "../../_core/actionGateway";

export type ToolCategory = "read" | "propose" | "human_step";

export type ToolDefinition = {
  key: string;
  category: ToolCategory;
  /** The single tRPC procedure this tool calls. One tool, one procedure. */
  procedure: string;
  description: string;
  /**
   * True when a replay must not do the thing twice. Every `propose` tool is
   * idempotent by a client-supplied key, because an offline device replaying
   * its queue is the normal case, not the failure case.
   */
  requiresIdempotencyKey: boolean;
};

/**
 * Categories that may never appear, whatever a task allowlist says.
 *
 * Kept as data so the structural test can assert the registry contains none of
 * them, rather than a reviewer having to notice.
 */
export const FORBIDDEN_CATEGORIES: readonly string[] = [
  "commit",
  "delete",
  "permission_change",
  "mode_change",
  "payment",
  "outbound_email",
  "outbound_web",
];

export const SECRETARY_TOOLS: readonly ToolDefinition[] = [
  /* --- read ---------------------------------------------------------- */
  {
    key: "read.tripContext",
    category: "read",
    procedure: "trip.getContext",
    description: "The current trip, its stops and the unit assigned to it.",
    requiresIdempotencyKey: false,
  },
  {
    key: "read.openTickets",
    category: "read",
    procedure: "disposal.listOpenTickets",
    description: "Ticket numbers currently open for this trip.",
    requiresIdempotencyKey: false,
  },
  {
    key: "read.unitSpecs",
    category: "read",
    procedure: "unit.getSpecs",
    description: "The unit's recorded specifications.",
    requiresIdempotencyKey: false,
  },
  {
    key: "read.approvedDocuments",
    category: "read",
    procedure: "assistant.searchPassages",
    description:
      "Search approved documents. This is what lets the Secretary read an approved tailgate " +
      "aloud and record sign-offs; it cannot write new safety content, because there is no tool " +
      "that writes any.",
    requiresIdempotencyKey: false,
  },

  /* --- propose (all land pending) ------------------------------------- */
  {
    key: "propose.loadEvent",
    category: "propose",
    procedure: "assistant.proposeLoadEvent",
    description: "A load or unload event, pending a person's confirmation.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.dutyEvent",
    category: "propose",
    procedure: "assistant.proposeDutyEvent",
    description:
      "A duty-status change, pending. Hours logged by voice are proposals into the HOS engine, " +
      "never the legal log.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.workOrder",
    category: "propose",
    procedure: "assistant.proposeWorkOrder",
    description: "A work order, pending.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.billingLine",
    category: "propose",
    procedure: "assistant.proposeBillingLine",
    description: "A billing line, pending.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.preTripFinding",
    category: "propose",
    procedure: "assistant.proposePreTripFinding",
    description:
      "An observation from a pre-trip, pending. The agent may say a light looks out; a human " +
      "signs the inspection.",
    requiresIdempotencyKey: true,
  },

  /* --- human steps (create tasks only) --------------------------------- */
  {
    key: "human.requestSignature",
    category: "human_step",
    procedure: "workflow.requestSignature",
    description: "Ask a named person to sign something. The agent cannot sign.",
    requiresIdempotencyKey: true,
  },
  {
    key: "human.notifyOffice",
    category: "human_step",
    procedure: "workflow.notifyOffice",
    description: "Put an item in front of the office. The agent cannot close it.",
    requiresIdempotencyKey: true,
  },
];

export class ToolNotAllowed extends Error {}

/**
 * The tools one task may use.
 *
 * Per task, not per agent: a bill-reading job has no business touching work
 * orders, and the narrowest allowlist that does the job is the one that
 * survives an injected instruction asking for something else.
 */
export type TaskAllowlist = {
  taskKey: string;
  toolKeys: readonly string[];
  /** How many tool calls one run may make before it stops. */
  stepBudget: number;
};

export const LOAD_UNLOAD_NARRATION: TaskAllowlist = {
  taskKey: "load_unload_narration",
  toolKeys: [
    "read.tripContext",
    "read.openTickets",
    "read.unitSpecs",
    "propose.loadEvent",
  ],
  stepBudget: 8,
};

export const BILL_SCAN: TaskAllowlist = {
  taskKey: "bill_scan",
  toolKeys: ["read.tripContext", "propose.billingLine"],
  stepBudget: 6,
};

const byKey = new Map(SECRETARY_TOOLS.map(t => [t.key, t]));

/**
 * Resolve a tool for a task, refusing anything not on the list.
 *
 * An unknown key and a known-but-not-allowed key both throw, and neither
 * message distinguishes them further than it needs to: a probe should not learn
 * which tools exist from the shape of the refusal.
 */
export function resolveTool(allowlist: TaskAllowlist, toolKey: string): ToolDefinition {
  if (!allowlist.toolKeys.includes(toolKey)) {
    throw new ToolNotAllowed(`${toolKey} is not available to task ${allowlist.taskKey}`);
  }
  const tool = byKey.get(toolKey);
  if (!tool) {
    throw new ToolNotAllowed(`${toolKey} is not available to task ${allowlist.taskKey}`);
  }
  if (NEVER_AUTONOMOUS.includes(tool.procedure)) {
    // Belt and braces: the registry should never have contained one, and if a
    // future edit adds one, it does not become reachable by being on a list.
    throw new ToolNotAllowed(`${tool.procedure} is never performed by an agent`);
  }
  return tool;
}

/** A run that has spent its budget stops. It does not ask for more. */
export class StepBudgetExhausted extends Error {}

export function spendStep(allowlist: TaskAllowlist, spent: number): number {
  if (spent >= allowlist.stepBudget) {
    throw new StepBudgetExhausted(
      `task ${allowlist.taskKey} has used its ${allowlist.stepBudget} steps`
    );
  }
  return spent + 1;
}

/**
 * The idempotency key for a proposal.
 *
 * Derived from the client's own identifier for the capture, so a device
 * replaying an offline queue produces the same key and the second attempt is
 * recognised rather than billed. Generated server-side per call, it would not
 * be an idempotency key at all — it would be a new record every retry, which is
 * exactly the double-bill the plan names.
 */
export function idempotencyKeyFor(args: {
  clientCaptureId: string;
  toolKey: string;
}): string {
  return `${args.toolKey}:${args.clientCaptureId}`;
}

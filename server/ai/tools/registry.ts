/**
 * What the agent can do, which is deliberately less than what a driver can do.
 *
 * Every tool names exactly one procedure that **exists**, and the compiler
 * proves it: `procedure` is typed `ProcedureName`, the union
 * `server/_core/recordsAuthorization.ts` builds from its permission maps. A
 * tool naming a procedure nobody wrote does not typecheck, which is the same
 * wiring-time failure `roleProcedure` raises for an unmapped procedure rather
 * than quietly degrading to authenticated-only.
 *
 * That type is load-bearing and it was added after a first pass got this
 * wrong. An earlier version of this file named eleven plausible-sounding
 * procedures — `trip.getContext`, `assistant.proposeLoadEvent` — and **every
 * one of them was invented**. They read correctly, the tests passed, and
 * nothing connected to anything. A registry of aspirational procedure names is
 * worse than no registry: it looks like a permission boundary and is a list of
 * strings.
 *
 * ## Three categories, and one that does not exist
 *
 *   **read**       — trip, stops, unit specs, closeout state, approved documents.
 *   **propose**    — everything lands pending. Nothing commits.
 *   **human_step** — creates a request for a person. The agent cannot complete it.
 *
 * There is no commit category, no delete, no permission or mode change, no
 * payment, and no outbound email or web. That is the injection defence: the
 * dangerous combination is private data plus untrusted text plus a way to send
 * something out, and the third leg is simply absent. The worst an injected
 * instruction achieves is a proposal a human declines.
 *
 * ## Why the propose tools share one procedure
 *
 * The checkpoint asked for five propose tools mapping to five procedures. The
 * repository has **one**: `assistant.draft`, parameterised by `formKey`. So the
 * tools differ by the form they pin, not by the procedure they call — and each
 * pins its form key as a constant the agent cannot supply. That is stronger
 * than five procedures would have been, because the agent cannot name a form at
 * all: `propose.preTripFinding` can only ever draft a `defect_report`.
 *
 * `server/_core/actionGateway.ts` holds the risk ladder and the
 * never-autonomous list. This registry is narrower on purpose: the gateway
 * describes what any agent might request, this describes what the Secretary is
 * wired to, and where they overlap the gateway wins — it also sees approval
 * binding and target revisions.
 */

import { NEVER_AUTONOMOUS } from "../../_core/actionGateway";
import type { ProcedureName } from "../../_core/recordsAuthorization";
import { FORMS } from "../../_core/aiProposal";

export type ToolCategory = "read" | "propose" | "human_step";

export type ToolDefinition = {
  key: string;
  category: ToolCategory;
  /**
   * The single procedure this tool calls, checked by the compiler against the
   * repository's own permission map.
   */
  procedure: ProcedureName;
  /**
   * For a `propose` tool, the one form it may draft. Pinned here so the agent
   * never supplies a form key; absent for every other category.
   */
  formKey?: keyof typeof FORMS & string;
  description: string;
  /**
   * True when a replay must not do the thing twice. Everything that creates
   * something is idempotent by a client-supplied key, because an offline device
   * replaying its queue is the normal case, not the failure case.
   */
  requiresIdempotencyKey: boolean;
};

/**
 * Categories that may never appear, whatever a task allowlist says.
 *
 * Data rather than prose so the structural test asserts it, instead of a
 * reviewer having to notice.
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
    key: "read.tripStops",
    category: "read",
    procedure: "tripStops.list",
    description: "The stops on this trip, which is where the current stop comes from.",
    requiresIdempotencyKey: false,
  },
  {
    key: "read.loads",
    category: "read",
    procedure: "loads.list",
    description: "The loads on this trip.",
    requiresIdempotencyKey: false,
  },
  {
    key: "read.unitSpecs",
    category: "read",
    procedure: "units.list",
    description: "The unit's recorded specifications.",
    requiresIdempotencyKey: false,
  },
  {
    key: "read.closeoutState",
    category: "read",
    procedure: "closeout.state",
    description:
      "Closeout state for the job, which is where open field and disposal tickets are read from.",
    requiresIdempotencyKey: false,
  },
  {
    key: "read.approvedDocuments",
    category: "read",
    procedure: "assistant.passageList",
    description:
      "The approved passage library. This is what lets the Secretary read an approved tailgate " +
      "aloud; it cannot write new safety content, because there is no tool that writes any.",
    requiresIdempotencyKey: false,
  },

  /* --- propose (all land pending, each pinned to one form) ------------- */
  {
    key: "propose.unloadStop",
    category: "propose",
    procedure: "assistant.draft",
    formKey: "unload_stop",
    description: "A load or unload event, pending a person's confirmation.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.disposalTicket",
    category: "propose",
    procedure: "assistant.draft",
    formKey: "disposal_ticket",
    description: "A disposal ticket, pending.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.preTripFinding",
    category: "propose",
    procedure: "assistant.draft",
    formKey: "defect_report",
    description:
      "An observation from a pre-trip, pending. The agent may say a light looks out; a human " +
      "signs the inspection.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.expenseReceipt",
    category: "propose",
    procedure: "assistant.draft",
    formKey: "expense_receipt",
    description: "A photographed expense receipt, pending.",
    requiresIdempotencyKey: true,
  },
  {
    key: "propose.fuelReceipt",
    category: "propose",
    procedure: "assistant.draft",
    formKey: "fuel_receipt",
    description: "A fuel receipt, pending.",
    requiresIdempotencyKey: true,
  },

  /* --- human steps (create a request only) ----------------------------- */
  {
    key: "human.requestAction",
    category: "human_step",
    procedure: "agent.requestAction",
    description:
      "Put a request in front of a person — a signature, an office decision. The agent creates " +
      "the request and cannot resolve it.",
    requiresIdempotencyKey: true,
  },
];

/**
 * What the checkpoint asked for and the repository does not have.
 *
 * Kept as data, not as a paragraph in a document, so it shows up in a test run
 * rather than in whatever nobody reread. Each one needs a form definition in
 * `FORMS` before a tool can pin it.
 */
export const PROPOSE_TOOLS_NOT_POSSIBLE_YET: readonly { tool: string; needs: string }[] = [
  { tool: "propose.dutyEvent", needs: "a duty_event form in FORMS; hours by voice are a proposal into the HOS engine, never the legal log" },
  { tool: "propose.workOrder", needs: "a work_order form in FORMS" },
  { tool: "propose.billingLine", needs: "a billing_line form in FORMS" },
];

export class ToolNotAllowed extends Error {}

/**
 * The tools one task may use.
 *
 * Per task, not per agent: a bill-reading job has no business touching a
 * pre-trip finding, and the narrowest allowlist that does the job is the one
 * that survives an injected instruction asking for something else.
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
    "read.tripStops",
    "read.loads",
    "read.unitSpecs",
    "read.closeoutState",
    "propose.unloadStop",
  ],
  stepBudget: 8,
};

export const BILL_SCAN: TaskAllowlist = {
  taskKey: "bill_scan",
  toolKeys: ["read.loads", "propose.expenseReceipt"],
  stepBudget: 6,
};

const byKey = new Map(SECRETARY_TOOLS.map(t => [t.key, t]));

/**
 * Resolve a tool for a task, refusing anything not on the list.
 *
 * An unknown key and a known-but-not-allowed key produce the same message on
 * purpose: a probe should not learn which tools exist from the shape of the
 * refusal.
 */
export function resolveTool(allowlist: TaskAllowlist, toolKey: string): ToolDefinition {
  const tool = allowlist.toolKeys.includes(toolKey) ? byKey.get(toolKey) : undefined;
  if (!tool) {
    throw new ToolNotAllowed(`${toolKey} is not available to task ${allowlist.taskKey}`);
  }
  if ((NEVER_AUTONOMOUS as readonly string[]).includes(tool.procedure)) {
    // Belt and braces: the registry should never have contained one, and if a
    // future edit adds one, being on a list must not make it reachable.
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
 * recognised rather than billed. Generated server-side per call it would not be
 * an idempotency key at all — it would be a new record every retry, which is
 * exactly the double-bill this exists to prevent.
 */
export function idempotencyKeyFor(args: {
  clientCaptureId: string;
  toolKey: string;
}): string {
  return `${args.toolKey}:${args.clientCaptureId}`;
}

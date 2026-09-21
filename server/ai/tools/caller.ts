/**
 * The thin wrappers. One tRPC server-side caller, built with the DRIVER's
 * context, and nothing else.
 *
 * This is the part that makes the registry a permission boundary rather than a
 * list of strings. `appRouter.createCaller(ctx)` runs the real middleware
 * chain: `roleProcedure` looks up the permission, reads the caller's active
 * roles, records an authorization decision, and refuses if they do not hold it.
 * The agent therefore inherits exactly what the driver can do — checked by the
 * same gate that checks the driver's own requests, and audited in the same
 * table.
 *
 * **There is no service account, and that is the security property.** An agent
 * with its own powerful identity is an identity an injected instruction can try
 * to borrow. An agent that can only act as the person it is working for cannot
 * be talked into more than that person already has, whatever a scanned bill
 * says.
 *
 * Three things this file deliberately does not do.
 *
 * **It does not build a context.** The caller is handed a `TrpcContext` that
 * the request or job already established. A helper here that assembled one
 * would be a helper that could assemble a better one.
 *
 * **It does not let a caller name a procedure.** `invokeTool` takes a tool key
 * and an allowlist; the procedure comes from the registry. A function that took
 * a procedure name would have the authority of whoever called it.
 *
 * **It does not commit.** The propose path is `assistant.draft`, which creates
 * a proposal in `drafting`. Reaching `assistant.commit` from here is impossible
 * because no tool names it and `resolveTool` refuses anything not on the task's
 * list.
 */

import type { TrpcContext } from "../../_core/context";
import { appRouter } from "../../routers";
import {
  idempotencyKeyFor,
  resolveTool,
  spendStep,
  type TaskAllowlist,
  type ToolDefinition,
} from "./registry";

/** Exactly the shape a tool call needs. Never a procedure name. */
export type ToolInvocation = {
  toolKey: string;
  /** Arguments for the procedure, minus anything the registry pins. */
  input: Record<string, unknown>;
  /** The device's own id for this capture. Makes a replay idempotent. */
  clientCaptureId: string;
};

export type ToolRunState = {
  allowlist: TaskAllowlist;
  /** Steps spent so far. Carried by the caller so a run is resumable. */
  stepsSpent: number;
};

export type ToolResult = {
  toolKey: string;
  procedure: string;
  /** Present on a propose tool. The form the tool pinned, not one supplied. */
  formKey: string | null;
  idempotencyKey: string | null;
  output: unknown;
  stepsSpent: number;
};

/**
 * Resolve a tool key to the caller path and the input the procedure receives.
 *
 * Split out from `invokeTool` so it can be tested without a database: what a
 * tool would call and with what is the part worth pinning, and it is decidable
 * from the registry alone.
 */
export function planToolCall(args: {
  tool: ToolDefinition;
  input: Record<string, unknown>;
  clientCaptureId: string;
}): { path: string[]; input: Record<string, unknown>; idempotencyKey: string | null } {
  const { tool, input, clientCaptureId } = args;

  // A pinned form key overrides anything the caller passed. Not merged, not
  // defaulted — overwritten, because a caller that can influence which form is
  // drafted is a caller that can draft a form it was not allowed to.
  const pinned = tool.formKey ? { formKey: tool.formKey } : {};

  const idempotencyKey = tool.requiresIdempotencyKey
    ? idempotencyKeyFor({ clientCaptureId, toolKey: tool.key })
    : null;

  return {
    path: tool.procedure.split("."),
    input: { ...input, ...pinned },
    idempotencyKey,
  };
}

/**
 * Walk the caller to a nested procedure by path.
 *
 * tRPC's generated caller is a plain nested object of functions, so this is a
 * property walk. It throws rather than returning undefined: a path that does
 * not resolve means the registry names a procedure the router does not mount,
 * and that is a wiring failure, not a runtime condition to absorb.
 */
function resolveOnCaller(caller: unknown, path: readonly string[]): (input: unknown) => Promise<unknown> {
  let node: unknown = caller;
  for (const segment of path) {
    if (node === null || typeof node !== "object" || !(segment in node)) {
      throw new Error(`the router does not mount ${path.join(".")}`);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== "function") {
    throw new Error(`${path.join(".")} is not a callable procedure`);
  }
  return node as (input: unknown) => Promise<unknown>;
}

/**
 * Call one tool as the driver.
 *
 * The order matters: the allowlist is consulted before the budget is spent, so
 * a refused tool does not cost a step — otherwise a run could be exhausted by
 * asking for things it was never allowed to have.
 */
export async function invokeTool(args: {
  ctx: TrpcContext;
  state: ToolRunState;
  invocation: ToolInvocation;
  /** Injected in tests. Production passes nothing and gets the real router. */
  createCaller?: (ctx: TrpcContext) => unknown;
}): Promise<ToolResult> {
  const { ctx, state, invocation } = args;

  const tool = resolveTool(state.allowlist, invocation.toolKey);
  const stepsSpent = spendStep(state.allowlist, state.stepsSpent);

  const plan = planToolCall({
    tool,
    input: invocation.input,
    clientCaptureId: invocation.clientCaptureId,
  });

  const caller = (args.createCaller ?? ((c: TrpcContext) => appRouter.createCaller(c)))(ctx);
  const procedure = resolveOnCaller(caller, plan.path);

  // No try/catch. A FORBIDDEN from roleProcedure is the boundary working, and
  // swallowing it here would turn a refusal into a silent no-op the agent
  // reads as success.
  const output = await procedure(plan.input);

  return {
    toolKey: tool.key,
    procedure: tool.procedure,
    formKey: tool.formKey ?? null,
    idempotencyKey: plan.idempotencyKey,
    output,
    stepsSpent,
  };
}

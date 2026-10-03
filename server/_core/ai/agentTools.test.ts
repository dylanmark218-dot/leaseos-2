/**
 * The agent's reach: every tool names a procedure that exists, no commit, no
 * outbound channel, and the caller is the driver.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FORMS } from "../aiProposal";
import { permissionForProcedure } from "../recordsAuthorization";
import {
  BILL_SCAN,
  FORBIDDEN_CATEGORIES,
  LOAD_UNLOAD_NARRATION,
  PROPOSE_TOOLS_NOT_POSSIBLE_YET,
  SECRETARY_TOOLS,
  StepBudgetExhausted,
  ToolNotAllowed,
  agentMayNotCall,
  idempotencyKeyFor,
  resolveTool,
  spendStep,
} from "./tools/registry";
import { invokeTool, planToolCall } from "./tools/caller";

describe("every tool names a procedure that exists", () => {
  // The guard that matters most here. A first pass at this registry named
  // eleven plausible procedures — trip.getContext, assistant.proposeLoadEvent —
  // and every one was invented. The type now makes that a compile error; this
  // makes it a test failure too, because a type can be widened in a hurry.
  it("resolves every procedure through the repository's own permission map", () => {
    for (const tool of SECRETARY_TOOLS) {
      expect(
        permissionForProcedure(tool.procedure),
        `${tool.key} names ${tool.procedure}, which has no permission mapped`
      ).not.toBeNull();
    }
  });

  it("pins a real form on every propose tool, and on nothing else", () => {
    for (const tool of SECRETARY_TOOLS) {
      if (tool.category === "propose") {
        expect(tool.formKey, `${tool.key} pins no form`).toBeTruthy();
        expect(Object.keys(FORMS), `${tool.key} pins ${tool.formKey}`).toContain(tool.formKey);
      } else {
        expect(tool.formKey, `${tool.key} pins a form it should not`).toBeUndefined();
      }
    }
  });

  it("gives each propose tool its own form, so no two can draft the same thing", () => {
    // The propose tools share one procedure — assistant.draft is the only one
    // the repository has — so the form key is what distinguishes them, and it
    // has to be unique for the pinning to mean anything.
    const forms = SECRETARY_TOOLS.filter(t => t.category === "propose").map(t => t.formKey);
    expect(new Set(forms).size).toBe(forms.length);
  });

  it("records the propose tools the repository cannot support yet", () => {
    // Data, not a paragraph in a document: these show up in a test run rather
    // than in whatever nobody reread.
    expect(PROPOSE_TOOLS_NOT_POSSIBLE_YET.map(t => t.tool)).toEqual([
      "propose.dutyEvent",
      "propose.workOrder",
      "propose.billingLine",
    ]);
    for (const missing of PROPOSE_TOOLS_NOT_POSSIBLE_YET) {
      expect(Object.keys(FORMS)).not.toContain(missing.tool.replace("propose.", ""));
    }
  });
});

describe("the registry", () => {
  it("exposes only read, propose and human_step", () => {
    expect([...new Set(SECRETARY_TOOLS.map(t => t.category))].sort()).toEqual([
      "human_step",
      "propose",
      "read",
    ]);
  });

  it("contains no tool in a forbidden category", () => {
    for (const tool of SECRETARY_TOOLS) {
      expect(FORBIDDEN_CATEGORIES).not.toContain(tool.category);
    }
  });

  it("exposes no commit, delete, payment, permission or outbound procedure", () => {
    const forbidden =
      /\.(commit|delete|destroy|pay|payment|approve|grant|revoke|setPermission|setMode|sendEmail|fetchUrl)\b/i;
    for (const tool of SECRETARY_TOOLS) {
      expect(tool.procedure, `${tool.key} → ${tool.procedure}`).not.toMatch(forbidden);
    }
  });

  it("never exposes assistant.commit, which is the one that would make it real", () => {
    expect(SECRETARY_TOOLS.map(t => t.procedure)).not.toContain("assistant.commit");
  });

  it("requires an idempotency key on everything that creates something", () => {
    for (const tool of SECRETARY_TOOLS) {
      const creates = tool.category === "propose" || tool.category === "human_step";
      expect(tool.requiresIdempotencyKey, tool.key).toBe(creates);
    }
  });

  it("names no service account in its code — the caller is the driver", () => {
    // Comments stripped first: the file's own doc comment says there is no
    // service account, and a guard that cannot tell that from a call to one is
    // a guard that fails on its own documentation.
    const strip = (path: string) =>
      readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const path of ["server/_core/ai/tools/registry.ts", "server/_core/ai/tools/caller.ts"]) {
      expect(strip(path), path).not.toMatch(/service[_ ]?account|systemUser|asSystem|impersonate/i);
    }
  });
});

describe("per-task allowlists", () => {
  it("lets the narration task draft an unload stop", () => {
    const tool = resolveTool(LOAD_UNLOAD_NARRATION, "propose.unloadStop");
    expect(tool.procedure).toBe("assistant.draft");
    expect(tool.formKey).toBe("unload_stop");
  });

  it("refuses a real tool that is not on this task's list", () => {
    // A bill-reading job has no business drafting a pre-trip finding, however
    // the text on the bill phrases the request.
    expect(() => resolveTool(BILL_SCAN, "propose.preTripFinding")).toThrow(ToolNotAllowed);
  });

  it("refuses an unknown key the same way, so a probe learns nothing from the refusal", () => {
    const message = (key: string) => {
      try {
        resolveTool(LOAD_UNLOAD_NARRATION, key);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(message("propose.somethingInvented")).toBe(
      "propose.somethingInvented is not available to task load_unload_narration"
    );
    expect(message("propose.preTripFinding")).toBe(
      "propose.preTripFinding is not available to task load_unload_narration"
    );
  });

  it("every allowlisted key names a tool that exists", () => {
    const keys = new Set(SECRETARY_TOOLS.map(t => t.key));
    for (const list of [LOAD_UNLOAD_NARRATION, BILL_SCAN]) {
      for (const key of list.toolKeys) {
        expect(keys, `${list.taskKey} lists ${key}`).toContain(key);
      }
    }
  });
});

describe("the step budget", () => {
  it("counts up to the budget and then stops", () => {
    let spent = 0;
    for (let i = 0; i < BILL_SCAN.stepBudget; i++) spent = spendStep(BILL_SCAN, spent);
    expect(spent).toBe(BILL_SCAN.stepBudget);
    expect(() => spendStep(BILL_SCAN, spent)).toThrow(StepBudgetExhausted);
  });
});

describe("idempotency", () => {
  it("derives the key from the device's own capture id, so a replay is recognised", () => {
    expect(idempotencyKeyFor({ clientCaptureId: "CAP-9f2", toolKey: "propose.unloadStop" })).toBe(
      idempotencyKeyFor({ clientCaptureId: "CAP-9f2", toolKey: "propose.unloadStop" })
    );
  });

  it("keeps two captures, and two tools on one capture, apart", () => {
    expect(idempotencyKeyFor({ clientCaptureId: "CAP-1", toolKey: "propose.unloadStop" })).not.toBe(
      idempotencyKeyFor({ clientCaptureId: "CAP-2", toolKey: "propose.unloadStop" })
    );
    expect(idempotencyKeyFor({ clientCaptureId: "CAP-1", toolKey: "propose.unloadStop" })).not.toBe(
      idempotencyKeyFor({ clientCaptureId: "CAP-1", toolKey: "propose.expenseReceipt" })
    );
  });
});

describe("what a tool call actually does", () => {
  const tool = (key: string) => SECRETARY_TOOLS.find(t => t.key === key)!;

  it("overwrites a form key the caller tried to supply", () => {
    // Not merged, not defaulted — overwritten. A caller that can influence
    // which form is drafted is a caller that can draft one it was not allowed
    // to, which is the whole point of pinning.
    const plan = planToolCall({
      tool: tool("propose.unloadStop"),
      input: { formKey: "disposal_ticket", targetRef: "TRIP-1", transcript: "..." },
      clientCaptureId: "CAP-1",
    });
    expect(plan.input.formKey).toBe("unload_stop");
    expect(plan.input.idempotencyKey).toBe(idempotencyKeyFor({ toolKey: "propose.unloadStop", clientCaptureId: "CAP-1" }));
  });

  it("resolves the procedure to a caller path", () => {
    expect(
      planToolCall({ tool: tool("read.tripStops"), input: {}, clientCaptureId: "C" }).path
    ).toEqual(["tripStops", "list"]);
  });

  it("attaches an idempotency key to a propose call and not to a read", () => {
    expect(
      planToolCall({ tool: tool("propose.unloadStop"), input: {}, clientCaptureId: "CAP-1" })
        .idempotencyKey
    ).toBe(idempotencyKeyFor({ toolKey: "propose.unloadStop", clientCaptureId: "CAP-1" }));
    expect(
      planToolCall({ tool: tool("read.tripStops"), input: {}, clientCaptureId: "CAP-1" })
        .idempotencyKey
    ).toBeNull();
  });
});

describe("the caller is the driver", () => {
  const driverCtx = { user: { id: 42, role: "user" } } as never;

  it("builds the caller from the context it is handed and calls the mapped procedure", async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const seen: unknown[] = [];
    const createCaller = (ctx: unknown) => {
      seen.push(ctx);
      return { tripStops: { list: read } };
    };

    const result = await invokeTool({
      ctx: driverCtx,
      state: { allowlist: LOAD_UNLOAD_NARRATION, stepsSpent: 0 },
      invocation: { toolKey: "read.tripStops", input: { tripId: 7 }, clientCaptureId: "CAP-1" },
      createCaller,
    });

    expect(seen[0]).toBe(driverCtx);
    expect(read).toHaveBeenCalledWith({ tripId: 7 });
    expect(result.output).toEqual({ ok: true });
    expect(result.stepsSpent).toBe(1);
  });

  it("lets a FORBIDDEN out rather than swallowing it into a silent no-op", async () => {
    // A refusal from roleProcedure is the boundary working. Absorbing it here
    // would read to the agent as success.
    const createCaller = () => ({
      tripStops: {
        list: async () => {
          throw new Error("User holds no domain role");
        },
      },
    });

    await expect(
      invokeTool({
        ctx: driverCtx,
        state: { allowlist: LOAD_UNLOAD_NARRATION, stepsSpent: 0 },
        invocation: { toolKey: "read.tripStops", input: {}, clientCaptureId: "CAP-1" },
        createCaller,
      })
    ).rejects.toThrow("User holds no domain role");
  });

  it("refuses a disallowed tool without spending a step", async () => {
    // Order matters: otherwise a run could be exhausted by asking for things it
    // was never allowed to have.
    const createCaller = vi.fn(() => ({}));
    await expect(
      invokeTool({
        ctx: driverCtx,
        state: { allowlist: LOAD_UNLOAD_NARRATION, stepsSpent: 0 },
        invocation: { toolKey: "propose.expenseReceipt", input: {}, clientCaptureId: "CAP-1" },
        createCaller,
      })
    ).rejects.toBeInstanceOf(ToolNotAllowed);
    expect(createCaller).not.toHaveBeenCalled();
  });

  it("fails loudly when the router does not mount a procedure the registry names", async () => {
    await expect(
      invokeTool({
        ctx: driverCtx,
        state: { allowlist: LOAD_UNLOAD_NARRATION, stepsSpent: 0 },
        invocation: { toolKey: "read.tripStops", input: {}, clientCaptureId: "CAP-1" },
        createCaller: () => ({}),
      })
    ).rejects.toThrow("the router does not mount tripStops.list");
  });

  it("stops the run when the budget is gone", async () => {
    await expect(
      invokeTool({
        ctx: driverCtx,
        state: { allowlist: BILL_SCAN, stepsSpent: BILL_SCAN.stepBudget },
        invocation: { toolKey: "read.loads", input: {}, clientCaptureId: "CAP-1" },
        createCaller: () => ({ loads: { list: async () => ({}) } }),
      })
    ).rejects.toBeInstanceOf(StepBudgetExhausted);
  });
});

describe("CP1.5 — no agent tool can return anything to service", () => {
  it("refuses, by permission, every procedure that releases a hold or returns a unit to service", () => {
    for (const procedure of ["fleet.holdRelease", "records.maintenance.recordRelease", "records.maintenance.resolveDefect", "records.maintenance.revokeRelease", "enforcement.orderRelease", "maintenance.returnToService", "maintenance.defectTriage"]) {
      expect(agentMayNotCall(procedure), procedure).toMatch(/never performed by an agent|a person's act/);
    }
  });
  it("leaves every tool the Secretary has reachable — reading and proposing are not releasing", () => {
    for (const tool of SECRETARY_TOOLS) expect(agentMayNotCall(tool.procedure), tool.key).toBeNull();
  });
});

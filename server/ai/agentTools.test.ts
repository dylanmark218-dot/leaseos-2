/**
 * The agent's reach: one procedure per tool, no commit, no outbound channel.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BILL_SCAN,
  FORBIDDEN_CATEGORIES,
  LOAD_UNLOAD_NARRATION,
  SECRETARY_TOOLS,
  StepBudgetExhausted,
  ToolNotAllowed,
  idempotencyKeyFor,
  resolveTool,
  spendStep,
} from "./tools/registry";

describe("the registry", () => {
  it("exposes only read, propose and human_step", () => {
    const categories = [...new Set(SECRETARY_TOOLS.map(t => t.category))].sort();
    expect(categories).toEqual(["human_step", "propose", "read"]);
  });

  it("contains no tool in a forbidden category", () => {
    for (const tool of SECRETARY_TOOLS) {
      expect(FORBIDDEN_CATEGORIES).not.toContain(tool.category);
    }
  });

  it("exposes no commit, delete, payment, permission or outbound procedure", () => {
    // Named shapes rather than an exact list, so a tool added later has to get
    // past this without anybody remembering to update it.
    const forbidden =
      /\.(commit|delete|destroy|pay|payment|approve|grant|revoke|setPermission|setMode|sendEmail|fetchUrl)\b/i;
    for (const tool of SECRETARY_TOOLS) {
      expect(tool.procedure, `${tool.key} → ${tool.procedure}`).not.toMatch(forbidden);
    }
  });

  it("maps each tool to exactly one procedure, and no two tools to the same one", () => {
    const procedures = SECRETARY_TOOLS.map(t => t.procedure);
    expect(new Set(procedures).size).toBe(procedures.length);
  });

  it("requires an idempotency key on everything that creates something", () => {
    for (const tool of SECRETARY_TOOLS) {
      const creates = tool.category === "propose" || tool.category === "human_step";
      expect(tool.requiresIdempotencyKey, tool.key).toBe(creates);
    }
  });

  it("names no service account in its code — the caller is the driver", () => {
    // Comments are stripped first. The file's own doc comment says there is no
    // service account, and a guard that cannot tell that from a call to one is
    // a guard that fails on its own documentation.
    const code = readFileSync("server/ai/tools/registry.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/service[_ ]?account|systemUser|asSystem|impersonate/i);
  });
});

describe("per-task allowlists", () => {
  it("lets the narration task propose a load event", () => {
    expect(resolveTool(LOAD_UNLOAD_NARRATION, "propose.loadEvent").procedure).toBe(
      "assistant.proposeLoadEvent"
    );
  });

  it("refuses a real tool that is not on this task's list", () => {
    // A bill-reading job has no business touching work orders, however the
    // text on the bill phrases the request.
    expect(() => resolveTool(BILL_SCAN, "propose.workOrder")).toThrow(ToolNotAllowed);
  });

  it("refuses an unknown key the same way, so a probe learns nothing from the refusal", () => {
    const unknown = (() => {
      try {
        resolveTool(LOAD_UNLOAD_NARRATION, "propose.somethingInvented");
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    const disallowed = (() => {
      try {
        resolveTool(LOAD_UNLOAD_NARRATION, "propose.workOrder");
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(unknown).toBe("propose.somethingInvented is not available to task load_unload_narration");
    expect(disallowed).toBe("propose.workOrder is not available to task load_unload_narration");
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
    for (let i = 0; i < BILL_SCAN.stepBudget; i++) {
      spent = spendStep(BILL_SCAN, spent);
    }
    expect(spent).toBe(BILL_SCAN.stepBudget);
    expect(() => spendStep(BILL_SCAN, spent)).toThrow(StepBudgetExhausted);
  });
});

describe("idempotency", () => {
  it("derives the key from the device's own capture id, so a replay is recognised", () => {
    const first = idempotencyKeyFor({ clientCaptureId: "CAP-9f2", toolKey: "propose.loadEvent" });
    const replay = idempotencyKeyFor({ clientCaptureId: "CAP-9f2", toolKey: "propose.loadEvent" });
    expect(first).toBe(replay);
  });

  it("keeps two different captures apart", () => {
    expect(idempotencyKeyFor({ clientCaptureId: "CAP-1", toolKey: "propose.loadEvent" })).not.toBe(
      idempotencyKeyFor({ clientCaptureId: "CAP-2", toolKey: "propose.loadEvent" })
    );
  });

  it("keeps two tools on one capture apart", () => {
    expect(idempotencyKeyFor({ clientCaptureId: "CAP-1", toolKey: "propose.loadEvent" })).not.toBe(
      idempotencyKeyFor({ clientCaptureId: "CAP-1", toolKey: "propose.billingLine" })
    );
  });
});

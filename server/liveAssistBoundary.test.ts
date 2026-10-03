/**
 * LA-1a — what the owner's carve-out forbids, proved from the code rather than promised in a comment.
 *
 * The ruling (docs/live-assist/LA1A_OWNER_RULING.md) authorizes the Live Assist session spine and
 * nothing else. So the Live Assist server files must not reach a model, a storage bucket, the network,
 * a capture API or an evidence table, must not log, and must accept only the fields they name. The
 * roles are exactly the ones the owner approved, and no role gains any other permission.
 *
 * `server/aiRequestBoundary.test.ts` separately fails the build if any request handler anywhere makes a
 * model call beyond the one it pins; this file is the Live Assist-specific half.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import {
  OPERATIONAL_PROCEDURE_PERMISSIONS, SENSITIVE_PERMISSIONS, UNIVERSAL_PERMISSIONS, permissionsForDomainRole, type DomainRole,
} from "./_core/recordsAuthorization";

const CORE_DIR = "server/_core/liveAssist";
const FILES = [
  "server/liveAssistRouter.ts",
  "server/liveAssistService.ts",
  ...readdirSync(CORE_DIR).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")).map(f => join(CORE_DIR, f)),
];
const src = (f: string) => readFileSync(f, "utf8");
/** Code without comments, so the prose explaining what is forbidden is not itself a finding. */
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("LA-1a boundary — no model, network, storage, capture or evidence path", () => {
  it("covers the files it claims to", () => {
    expect(FILES).toEqual(expect.arrayContaining([
      "server/liveAssistRouter.ts", "server/liveAssistService.ts",
      "server/_core/liveAssist/session.ts", "server/_core/liveAssist/policy.ts", "server/_core/liveAssist/sweepTicker.ts",
    ]));
  });

  const FORBIDDEN_IMPORTS = [
    /_core\/llm["']/, /voiceTranscription/, /imageGeneration/, /modelGateway/, /_core\/ai\//, /["']\.\.?\/?storage["']/,
    /["'](node:)?https?["']/, /["'](node:)?net["']/, /["']ws["']/, /["']axios["']/, /["']undici["']/, /outboundHttp/, /egress/,
  ];

  for (const f of FILES) {
    it(`${f} imports nothing that reaches a model, a bucket or the network`, () => {
      const imports = Array.from(code(f).matchAll(/(?:import|export)[^;]*?from\s*(["'][^"']+["'])|import\(\s*(["'][^"']+["'])/g)).map(m => m[1] ?? m[2]);
      for (const spec of imports) for (const re of FORBIDDEN_IMPORTS) expect(spec, `${f} imports ${spec}`).not.toMatch(re);
    });

    it(`${f} calls no network, capture or evidence API`, () => {
      const c = code(f);
      for (const re of [
        /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /getUserMedia/, /getDisplayMedia/, /MediaRecorder/,
        /\bstoragePut\b/, /\bstorageGetSignedUrl\b/, /\binvokeLLM\b/, /\btranscribeAudio\b/,
        /\bevidenceRecords\b/, /\bevidenceVersions\b/, /\bevidenceSeals\b/, /\bevidenceRelationships\b/, /\bcomplianceDocuments\b/,
        /\bassistantProposals\b/, /\bproposalFields\b/, /base64(?!url)/i, /dataUrl|data:image/i,
      ]) expect(c, `${f} matches ${re}`).not.toMatch(re);
    });

    it(`${f} does not log`, () => {
      expect(code(f), `${f} writes to the console`).not.toMatch(/\bconsole\s*\./);
    });
  }
});

describe("LA-1a boundary — inputs are strict, and tenancy is never an input", () => {
  type Parser = { safeParse: (v: unknown) => { success: boolean } };
  const procs = (appRouter as unknown as { _def: { procedures: Record<string, { _def: { inputs: Parser[] } }> } })._def.procedures;
  const input = (path: string) => procs[path]!._def.inputs[0]!;
  const ref = "LAS-AAAAAAAAAAAAAAAAAAAAAAAA";

  it("mounts exactly the eight LA-1a procedures", () => {
    expect(Object.keys(procs).filter(p => p.startsWith("liveAssist.")).sort()).toEqual([
      "liveAssist.end", "liveAssist.heartbeat", "liveAssist.lifecycleList", "liveAssist.pause",
      "liveAssist.policyGet", "liveAssist.policySet", "liveAssist.resume", "liveAssist.start",
    ]);
  });

  it("refuses an organization, a user, a state or an image smuggled into any input", () => {
    const smuggled = [{ orgRef: "ORG-B" }, { tenantId: "ORG-B" }, { userId: 1 }, { state: "active" }, { idleDeadlineAt: "2099-01-01" }, { dataBase64: "AAAA" }, { image: "x" }];
    const base: Record<string, unknown> = {
      "liveAssist.start": { source: "photo", startKey: "retry-key-0123456789" },
      "liveAssist.heartbeat": { sessionRef: ref }, "liveAssist.pause": { sessionRef: ref },
      "liveAssist.resume": { sessionRef: ref }, "liveAssist.end": { sessionRef: ref },
      "liveAssist.policySet": { enabled: true, sourcesAllowed: ["photo"], idleSeconds: 60, maxSessionMinutes: 10, retentionHours: 12, maxSessionsPerUserPerDay: 5, dailySpendCeilingCents: 100 },
      "liveAssist.lifecycleList": { from: "2026-01-01", to: "2026-12-31" },
    };
    for (const [path, ok] of Object.entries(base)) {
      expect(input(path).safeParse(ok).success, `${path} accepts its own shape`).toBe(true);
      for (const extra of smuggled) {
        if (path === "liveAssist.lifecycleList" && "userId" in extra) continue; // a reviewer's filter, not an identity
        expect(input(path).safeParse({ ...(ok as object), ...extra }).success, `${path} + ${Object.keys(extra)[0]}`).toBe(false);
      }
    }
  });

  it("refuses malformed and foreign-shaped session references before any query", () => {
    for (const bad of ["", "LAS-short", "AR-ABC-123", "' OR 1=1 --", `${ref}x`, ref.toLowerCase()]) {
      expect(input("liveAssist.heartbeat").safeParse({ sessionRef: bad }).success, bad).toBe(false);
    }
  });
});

describe("LA-1a boundary — the grants the owner approved, and nothing more", () => {
  const ALL: DomainRole[] = ["driver", "dispatcher", "mechanic", "shop_lead", "safety", "office", "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller", "external_accountant"];
  const holders = (p: string) => ALL.filter(r => (permissionsForDomainRole(r) as readonly string[]).includes(p)).sort();

  it("grants live_assist.use to exactly driver, dispatcher, mechanic, shop_lead, office and management", () => {
    expect(holders("live_assist.use")).toEqual(["dispatcher", "driver", "management", "mechanic", "office", "shop_lead"]);
  });
  it("grants live_assist.administer to management only — there is no administrator role", () => {
    expect(holders("live_assist.administer")).toEqual(["management"]);
  });
  it("grants live_assist.review to safety and management only", () => {
    expect(holders("live_assist.review")).toEqual(["management", "safety"]);
  });
  it("adds no evidence-saving permission, and gives dispatchers no evidence upload", () => {
    expect(holders("live_assist.save_evidence")).toEqual([]);
    expect(holders("evidence.upload")).not.toContain("dispatcher");
  });
  it("makes every Live Assist permission sensitive and none universal", () => {
    for (const p of ["live_assist.use", "live_assist.administer", "live_assist.review"]) {
      expect((SENSITIVE_PERMISSIONS as readonly string[]).includes(p), p).toBe(true);
      expect((UNIVERSAL_PERMISSIONS as readonly string[]).includes(p), p).toBe(false);
    }
  });
  it("maps every liveAssist procedure to a liveAssist permission and nothing broader", () => {
    const map = OPERATIONAL_PROCEDURE_PERMISSIONS as Record<string, string>;
    const la = Object.entries(map).filter(([k]) => k.startsWith("liveAssist."));
    expect(Object.fromEntries(la)).toEqual({
      "liveAssist.start": "live_assist.use", "liveAssist.heartbeat": "live_assist.use", "liveAssist.pause": "live_assist.use",
      "liveAssist.resume": "live_assist.use", "liveAssist.end": "live_assist.use", "liveAssist.policyGet": "live_assist.use",
      "liveAssist.policySet": "live_assist.administer", "liveAssist.lifecycleList": "live_assist.review",
    });
  });
});

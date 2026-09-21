import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  // The client suites are .tsx; the automatic JSX runtime means no `import React` in every file.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts", "client/src/**/*.dom.test.tsx"],
    // B28 client suites render under jsdom; every server suite stays on node.
    environmentMatchGlobs: [["client/src/**/*.dom.test.tsx", "jsdom"]],
    setupFiles: ["client/src/test/setup.ts"],
    // The database-backed suites all share ONE schema, so running test files in
    // parallel makes them contend for the same rows. The sharpest case is the
    // outbox: workflowEndToEnd.test.ts starts a real drain worker whose claim
    // query (server/_core/workflowRuntime.ts) filters on nothing but
    // processedAt IS NULL, so while it runs it will claim events that
    // workflowOrchestration.test.ts inserted for its own workers — which then
    // find nothing and fail an assertion they did not cause. Two parallel runs
    // on 2026-09-20 failed four tests between them and never the same four.
    // Serialised, the suite is deterministic and costs no wall clock (179s vs
    // 182s), because collection dominates the run.
    fileParallelism: false,
  },
});

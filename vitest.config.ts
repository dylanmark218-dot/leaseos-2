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
  },
});

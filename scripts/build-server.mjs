// S2-FLEET-A — bundle the two production entrypoints with the build identity embedded.
//
// Same esbuild invocation `pnpm build` ran as a command line before this script existed
// (`esbuild server/_core/index.ts server/_core/worker.ts --platform=node --packages=external --bundle
// --format=esm --outdir=dist`), moved into a script for one reason: the `define` below. Both bundles
// are produced by ONE call from ONE identity value, so `dist/index.js` and `dist/worker.js` cannot
// disagree about which build they are. `server/productionDependencyBoundary.test.ts` pins this shape
// and `scripts/prod-runtime-smoke.sh` (Gate 7a) boots both bundles and requires them to report the
// same identity.
import { build } from "esbuild";
import { buildIdentity } from "./build-identity.mjs";

const identity = buildIdentity();

await build({
  entryPoints: ["server/_core/index.ts", "server/_core/worker.ts"],
  platform: "node",
  packages: "external",
  bundle: true,
  format: "esm",
  outdir: "dist",
  logLevel: "info",
  define: {
    // A string literal holding the JSON: `server/_core/buildIdentity.ts` parses and validates it.
    __LEASEOS_BUILD_IDENTITY__: JSON.stringify(JSON.stringify(identity)),
  },
});

console.log(`build identity embedded: sha=${identity.sha} release=${identity.release} (${identity.shaSource})`);

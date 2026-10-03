import { mergeConfig } from "vitest/config";
import base from "../../vitest.config";

// The repository's own config plus the clock-sweep setup file. Used only by scripts/clock-sweep.sh.
export default mergeConfig(base, { test: { setupFiles: ["scripts/clock-sweep/fakeclock.setup.ts"] } });

// S2-FLEET-A — the build identity, determined at BUILD time and embedded into both server bundles.
//
// This is the only place the commit id is ever looked up. The runtime (`server/_core/buildIdentity.ts`)
// reads the embedded value and nothing else: no environment variable, no git call. So:
//
//   - `LEASEOS_BUILD_SHA`, when set, must be the full 40-character commit id of exactly the tree being
//     built; CI and a deploy pipeline that builds from a detached checkout pass it explicitly.
//   - otherwise the id is `git rev-parse HEAD` of this checkout, which makes a local build of the same
//     commit deterministic: same commit, same release file, same embedded identity.
//   - a build that can establish neither fails. An artifact without an identity is not shipped.
//
// The release name comes from `LEASEOS_RELEASE`, the same file `scripts/current-state.sh` reads.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUILD_SHA = /^[0-9a-f]{40}$/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function buildIdentity(env = process.env, cwd = process.cwd()) {
  const release = readFileSync(new URL("../LEASEOS_RELEASE", import.meta.url), "utf8").trim();
  if (!RELEASE.test(release)) throw new Error(`LEASEOS_RELEASE does not hold a release name: ${JSON.stringify(release)}`);

  const explicit = env.LEASEOS_BUILD_SHA;
  if (explicit !== undefined) {
    if (!BUILD_SHA.test(explicit)) {
      throw new Error("LEASEOS_BUILD_SHA must be the full 40-character lower-case commit id of the tree being built");
    }
    return { sha: explicit, release, shaSource: "explicit" };
  }

  let sha;
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(
      "cannot determine the build sha: LEASEOS_BUILD_SHA is unset and `git rev-parse HEAD` failed " +
        "(not a git checkout, or git is not installed). Set LEASEOS_BUILD_SHA to the exact commit being built."
    );
  }
  if (!BUILD_SHA.test(sha)) throw new Error(`git rev-parse HEAD did not return a commit id: ${JSON.stringify(sha)}`);
  return { sha, release, shaSource: "git" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(buildIdentity()));
}

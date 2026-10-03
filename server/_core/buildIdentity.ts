/**
 * S2-FLEET-A — which build this process is, embedded when the artifact was built.
 *
 * WHY. The webhook cutover preflight (`webhookCutoverPreflight.ts`) has to know whether every
 * running server and worker understands the canonical secret reference before production may write
 * one. Until this module, nothing running could say which build it was: `/healthz` and `/readyz`
 * answer a single `status` field by contract, the drain worker's heartbeat carries a worker id and a
 * time, and `LEASEOS_RELEASE` is a file in the repository, not an observation of a process. So the
 * fleet component was `not_provable`, and the preflight could not be anything but blocked.
 *
 * WHAT. One canonical value, `__LEASEOS_BUILD_IDENTITY__`, substituted into both production bundles
 * by `scripts/build-server.mjs` (esbuild `define`) from the commit being built. Both bundles are
 * built in one call from one value, so a server and a worker from the same build report the same
 * identity by construction, not by convention.
 *
 * WHAT IT REFUSES TO DO.
 *   - Read the environment. `LEASEOS_BUILD_SHA` is a BUILD-TIME input to `scripts/build-identity.mjs`;
 *     this module never consults `process.env`, so a deployment cannot relabel a running process.
 *   - Call git. A production container has no `.git` and need not have a `git` executable; the
 *     identity is baked, and Gate 7a boots the artifact with a PATH that holds only `node` to prove it.
 *   - Guess. An identity that is present but malformed throws; a process without one is `unbuilt`,
 *     which production refuses (`requireBuildIdentity`) and which the fleet registry records as a
 *     build that can never be counted compatible.
 */

/** Substituted by esbuild at build time. Under tsx and vitest nothing declares it. */
declare const __LEASEOS_BUILD_IDENTITY__: string | undefined;

/** A full, lower-case commit id. Short forms are ambiguous and are not an identity. */
export const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/;
/** The contents of `LEASEOS_RELEASE`, e.g. `v23.30`. */
export const BUILD_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Where the build step got the commit id: from `git rev-parse HEAD`, or from `LEASEOS_BUILD_SHA`. */
export type BuildShaSource = "git" | "explicit";

export type BuildIdentity = Readonly<{
  sha: string;
  release: string;
  shaSource: BuildShaSource;
}>;

export type RuntimeBuild =
  /** A built artifact: `dist/index.js` or `dist/worker.js`, with the identity embedded. */
  | Readonly<{ source: "artifact"; identity: BuildIdentity }>
  /** Sources run directly (tsx, vitest). No identity exists and none is invented. */
  | Readonly<{ source: "unbuilt"; reason: string }>;

export class BuildIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildIdentityError";
  }
}

/**
 * The embedded value, validated. Strict on shape: exactly the three fields, a full lower-case commit
 * id, a release name. A build step that embedded anything else is broken, and a broken identity is
 * worse than none — it would be recorded and compared as if it meant something.
 */
export function parseBuildIdentity(raw: unknown): BuildIdentity {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BuildIdentityError("embedded build identity is not JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BuildIdentityError("embedded build identity is not an object");
  }
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(",") !== "release,sha,shaSource") {
    throw new BuildIdentityError(`embedded build identity has fields [${keys.join(", ")}]; expected exactly [release, sha, shaSource]`);
  }
  if (typeof o.sha !== "string" || !BUILD_SHA_PATTERN.test(o.sha)) {
    throw new BuildIdentityError("embedded build identity sha is not a 40-character lower-case hexadecimal commit id");
  }
  if (typeof o.release !== "string" || !BUILD_RELEASE_PATTERN.test(o.release)) {
    throw new BuildIdentityError("embedded build identity release is not a release name");
  }
  if (o.shaSource !== "git" && o.shaSource !== "explicit") {
    throw new BuildIdentityError('embedded build identity shaSource must be "git" or "explicit"');
  }
  return Object.freeze({ sha: o.sha, release: o.release, shaSource: o.shaSource });
}

function embeddedValue(): string | undefined {
  // `typeof` on an undeclared identifier is the one expression that does not throw. esbuild
  // substitutes the identifier in the artifact; under tsx and vitest it is simply absent.
  return typeof __LEASEOS_BUILD_IDENTITY__ === "string" ? __LEASEOS_BUILD_IDENTITY__ : undefined;
}

/**
 * The build this process is. Never consults the environment or the filesystem. Throws only when an
 * identity is embedded and malformed; an absent identity is reported as `unbuilt`, not guessed.
 */
export function runtimeBuild(): RuntimeBuild {
  const raw = embeddedValue();
  if (raw === undefined) {
    return Object.freeze({
      source: "unbuilt" as const,
      reason: "no build identity is embedded: this process runs from sources (tsx, vitest), not from a built artifact",
    });
  }
  return Object.freeze({ source: "artifact" as const, identity: parseBuildIdentity(raw) });
}

/** Production must be a built artifact. Anything else refuses to start rather than run unidentified. */
export function requireBuildIdentity(build: RuntimeBuild, production: boolean): RuntimeBuild {
  if (production && build.source !== "artifact") {
    throw new BuildIdentityError(`production requires a built artifact with an embedded build identity; ${build.reason}`);
  }
  return build;
}

/** The commit id, or null when there is none. Never a placeholder string. */
export function buildShaOf(build: RuntimeBuild): string | null {
  return build.source === "artifact" ? build.identity.sha : null;
}

/** The one startup log line. Gate 7a reads it from both artifacts and requires them to agree. */
export function describeBuild(build: RuntimeBuild): string {
  return build.source === "artifact"
    ? `[build] sha=${build.identity.sha} release=${build.identity.release} source=artifact shaSource=${build.identity.shaSource}`
    : `[build] unbuilt: ${build.reason}`;
}

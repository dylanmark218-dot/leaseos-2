/**
 * v22.20 (0081) — turning a feed response into durable, auditable rows.
 *
 * Pure orchestration. The network is a port and so is the database, which is
 * how the rest of this runtime is proven: the logic is exercised in Node
 * against fakes, and the real adapters are thin.
 *
 * Four things this gets right that a naive importer gets wrong.
 *
 * **A refusal is a run.** If the collector declines to poll — uncleared source,
 * no credential, not due, quota spent — that is written down with its reason. A
 * feed nobody polled and a feed that returned nothing look identical from the
 * outside, and telling them apart later is the whole point of keeping runs.
 *
 * **A change supersedes; it never overwrites.** When the publisher revises an
 * event, the old row stays and the new one points back at it. A closure that
 * was "until 14:00" and became "until 20:00" is two facts with a history, and
 * the trip that departed at 13:00 departed under the first one.
 *
 * **Absence means something only when the feed is a snapshot.** A full listing
 * that stops mentioning an event is the publisher saying it is over. An
 * incremental feed that stops mentioning it is saying nothing at all. Treating
 * the second like the first silently clears live advisories, so the source has
 * to declare which it is.
 *
 * **A record that will not normalize is counted, not skipped.** Ten rejected
 * rows in a run is a signal the publisher changed their shape; zero accepted
 * and zero rejected is a signal nothing came back.
 */

import { createHash } from "node:crypto";
import { recordCall, shouldPoll, type FeedCredential, type FeedSource, type FeedState } from "./feedCollector";
import type { RoadAdvisory } from "./advisoryImpact";

export const contentHashOf = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Whether absence from a response means the publisher considers it over. */
export type SnapshotSemantics = "full" | "incremental";

export type FetchResult =
  | { status: "ok"; httpStatus: number; body: string; entityTag: string | null; sourceVersion: string | null }
  | { status: "not_modified"; httpStatus: 304; entityTag: string | null }
  | { status: "error"; httpStatus: number | null; error: string };

export interface FeedFetcher {
  /** The only place a credential is ever read, and it is read from the environment there. */
  fetch(input: { source: FeedSource; entityTag: string | null }): Promise<FetchResult>;
}

export type StoredAdvisory = { advisoryRef: string; externalRef: string; contentHash: string };

export interface AdvisoryStore {
  activeByExternalRef(sourceKey: string): Promise<StoredAdvisory[]>;
  insert(advisory: RoadAdvisory & { advisoryRef: string; runRef: string; contentHash: string }): Promise<void>;
  supersede(advisoryRef: string, byAdvisoryRef: string): Promise<void>;
  withdraw(advisoryRef: string): Promise<void>;
  recordRun(run: FeedRun): Promise<void>;
}

export type FeedRun = {
  runRef: string;
  sourceKey: string;
  startedAt: Date;
  finishedAt: Date;
  outcome: "succeeded" | "failed" | "refused" | "not_modified";
  refusedBecause: "not_cleared" | "no_credential" | "not_due" | "quota_exhausted" | "withdrawn" | null;
  httpStatus: number | null;
  recordsSeen: number;
  recordsAccepted: number;
  recordsRejected: number;
  rejections: { index: number; reason: string }[];
  quotaUsedInWindow: number | null;
  quotaLimit: number | null;
  responseHash: string | null;
  sourceVersion: string | null;
  entityTag: string | null;
  errorText: string | null;
};

/** Turn one publisher record into an advisory, or say why it cannot be one. */
export type Normalizer = (raw: unknown, index: number) => { ok: true; advisory: RoadAdvisory } | { ok: false; reason: string };

export type IngestOutcome = {
  run: FeedRun;
  state: FeedState;
  accepted: number;
  unchanged: number;
  superseded: number;
  withdrawn: number;
  rejected: number;
};

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/**
 * One poll, start to finish. Returns the run to record and the collector state
 * to carry forward; writes through the store port.
 */
export async function ingestFeed(input: {
  source: FeedSource;
  state: FeedState;
  credential: FeedCredential | null;
  fetcher: FeedFetcher;
  store: AdvisoryStore;
  normalize: Normalizer;
  /** Parse the body into publisher records. Kept separate so a shape change is one function. */
  parse: (body: string) => unknown[];
  snapshotSemantics: SnapshotSemantics;
  lastEntityTag?: string | null;
  at: Date;
}): Promise<IngestOutcome> {
  const { source, at } = input;
  const runRef = ref("FEEDRUN");
  const base: FeedRun = {
    runRef, sourceKey: source.sourceKey, startedAt: at, finishedAt: at,
    outcome: "refused", refusedBecause: null, httpStatus: null,
    recordsSeen: 0, recordsAccepted: 0, recordsRejected: 0, rejections: [],
    quotaUsedInWindow: null, quotaLimit: source.rateLimitCalls, responseHash: null,
    sourceVersion: null, entityTag: null, errorText: null,
  };

  /* 1. May we poll at all? A refusal is recorded, not swallowed. */
  const decision = shouldPoll(source, input.state, at, input.credential);
  if (!decision.poll) {
    const run: FeedRun = { ...base, outcome: "refused", refusedBecause: decision.blockedBy, errorText: decision.reason, finishedAt: at };
    await input.store.recordRun(run);
    return { run, state: input.state, accepted: 0, unchanged: 0, superseded: 0, withdrawn: 0, rejected: 0 };
  }

  /* 2. Fetch. */
  let result: FetchResult;
  try {
    result = await input.fetcher.fetch({ source, entityTag: input.lastEntityTag ?? null });
  } catch (e) {
    result = { status: "error", httpStatus: null, error: (e as Error).message };
  }
  const state = recordCall(input.state, at, result.status === "error" ? { ok: false, reason: result.error } : { ok: true }, source);

  if (result.status === "not_modified") {
    const run: FeedRun = { ...base, outcome: "not_modified", httpStatus: 304, entityTag: result.entityTag, finishedAt: new Date(at.getTime()) };
    await input.store.recordRun(run);
    return { run, state, accepted: 0, unchanged: 0, superseded: 0, withdrawn: 0, rejected: 0 };
  }
  if (result.status === "error") {
    const run: FeedRun = { ...base, outcome: "failed", httpStatus: result.httpStatus, errorText: result.error, finishedAt: new Date(at.getTime()) };
    await input.store.recordRun(run);
    return { run, state, accepted: 0, unchanged: 0, superseded: 0, withdrawn: 0, rejected: 0 };
  }

  /* 3. Parse and normalize. A record that will not normalize is counted. */
  let raws: unknown[];
  const rejections: FeedRun["rejections"] = [];
  try {
    raws = input.parse(result.body);
  } catch (e) {
    const run: FeedRun = { ...base, outcome: "failed", httpStatus: result.httpStatus, responseHash: contentHashOf(result.body), errorText: `Response did not parse: ${(e as Error).message}`, finishedAt: new Date(at.getTime()) };
    await input.store.recordRun(run);
    return { run, state, accepted: 0, unchanged: 0, superseded: 0, withdrawn: 0, rejected: 0 };
  }

  const normalized: (RoadAdvisory & { contentHash: string })[] = [];
  raws.forEach((raw, i) => {
    const n = input.normalize(raw, i);
    if (!n.ok) { rejections.push({ index: i, reason: n.reason }); return; }
    normalized.push({ ...n.advisory, contentHash: contentHashOf({ ...n.advisory, retrievedAt: undefined }) });
  });

  /* 4. Compare against what is already held. Change supersedes; it never overwrites. */
  const existing = await input.store.activeByExternalRef(source.sourceKey);
  const byExternal = new Map(existing.map(e => [e.externalRef, e]));
  let accepted = 0, unchanged = 0, superseded = 0, withdrawn = 0;

  for (const adv of normalized) {
    const held = byExternal.get(adv.externalRef);
    if (held && held.contentHash === adv.contentHash) { unchanged++; continue; }
    const advisoryRef = ref("ADV");
    await input.store.insert({ ...adv, advisoryRef, runRef });
    accepted++;
    if (held) { await input.store.supersede(held.advisoryRef, advisoryRef); superseded++; }
  }

  /* 5. Absence means the publisher considers it over — but only for a snapshot. */
  if (input.snapshotSemantics === "full") {
    const seen = new Set(normalized.map(a => a.externalRef));
    for (const held of existing) {
      if (!seen.has(held.externalRef)) { await input.store.withdraw(held.advisoryRef); withdrawn++; }
    }
  }

  const run: FeedRun = {
    ...base,
    outcome: "succeeded", httpStatus: result.httpStatus,
    recordsSeen: raws.length, recordsAccepted: accepted, recordsRejected: rejections.length, rejections,
    responseHash: contentHashOf(result.body), sourceVersion: result.sourceVersion, entityTag: result.entityTag,
    quotaUsedInWindow: state.recentCallsAt.length, finishedAt: new Date(at.getTime()),
  };
  await input.store.recordRun(run);
  return { run, state, accepted, unchanged, superseded, withdrawn, rejected: rejections.length };
}

/**
 * One line about a run, for the same status surface the collector feeds.
 * A refusal reads as a refusal, never as a quiet success.
 */
export function runLine(run: FeedRun): string {
  switch (run.outcome) {
    case "refused": return `${run.sourceKey}: REFUSED (${run.refusedBecause}) — ${run.errorText ?? "no reason recorded"}`;
    case "failed": return `${run.sourceKey}: FAILED${run.httpStatus ? ` HTTP ${run.httpStatus}` : ""} — ${run.errorText ?? "no error recorded"}`;
    case "not_modified": return `${run.sourceKey}: UNCHANGED — publisher reported no change since the last collection`;
    case "succeeded":
      return `${run.sourceKey}: OK — ${run.recordsSeen} seen, ${run.recordsAccepted} new or revised, ${run.recordsRejected} rejected${run.recordsRejected ? ` (${run.rejections[0]?.reason ?? ""})` : ""}`;
  }
}

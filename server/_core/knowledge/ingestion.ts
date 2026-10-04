/**
 * One ingestion run for one catalogued source: Checkpoint 2's pipeline, end to end.
 *
 *   decide (no network) → robots.txt → decide again → collect → document → extract
 *   → snapshot → release → chunks
 *
 * Every refusal that can be made without touching the network is made first. A source with
 * no licence assessment — every seed today — is refused before robots.txt is even asked
 * for, so an unassessed source costs its publisher nothing and leaves no trace in their
 * logs. The run returns a step-by-step report rather than throwing, because the controller
 * reading it needs to know where it stopped and why, not that it stopped.
 *
 * Nothing here decides compliance and nothing here can grant a licence. What a run can do
 * is bounded by the source's assessment at every step: `decideFetch` before the request,
 * `recordSnapshot` before anything is written, the licence gate again before text is kept.
 *
 * Controller-only. It is reached from `scripts/knowledge-ingest.ts`, which an operator
 * runs, and from no router: a crawl started by a web request is not something to expose.
 */

import { randomUUID } from "node:crypto";
import { checkSourceGate, licenceFor } from "./sourceGate";
import {
  DEFAULT_CRAWL_POLICY, collectorFor, decideFetch, fetchRobots,
  type CollectorEnvironment, type CollectorKind, type CrawlPolicy, type CrawlerIdentity, type FetchSubject, type RobotsState,
} from "./collectors";
import { chunkSections, extractHtml } from "./extraction";
import {
  documentForUrl, quarantineDocument, recordRobotsCheck, recordSnapshot, releaseFromQuarantine, sourceForIngestion,
  writeChunks, type ChangeSignal, type SnapshotRequest,
} from "./repository";
import type { RetrievalOutcome } from "./provenance";

export type IngestDeps = {
  fetch: CollectorEnvironment["fetch"];
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Null when no crawler contact is configured; the run then refuses, as `decideFetch` requires. */
  identity: CrawlerIdentity | null;
  /** The person running it. Every document and snapshot names them. */
  operatorUserId: number;
  /**
   * Where original bytes would be kept. Called only when the source's licence permits
   * keeping text; absent, only hashes are recorded.
   */
  storeRaw?: (key: string, bytes: Uint8Array, contentType: string | null) => Promise<string>;
  /** Run even when the last retrieval is newer than the source's refresh interval. */
  force?: boolean;
};

export type IngestStep = { step: string; ok: boolean; detail: string };

export type IngestReport = {
  sourceId: string;
  url: string | null;
  result: "refused" | "not_due" | "recorded" | "failed";
  steps: IngestStep[];
  /** Network requests made, robots.txt included. Zero for every refusal decided from the database. */
  requests: number;
  snapshotRef?: string;
  outcome?: RetrievalOutcome;
  change?: ChangeSignal | null;
  chunksWritten?: number;
};

const KIND_FOR: Partial<Record<string, CollectorKind>> = { html: "html", pdf: "pdf" };

export async function ingestSource(sourceId: string, deps: IngestDeps): Promise<IngestReport> {
  const steps: IngestStep[] = [];
  let requests = 0;
  const note = (step: string, ok: boolean, detail: string) => { steps.push({ step, ok, detail }); };
  const report = (result: IngestReport["result"], url: string | null, extra: Partial<IngestReport> = {}): IngestReport =>
    ({ sourceId, url, result, steps, requests, ...extra });

  const source = await sourceForIngestion(sourceId);
  if (!source) { note("catalogue", false, "not in the source catalogue"); return report("refused", null); }
  const url = source.homeUrl;
  if (!url) { note("catalogue", false, "the source has no home URL"); return report("refused", null); }
  note("catalogue", true, `${source.sourceName} (${source.authorityLevel})`);

  const kind = source.sourceKind ? KIND_FOR[source.sourceKind] : undefined;
  if (!kind) { note("collector", false, `no collector is built for "${source.sourceKind ?? "(unset)"}" sources`); return report("refused", url); }

  const licence = licenceFor(sourceId);
  const policy: CrawlPolicy = { ...DEFAULT_CRAWL_POLICY, ...(source.crawlPolicyJson as Partial<CrawlPolicy> | null ?? {}) };
  const subject: FetchSubject = {
    sourceId, active: source.active,
    domains: Array.isArray(source.domainsJson) ? (source.domainsJson as string[]) : [],
    accessControlled: source.accessControlled,
    licence: !licence ? "none" : licence.status === "prohibited" ? "prohibited" : "assessed",
    policy,
  };

  // Is it due? Asked before anything else that costs the publisher a request.
  const existing = await documentForUrl(sourceId, url);
  const last = existing?.last ?? null;
  if (!deps.force && last && source.refreshIntervalHours) {
    const dueAt = last.retrievedAt.getTime() + source.refreshIntervalHours * 3_600_000;
    if (deps.now().getTime() < dueAt) {
      note("schedule", true, `last retrieved ${last.retrievedAt.toISOString()}; next due ${new Date(dueAt).toISOString()}`);
      return report("not_due", url);
    }
  }

  // Everything decidable without the network, first. ROBOTS_UNCHECKED is the only refusal
  // that a request can cure, so it is the only one that leads to one.
  const unchecked = decideFetch({ subject, url, identity: deps.identity, robots: { status: "unchecked" }, now: deps.now(), lastRequestAt: null, inFlight: 0 });
  if (!unchecked.allowed && unchecked.code !== "ROBOTS_UNCHECKED") {
    note("decide", false, `${unchecked.code}: ${unchecked.reason}`);
    return report("refused", url);
  }
  const identity = deps.identity!;   // decideFetch refuses a null identity before ROBOTS_UNCHECKED

  const env = { fetch: deps.fetch, now: deps.now, identity };
  const host = new URL(url).hostname;
  requests++;
  const robots: RobotsState = await fetchRobots(host, subject.domains, env);
  const robotsAt = deps.now();
  if (robots.status !== "unchecked") await recordRobotsCheck(sourceId, robots.status, robots.fetchedAt);
  note("robots", robots.status !== "unreachable", `robots.txt for ${host}: ${robots.status}`);

  let decision = decideFetch({ subject, url, identity, robots, now: deps.now(), lastRequestAt: robotsAt, inFlight: 0 });
  if (!decision.allowed && decision.code === "RATE_LIMITED" && decision.retryAfterMs !== undefined) {
    // The robots.txt request counts against the source's delay like any other.
    await deps.sleep(decision.retryAfterMs);
    decision = decideFetch({ subject, url, identity, robots, now: deps.now(), lastRequestAt: robotsAt, inFlight: 0 });
  }
  if (!decision.allowed) { note("decide", false, `${decision.code}: ${decision.reason}`); return report("refused", url); }
  note("decide", true, "allowed");

  const documentRef = existing?.documentRef ?? `KD-${randomUUID()}`;
  requests++;
  const collected = await collectorFor(kind).collect({
    sourceId, documentRef, url: decision.url, maxBytes: policy.maxBytes,
    ifNoneMatch: last?.etag ?? null, ifModifiedSince: last?.lastModified ?? null,
  }, env);
  note("collect", collected.body !== undefined || collected.httpStatus === 304,
    `HTTP ${collected.httpStatus ?? "no response"}${collected.body ? `, ${collected.body.byteLength} bytes` : ""}${collected.note ? ` — ${collected.note}` : ""}`);

  if (!existing) {
    const q = await quarantineDocument({
      documentRef, sourceId, title: source.sourceName.slice(0, 400), url: decision.url, purpose: "rag_ingestion",
      contentHash: collected.declaredSha256 ?? "0".repeat(64), fetchedAt: deps.now(), fetchedByUserId: deps.operatorUserId,
    });
    if (!q.stored) { note("document", false, q.reason); return report("failed", url); }
    note("document", true, `${documentRef} created QUARANTINED`);
  }

  // Parse before recording, so the version is compared on the text, not the page furniture.
  let extraction: SnapshotRequest["extraction"];
  let sections: ReturnType<typeof extractHtml> | null = null;
  if (kind === "html" && collected.body) {
    sections = extractHtml(collected.body);
    extraction = sections.ok
      ? { status: "extracted", parserVersion: sections.parserVersion, fingerprint: sections.fingerprint }
      : { status: "failed", parserVersion: sections.parserVersion, error: sections.error };
    note("extract", sections.ok, sections.ok ? `${sections.sections.length} sections` : sections.error);
  } else if (kind === "pdf" && collected.body) {
    note("extract", true, "PDF text extraction is not built; the bytes are hashed and extraction stays pending");
  }

  // Original bytes only where the licence allows keeping text.
  let rawObjectKey: string | null = null;
  if (collected.body && deps.storeRaw && checkSourceGate(sourceId, "rag_ingestion").allowed) {
    rawObjectKey = await deps.storeRaw(`knowledge/${sourceId}/${documentRef}/${collected.declaredSha256}`, collected.body, collected.contentType);
  }

  const snap = await recordSnapshot({
    sourceId, documentRef, result: collected, retrievedAt: deps.now(), rawObjectKey,
    recordedByUserId: deps.operatorUserId, extraction,
    provenance: { robots: robots.status, collectorNote: collected.note ?? null },
  });
  if (!snap.recorded) { note("snapshot", false, `${snap.code}: ${snap.reason}`); return report("failed", url); }
  note("snapshot", true, `${snap.snapshotRef}: ${snap.outcome}${snap.change ? " — change detected" : ""}`);

  let chunksWritten = 0;
  const isNew = snap.outcome === "first_seen" || snap.outcome === "changed";
  if (isNew && sections?.ok) {
    const release = await releaseFromQuarantine(documentRef);
    if (!release.released) {
      note("release", false, `text not stored: ${release.reason}`);
    } else {
      const drafts = chunkSections(sections.sections);
      const topics = Array.isArray(source.topicsJson) ? (source.topicsJson as string[]) : [];
      const w = await writeChunks(documentRef,
        drafts.map((c) => ({ chunkRef: `KC-${randomUUID()}`, ordinal: c.ordinal, text: c.text, ...(c.section ? { section: c.section } : {}) })),
        { snapshotRef: snap.snapshotRef, topics });
      note("chunks", w.written, w.written ? `${w.count} chunks under ${w.authorizedBy}` : `${w.code}: ${w.reason}`);
      if (w.written) chunksWritten = w.count;
    }
  }

  return report("recorded", url, { snapshotRef: snap.snapshotRef, outcome: snap.outcome, change: snap.change, chunksWritten });
}

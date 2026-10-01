/**
 * The requirement registry, read one way (C1b-2).
 *
 * Before this, three procedures answered "which requirements are in force" three ways:
 * `compliance.passport` read every stored row (every version, superseded or not) and dropped each
 * row's pack; `requirement.workAuthorization` ignored the table and read the seed constants; and
 * `requirement.packActivate` checked the pack against the seeds only, so a pack defined in
 * `compliancePacks` could not be activated. This module is the one reading all three use.
 *
 * Revisions are immutable. `requirementLoad` inserts a new version and never updates the one before
 * it; which revision governs is decided here, from the versions and their dates:
 *
 * * only revisions **recorded by** `at` count — today's registry is never applied to yesterday;
 * * of those, the highest version whose `effectiveFrom` has arrived governs;
 * * a later version that is not yet effective leaves the earlier one governing until its date, which
 *   the old in-place supersession got wrong: it marked the earlier version superseded the moment the
 *   later one was loaded, so for the interval between load and effect neither applied;
 * * a key present in the table suppresses the seed of the same key, even while its only revision is
 *   not yet effective — a loaded requirement is never silently replaced by the seed it replaced.
 *
 * C1b-2b: which revisions are *authoritative* is no longer read from `verificationStatus`. It is
 * read from the append-only verification events (`requirementVerification.ts`), and the selection
 * below prefers the highest verified revision in force. Rows written before 0198 — including those the
 * old one-step path marked `verified` — are UNVERIFIED until proposed and verified again.
 */
import { eq } from "drizzle-orm";
import { complianceRequirements, compliancePacks } from "../drizzle/schema";
import type { RequirementVerificationEventRow } from "../drizzle/schema";
import type { Requirement, RequirementStatus } from "./_core/compliancePassport";
import { COMPLIANCE_PACK_SEEDS } from "./_core/complianceRequirementSeeds";
import type { Pack } from "./_core/requirementEngine";
import { getDb } from "./db";
import { eventsByRequirement, levelAt, provenanceOf, type VerificationLevel } from "./requirementVerification";

type RequirementRow = typeof complianceRequirements.$inferSelect;

type Ev = RequirementVerificationEventRow;

/**
 * A revision's level at `at`. Revisions written before 0198 have no proposer and no events: whatever
 * their old `verificationStatus` said, a one-step controller verification is not evidence under
 * C1b-2b, so they are UNVERIFIED (or WITHDRAWN, if withdrawn) and must be proposed and verified again.
 */
function levelOf(row: RequirementRow, events: readonly Ev[], at: Date): Exclude<VerificationLevel, "SUPERSEDED"> {
  if (row.proposedByUserId == null && !events.length) return row.verificationStatus === "withdrawn" ? "WITHDRAWN" : "UNVERIFIED";
  return levelAt(events, at);
}

const authoritative = (l: VerificationLevel) => l === "CITATION_VERIFIED" || l === "SOURCE_DOCUMENT_VERIFIED";

export type GoverningRevision = { row: RequirementRow; level: VerificationLevel; status: RequirementStatus };

/**
 * Which revision of each key governs at `at` (canonical selection; pure).
 *
 * * Only revisions **recorded** by `at` count, and only events recorded by `at` decide their level —
 *   so a historic evaluation sees exactly the trust LeaseOS had then.
 * * Verification is not activation. Of the revisions that were verified (or withdrawn) by `at` and are
 *   in force at `at`, the highest version governs. A later verified revision that is not yet in force
 *   does not displace it; an unverified proposal never displaces a verified revision.
 * * If that revision is WITHDRAWN, the requirement no longer applies (the key is dropped).
 * * With no verified revision in force, the newest revision in force (else the newest) stands for the
 *   key, UNVERIFIED — it yields UNKNOWN, never READY — and the seed it replaced does not return.
 * * Overlap: proposals may not start before an existing revision; equal starts resolve to the higher
 *   version. A revision past its `effectiveUntil` still stands for its key and simply does not apply,
 *   so a gap between revisions is a gap, not a fallback to something older.
 */
export function governingRevisions(rows: readonly RequirementRow[], eventsById: ReadonlyMap<number, readonly Ev[]>, at: Date): GoverningRevision[] {
  const byKey = new Map<string, RequirementRow[]>();
  for (const r of rows) {
    if (r.createdAt > at) continue;
    (byKey.get(r.requirementKey) ?? byKey.set(r.requirementKey, []).get(r.requirementKey)!).push(r);
  }
  const out: GoverningRevision[] = [];
  for (const versions of Array.from(byKey.values())) {
    versions.sort((a, b) => b.version - a.version);
    const levels = new Map(versions.map((v) => [v.id, levelOf(v, eventsById.get(v.id) ?? [], at)]));
    const decided = versions.find((v) => v.effectiveFrom <= at && (authoritative(levels.get(v.id)!) || levels.get(v.id) === "WITHDRAWN"));
    if (decided) {
      const level = levels.get(decided.id)!;
      if (level === "WITHDRAWN") continue;
      out.push({ row: decided, level, status: "verified" });
      continue;
    }
    const chosen = versions.find((v) => v.effectiveFrom <= at) ?? versions[0];
    const level = levels.get(chosen.id)!;
    if (level === "WITHDRAWN") continue;
    // Verified but not yet in force: it stands for the key and applies from its date.
    out.push({ row: chosen, level, status: authoritative(level) ? "verified" : "unverified" });
  }
  return out;
}

/** Revisions of a key that a later verified revision in force has replaced, at `at`: SUPERSEDED. */
export function supersededAt(rows: readonly RequirementRow[], eventsById: ReadonlyMap<number, readonly Ev[]>, at: Date): Set<number> {
  const governing = new Map(governingRevisions(rows, eventsById, at).map((g) => [g.row.requirementKey, g]));
  const out = new Set<number>();
  for (const r of rows) {
    const g = governing.get(r.requirementKey);
    if (g && authoritative(g.level) && r.version < g.row.version && authoritative(levelOf(r, eventsById.get(r.id) ?? [], at))) out.add(r.id);
  }
  return out;
}

export type RegistryRequirement = Requirement & {
  /** Where the governing revision came from. A passport item carries it as its `requirementRef`. */
  origin: "registry" | "seed";
};

const fromRow = (r: RequirementRow, g: GoverningRevision, events: readonly Ev[], at: Date): RegistryRequirement => ({
  requirementKey: r.requirementKey, version: r.version, family: r.family, title: r.title,
  subjectType: r.subjectType, jurisdiction: r.jurisdiction, packKey: r.packKey,
  appliesWhen: r.appliesWhenJson ? JSON.parse(r.appliesWhenJson) : null,
  satisfiedByDocTypes: JSON.parse(r.satisfiedByDocTypes), renewalIntervalDays: r.renewalIntervalDays,
  warnDaysBeforeExpiry: r.warnDaysBeforeExpiry, missingSeverity: r.missingSeverity,
  verificationStatus: g.status, effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil,
  origin: "registry",
  provenance: provenanceOf(r, events, g.level, at),
});

/**
 * The requirements in the registry at `at` for one organization: the governing stored revision of
 * each key — the organization's own revisions, and rows written before 0198 (no organization) — then
 * every seed whose key has no stored revision. `tenantId` is the caller's acting organization from
 * server scope. `seeds` is the caller's seed set.
 */
export async function loadRequirementRegistry(seeds: readonly Requirement[], at: Date, tenantId: string): Promise<RegistryRequirement[]> {
  const seeded: RegistryRequirement[] = seeds.map((s) => ({ ...s, origin: "seed" as const }));
  const db = await getDb();
  if (!db) return seeded;
  const rows = (await db.select().from(complianceRequirements)).filter((r) => r.orgRef == null || r.orgRef === tenantId);
  const events = await eventsByRequirement(rows.map((r) => r.id));
  const storedKeys = new Set(rows.filter((r) => r.createdAt <= at).map((r) => r.requirementKey));
  const loaded = governingRevisions(rows, events, at).map((g) => fromRow(g.row, g, events.get(g.row.id) ?? [], at));
  return [...loaded, ...seeded.filter((s) => !storedKeys.has(s.requirementKey))];
}

/** Every pack LeaseOS knows: the stored packs, then each seed pack with no stored row of its key. */
export async function knownPacks(): Promise<Pack[]> {
  const db = await getDb();
  const stored: Pack[] = db
    ? (await db.select().from(compliancePacks)).map((p) => ({
        packKey: p.packKey, title: p.title, jurisdiction: p.jurisdiction, core: p.core,
        activatesWhen: p.activatesWhenJson ? JSON.parse(p.activatesWhenJson) : null,
      }))
    : [];
  const keys = new Set(stored.map((p) => p.packKey));
  return [...stored, ...COMPLIANCE_PACK_SEEDS.filter((p) => !keys.has(p.packKey))];
}

export async function packExists(packKey: string): Promise<boolean> {
  if (COMPLIANCE_PACK_SEEDS.some((p) => p.packKey === packKey)) return true;
  const db = await getDb();
  if (!db) return false;
  return (await db.select({ id: compliancePacks.id }).from(compliancePacks).where(eq(compliancePacks.packKey, packKey)).limit(1)).length > 0;
}

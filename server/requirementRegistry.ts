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
 * Rows the old path marked `superseded` in place keep that mark (no history is rewritten). Their
 * original status is recovered from `verifiedByUserId`, which the old path never cleared.
 */
import { eq, lte } from "drizzle-orm";
import { complianceRequirements, compliancePacks } from "../drizzle/schema";
import type { Requirement, RequirementStatus } from "./_core/compliancePassport";
import { COMPLIANCE_PACK_SEEDS } from "./_core/complianceRequirementSeeds";
import type { Pack } from "./_core/requirementEngine";
import { getDb } from "./db";

type RequirementRow = typeof complianceRequirements.$inferSelect;

/** The stored status of the revision chosen, with the old path's in-place `superseded` undone. */
function statusOf(row: RequirementRow, chosenOverLaterVersion: boolean): RequirementStatus {
  if (row.verificationStatus === "superseded" && chosenOverLaterVersion) {
    return row.verifiedByUserId != null ? "verified" : "unverified";
  }
  return row.verificationStatus;
}

/**
 * Which revision of each key governs at `at`. Pure, so the rule is testable without a database.
 * Returns one row per key, or none for a key withdrawn in its governing revision.
 */
export function governingRevisions(rows: readonly RequirementRow[], at: Date): { row: RequirementRow; status: RequirementStatus }[] {
  const byKey = new Map<string, RequirementRow[]>();
  for (const r of rows) {
    if (r.createdAt > at) continue;
    (byKey.get(r.requirementKey) ?? byKey.set(r.requirementKey, []).get(r.requirementKey)!).push(r);
  }
  const out: { row: RequirementRow; status: RequirementStatus }[] = [];
  for (const versions of Array.from(byKey.values())) {
    versions.sort((a, b) => b.version - a.version);
    const inForce = versions.find((v) => v.effectiveFrom <= at);
    // Nothing effective yet: the newest non-withdrawn revision still stands for the key (and applies
    // from its date), so the seed it replaced does not come back in the meantime. A future-dated
    // withdrawn revision does not withdraw the key early; the latest earlier non-withdrawn revision
    // keeps governing until that withdrawn revision's own date.
    const chosen = inForce ?? versions.find((v) => v.verificationStatus !== "withdrawn") ?? versions[0];
    const status = statusOf(chosen, chosen !== versions[0]);
    if (status === "withdrawn") continue;
    // `effectiveUntil` is kept as stored. Where the old path set it on loading the next revision, it
    // equals that revision's `effectiveFrom`, so it ends exactly when the next one begins.
    out.push({ row: chosen, status });
  }
  return out;
}

export type RegistryRequirement = Requirement & {
  /** Where the governing revision came from. A passport item carries it as its `requirementRef`. */
  origin: "registry" | "seed";
};

const fromRow = (r: RequirementRow, status: RequirementStatus): RegistryRequirement => ({
  requirementKey: r.requirementKey, version: r.version, family: r.family, title: r.title,
  subjectType: r.subjectType, jurisdiction: r.jurisdiction, packKey: r.packKey,
  appliesWhen: r.appliesWhenJson ? JSON.parse(r.appliesWhenJson) : null,
  satisfiedByDocTypes: JSON.parse(r.satisfiedByDocTypes), renewalIntervalDays: r.renewalIntervalDays,
  warnDaysBeforeExpiry: r.warnDaysBeforeExpiry, missingSeverity: r.missingSeverity,
  verificationStatus: status, effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil,
  origin: "registry",
});

/**
 * The requirements in the registry at `at`: the governing stored revision of each key, then every
 * seed whose key has no stored revision. `seeds` is the caller's seed set — the passport reads the
 * compliance seeds, work authorization reads those and the equipment seeds.
 */
export async function loadRequirementRegistry(seeds: readonly Requirement[], at: Date = new Date()): Promise<RegistryRequirement[]> {
  const seeded: RegistryRequirement[] = seeds.map((s) => ({ ...s, origin: "seed" as const }));
  const db = await getDb();
  if (!db) return seeded;
  const rows = await db.select().from(complianceRequirements).where(lte(complianceRequirements.createdAt, at));
  const storedKeys = new Set(rows.map((r) => r.requirementKey));
  const loaded = governingRevisions(rows, at).map(({ row, status }) => fromRow(row, status));
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
  const merged = new Map(COMPLIANCE_PACK_SEEDS.map((p) => [p.packKey, { ...p }]));
  for (const p of stored) {
    const seed = merged.get(p.packKey);
    merged.set(p.packKey, seed
      ? { ...seed, ...p, activatesWhen: p.activatesWhen ?? seed.activatesWhen }
      : p);
  }
  return Array.from(merged.values());
}

export async function packExists(packKey: string): Promise<boolean> {
  if (COMPLIANCE_PACK_SEEDS.some((p) => p.packKey === packKey)) return true;
  const db = await getDb();
  if (!db) return false;
  return (await db.select({ id: compliancePacks.id }).from(compliancePacks).where(eq(compliancePacks.packKey, packKey)).limit(1)).length > 0;
}

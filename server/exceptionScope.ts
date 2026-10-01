/**
 * TEN-EXC-1 — who owns an Exception Centre record, as one SQL expression per kind of owner.
 *
 * Each `ownerOf.*` expression evaluates, inside the query, to exactly one of:
 *   - an organization's ref, when the record's owner is proved;
 *   - SINGLE_TENANT_ID ("default"), when the record exists and nothing has ever claimed it — the
 *     historical single tenant's row, visible to the default scope only (the repo's 0132 rule);
 *   - NULL, when ownership is UNRESOLVED: the referenced record does not exist, a person belongs to
 *     more than one organization, or a stamp that ought to be there is missing.
 *
 * `ownedBy` then admits a row only when EVERY owner it carries equals the caller's organization.
 * NULL never equals anything, so an unresolved row is visible to nobody, and a row whose links name
 * two organizations is visible to neither. A missing owner is never global.
 *
 * Nothing here reads request input: the scope comes from the session (`actingScopeFor`), and the
 * owners come from the records' own links. Authorization (which permission an exception needs) stays
 * in `visibleTo`; this file decides only WHOSE record it is.
 */
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import type { TenantScope } from "./db";

type Owner = SQL<string | null>;
type Ref = MySqlColumn | SQL;
const D = SINGLE_TENANT_ID;

export const ownerOf = {
  /** A unit: its coreRecordOwnership row (unique per record), else the single tenant. */
  unit: (id: Ref): Owner =>
    sql<string | null>`(SELECT COALESCE(o.orgRef, ${D}) FROM units u LEFT JOIN coreRecordOwnership o ON o.recordType = 'unit' AND o.recordId = u.id WHERE u.id = ${id})`,
  /** An operator: its coreRecordOwnership row, else the single tenant. */
  operator: (id: Ref): Owner =>
    sql<string | null>`(SELECT COALESCE(o.orgRef, ${D}) FROM operators p LEFT JOIN coreRecordOwnership o ON o.recordType = 'operator' AND o.recordId = p.id WHERE p.id = ${id})`,
  job: (id: Ref): Owner => sql<string | null>`(SELECT COALESCE(j.orgRef, ${D}) FROM jobs j WHERE j.id = ${id})`,
  trip: (id: Ref): Owner => sql<string | null>`(SELECT COALESCE(t.orgRef, ${D}) FROM trips t WHERE t.id = ${id})`,
  /** A financial entity (0146): the tenant boundary for money, devices, policies and periods. */
  entity: (id: Ref): Owner => sql<string | null>`(SELECT COALESCE(f.orgRef, ${D}) FROM financialEntities f WHERE f.id = ${id})`,
  /** A vendor, by the book that keeps it (0149 bookOrgRef) — not the vendor's own organization. */
  vendor: (id: Ref): Owner => sql<string | null>`(SELECT COALESCE(v.bookOrgRef, ${D}) FROM vendors v WHERE v.id = ${id})`,
  /**
   * A person, by membership, with the same rule `resolveActingScope` acts on: active memberships in
   * effect at `now`. None → the single tenant; one organization → that one; more than one → NULL.
   * A person in two organizations cannot be attributed to either without a decision nobody recorded.
   * A user id naming nobody → NULL (GROUP BY yields no row).
   */
  user: (id: Ref, now: Date): Owner =>
    sql<string | null>`(SELECT CASE COUNT(DISTINCT m.orgRef) WHEN 0 THEN ${D} WHEN 1 THEN MIN(m.orgRef) ELSE NULL END
      FROM users x LEFT JOIN organizationMemberships m ON m.userId = x.id AND m.status = 'active' AND m.effectiveFrom <= ${now} AND (m.effectiveTo IS NULL OR m.effectiveTo > ${now})
      WHERE x.id = ${id} GROUP BY x.id)`,
  /**
   * A field device: the organization stamped at enrolment (deviceRouter.enroll writes the acting
   * tenant, "default" included). A NULL stamp predates the column and proves nothing → NULL.
   */
  device: (id: Ref): Owner => sql<string | null>`(SELECT d.orgRef FROM fieldDevices d WHERE d.id = ${id})`,
  /** A sync package, by the device that sent it. A package with no device (or a legacy device) → NULL. */
  syncPackage: (id: Ref): Owner => sql<string | null>`(SELECT d.orgRef FROM syncPackages s JOIN fieldDevices d ON d.id = s.fieldDeviceId WHERE s.id = ${id})`,
  /** An academy certificate, by its holder's membership. A certificate naming nobody → NULL. */
  certificate: (id: Ref, now: Date): Owner => ownerOf.user(sql`(SELECT c.userId FROM academyCertificates c WHERE c.id = ${id})`, now),
  /** A dispatch eligibility check (0174): the organization that took it, NULL = the single tenant (`checkInScope`). */
  eligibilityCheck: (id: Ref): Owner => sql<string | null>`(SELECT COALESCE(c.orgRef, ${D}) FROM dispatchEligibilityChecks c WHERE c.id = ${id})`,
  /** An AI proposal: its proved owner (0210). A legacy_unresolved proposal has none → NULL. */
  proposal: (proposalId: Ref): Owner => sql<string | null>`(SELECT p.tenantId FROM assistantProposals p WHERE p.proposalId = ${proposalId})`,
};

/**
 * A row is the scope's only when every owner it carries is the scope's organization.
 * - `required`: owners the row always has (a NOT NULL link, or the row's own stamp).
 * - `optional`: [link column, owner] pairs — when the link is set its owner must agree; when it is
 *   NULL the row simply does not name that kind of record.
 */
export function ownedBy(scope: TenantScope, required: readonly Owner[], optional: readonly (readonly [MySqlColumn, Owner])[] = []) {
  if (required.length === 0) throw new Error("ownedBy needs at least one required owner; a row with no owner belongs to nobody");
  return and(
    ...required.map(o => eq(o, scope.tenantId)),
    ...optional.map(([link, o]) => or(isNull(link), eq(o, scope.tenantId))),
  );
}

/**
 * A credential (complianceDocuments) by the kind of record it is about. Operators and units (trailers
 * and equipment are units) by coreRecordOwnership, jobs by jobs.orgRef, a person with no operator row
 * by membership. A `carrier` document has no ownership model on this branch, so it is UNRESOLVED and
 * shown to nobody — "no owner" is not "everyone's".
 */
export function credentialOwner(ownerType: MySqlColumn, ownerId: MySqlColumn, now: Date): Owner {
  return sql<string | null>`(CASE ${ownerType}
    WHEN 'operator' THEN ${ownerOf.operator(ownerId)}
    WHEN 'unit' THEN ${ownerOf.unit(ownerId)}
    WHEN 'trailer' THEN ${ownerOf.unit(ownerId)}
    WHEN 'equipment' THEN ${ownerOf.unit(ownerId)}
    WHEN 'job' THEN ${ownerOf.job(ownerId)}
    WHEN 'user' THEN ${ownerOf.user(ownerId, now)}
    ELSE NULL END)`;
}

/**
 * The dispatch role-type catalog — what a dispatch role slot may be called, and what it defaults to
 * requiring.
 *
 * `roleCode` is neither an enum nor free text, and both halves of that were deliberate.
 *
 * Not free text, because `jobUnits.role` already is: `varchar(100)`, unvalidated, written with
 * whatever the caller felt like and read by nothing on the server. A field nobody can rely on is a
 * field that stops carrying meaning, and that is how the old assignment row lost its shape.
 *
 * Not an enum, because LeaseOS supporting another trucking role should be a row, not a migration.
 * The rig move in the schema comment above `dispatchRoles` — a lead, winch tractors, a bed truck, a
 * picker, pilot vehicles — is one operation's vocabulary, not the industry's.
 *
 * **`orgRef IS NULL` means "every tenant may use this" here**, which is a deliberate departure from
 * the rest of the repository, where NULL marks the historical single tenant's own rows
 * (`server/db.ts:154-164`). A catalog is shared vocabulary rather than an owned record, so it must
 * not be read with `orgScopeWhere`: for a real tenant that helper emits `eq(orgRef, tenantId)`,
 * which matches no NULL row, and the caller would be handed an empty catalog and then told every
 * seeded code was unknown. The read is `orgRef IS NULL OR orgRef = :tenantId`.
 */

export type RoleType = {
  /** Stable machine code. Never displayed raw. */
  roleCode: string;
  /** NULL = available to every tenant. Non-null = that organization's own definition. */
  orgRef: string | null;
  displayName: string;
  description: string | null;
  /**
   * Seeds a new slot's `requiredEquipmentClass`. A **default**, copied at creation — never a live
   * pointer, or editing the catalog would silently restate what an existing posting requires.
   */
  defaultEquipmentClass: string | null;
  defaultTrailerClass: string | null;
  active: boolean;
};

const usable = (t: RoleType) => t.active;

/**
 * The type this tenant means by `code`, or null.
 *
 * Tenant-first, then global. A tenant that deactivates its own override falls back to the global
 * type rather than losing the code, because turning off a local variant must not break every
 * posting that names it.
 */
export function resolveRoleType(
  code: string,
  tenantId: string,
  rows: readonly RoleType[],
): RoleType | null {
  const named = rows.filter(t => t.roleCode === code);
  const mine = named.find(t => t.orgRef !== null && t.orgRef === tenantId && usable(t));
  if (mine) return mine;
  return named.find(t => t.orgRef === null && usable(t)) ?? null;
}

/**
 * Everything this tenant may use: the global catalog plus its own additions, with its own
 * definition shadowing a global one of the same code. Another tenant's types are never included.
 */
export function visibleRoleTypes(tenantId: string, rows: readonly RoleType[]): RoleType[] {
  const codes = Array.from(new Set(rows.filter(usable).map(t => t.roleCode)));
  return codes
    .map(code => resolveRoleType(code, tenantId, rows))
    .filter((t): t is RoleType => t !== null);
}

/**
 * What a new slot inherits from its type. Returned as plain values so the caller writes them onto
 * the role row — the snapshot, rather than a reference the catalog could later move.
 */
export function requirementDefaultsOf(t: RoleType): {
  requiredEquipmentClass: string | null;
  requiredTrailerClass: string | null;
} {
  return {
    requiredEquipmentClass: t.defaultEquipmentClass,
    requiredTrailerClass: t.defaultTrailerClass,
  };
}

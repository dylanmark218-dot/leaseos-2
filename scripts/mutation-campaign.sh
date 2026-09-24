#!/usr/bin/env bash
# The tenant-scope checkpoint's mutation campaign, run in one pass.
#
# Every defect closed on this branch is represented by at least one mutation
# that puts the defect back. Each is applied to a clean tree, run against the
# tests that are supposed to notice, and reverted before the next one — so a
# mutation can never be killed by a previous mutation's damage.
#
# Run on the FINAL head rather than trusting the runs done alongside each
# commit: a mutation killed at the commit that introduced its fix can start
# surviving later, when a subsequent change weakens the test that was killing
# it. That is the whole reason this is re-run in one pass at the end.
#
# Usage: DATABASE_URL=mysql://user:pass@host:port/db bash scripts/mutation-campaign.sh
# The database is created and migrated by this script. A SURVIVOR is a failure.
set -uo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"

cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"
trap 'git checkout -q -- . 2>/dev/null; rm -rf "$WORK"' EXIT

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "FAIL: working tree is dirty; the campaign reverts by checkout and would discard it."
  exit 1
fi

MATRIX=server/crossTenantIsolation.db.test.ts
SYNC=server/syncTenantIsolation.db.test.ts
SWITCH=server/organizationSwitch.test.ts
BOOK=server/commercialBookScope.test.ts
OFFICE=server/commercialOffice.db.test.ts

survivors=(); killed=0
run() {
  local name="$1" file="$2" expr="$3"; shift 3
  git checkout -q -- .
  perl -0pi -e "$expr" "$file"
  if git diff --quiet -- "$file"; then
    echo "  !! $name :: EXPRESSION MATCHED NOTHING (the code moved; this mutation proves nothing)"
    survivors+=("$name [not applied]")
    git checkout -q -- .
    return
  fi
  local out; out="$(pnpm exec vitest run "$@" 2>&1 | grep -E '^ +Tests +' | tail -1)"
  # A mutation is killed if ANY test failed, or if the mutant does not compile.
  if echo "$out" | grep -q "failed"; then
    echo "  ok $name :: killed —$out"
    killed=$((killed + 1))
  elif ! pnpm exec tsc --noEmit >/dev/null 2>&1; then
    echo "  ok $name :: killed by the typechecker"
    killed=$((killed + 1))
  else
    echo "  !! $name :: SURVIVED —$out"
    survivors+=("$name")
  fi
  git checkout -q -- .
}

echo "== F1 — a link may only name a record the book can see =="
run "MUT-F1a vendor book predicate dropped" server/commercialOfficeRouter.ts \
  's/\.where\(and\(eq\(vendors\.id, recordId\), myBookOnly\(vendors, bookOrgRef\)\)\)/.where(eq(vendors.id, recordId))/' \
  "$MATRIX" "$OFFICE"
run "MUT-F1b job organization predicate dropped" server/commercialOfficeRouter.ts \
  's/\.where\(and\(eq\(jobs\.id, recordId\), orgScopeWhere\(jobs, \{ tenantId: bookOrgRef \?\? SINGLE_TENANT_ID \}\)\)\)/.where(eq(jobs.id, recordId))/' \
  "$MATRIX" "$OFFICE"

echo "== F2 — dispatch checks the identities it was handed =="
run "MUT-F2a operator predicate removed" server/dispatchRouter.ts \
  's/  if \(!\(await operatorInScope\(s\.operatorId, scope\)\)\) throw notFound\(`Operator \$\{s\.operatorId\}`\);\n//' \
  "$MATRIX"
run "MUT-F2b unit predicate removed" server/dispatchRouter.ts \
  's/  if \(s\.unitId != null && !\(await unitInScope\(s\.unitId, scope\)\)\) throw notFound\(`Unit \$\{s\.unitId\}`\);\n//' \
  "$MATRIX"
run "MUT-F2c the check's subject check removed" server/dispatchRouter.ts \
  's/    await assertSubjectInScope\(scope, \{ operatorId: check\.operatorId, unitId: check\.unitId, trailerId: check\.trailerId, jobId: check\.jobId \}\);/    void scope;/' \
  "$MATRIX"

echo "== F3 — the scanner takes ownership from the subject =="
run "MUT-F3a out_of_scope treated as in_scope" server/scanningRouter.ts \
  's/if \(resolved\.kind === "in_scope"\) \{/if (resolved.kind === "in_scope" || resolved.kind === "out_of_scope") {/' \
  "$MATRIX"
run "MUT-F3b minted-number lookup unscoped" server/scanningRouter.ts \
  's/\.where\(and\(eq\(trackingReferences\.trackingNumber, n\), orgScopeWhere\(trackingReferences, scope\)\)\)/.where(eq(trackingReferences.trackingNumber, n))/' \
  "$MATRIX"

echo "== F5 — a selected organization is re-validated every request =="
run "MUT-F5a stored selection accepted without re-validation" server/_core/actingScope.ts \
  's/      \? memberships\.find\(\(m: \{ membershipRef: string; orgRef: string \}\) =>\n          m\.membershipRef === selected\.membershipRef && m\.orgRef === selected\.orgRef\)/      ? { orgRef: selected.orgRef, membershipRef: selected.membershipRef, branchId: null }/' \
  "$MATRIX"
run "MUT-F5b ambiguity resolved by taking the first membership" server/_core/actingScope.ts \
  's/    throw new AmbiguousOrganization\(/    return { tenantId: orgs[0]!, derivedFrom: "selection", membershipRef: null, branchRefs, global };\n    throw new AmbiguousOrganization(/' \
  "$MATRIX"

echo "== Tracking — a minted number is tenant-relative =="
run "MUT-T1 counter ignores the organization" server/_core/trackingNumbers.ts \
  's/  const orgKey = args\.orgRef \?\? "~unattributed";/  const orgKey = "~unattributed";/' \
  "$MATRIX"
run "MUT-T2 sequence row loses its owner" server/_core/trackingNumbers.ts \
  's/  const owner: string \| null = args\.orgRef \?\? null;/  const owner: string | null = null;/' \
  "$MATRIX"

echo "== F4 — unknown ownership is not shared ownership in the book =="
run "MUT-F4a vendors read overlaid again" server/commercialOfficeRouter.ts \
  's/myBookOnly\(vendors, bookOrgRef\)/seededConfigLayer(vendors, bookOrgRef)/' "$BOOK" "$MATRIX"
run "MUT-F4b GL accounts read overlaid again" server/commercialOfficeRouter.ts \
  's/myBookOnly\(commercialGlAccounts, bookOrgRef\)/seededConfigLayer(commercialGlAccounts, bookOrgRef)/g' "$BOOK" "$MATRIX"
run "MUT-F4c facility statements read overlaid again" server/commercialOfficeRouter.ts \
  's/myBookOnly\(facilityStatements, bookOrgRef\)/seededConfigLayer(facilityStatements, bookOrgRef)/' "$BOOK" "$MATRIX"
run "MUT-F4d conflict always names the foreign counterparty" server/commercialOfficeRouter.ts \
  's/message: mine\n              \? /message: true\n              ? /' "$MATRIX" "$OFFICE"
run "MUT-F4e seeded config layer made strict" server/commercialOfficeRouter.ts \
  's/  bookOrgRef \? or\(isNull\(t\.bookOrgRef\), eq\(t\.bookOrgRef, bookOrgRef\)\) : isNull\(t\.bookOrgRef\);/  bookOrgRef ? eq(t.bookOrgRef, bookOrgRef) : isNull(t.bookOrgRef);/' "$OFFICE" "$MATRIX"
run "MUT-F4f GL mapping falls back to an unowned account" server/commercialOfficeRouter.ts \
  's/const mapped = \(kind: string, key: string\) => mappings\.find\(m => m\.mappingKind === kind && m\.mappingKey === key\) \?\? null;/const mapped = (kind: string, key: string) => mappings.find(m => m.mappingKind === kind \&\& m.mappingKey === key \&\& m.bookOrgRef === bookOrgRef) ?? mappings.find(m => m.mappingKind === kind \&\& m.mappingKey === key \&\& m.bookOrgRef === null) ?? null;/' "$OFFICE"

echo "== F6 — a refusal does not say whether the device exists =="
run "MUT-F6a loadDevice unscoped again" server/deviceRouter.ts \
  's/\.where\(and\(eq\(fieldDevices\.deviceRef, deviceRef\), orgScopeWhere\(fieldDevices, scope\)\)\)/.where(eq(fieldDevices.deviceRef, deviceRef))/' "$MATRIX"
run "MUT-F6b missing device answers FORBIDDEN" server/deviceRouter.ts \
  's/const noSuchDevice = \(what = "Device not found"\) => new TRPCError\(\{ code: "NOT_FOUND"/const noSuchDevice = (what = "Device not found") => new TRPCError({ code: "FORBIDDEN"/' "$MATRIX"
run "MUT-F6c sync falls through to the legacy message" server/deviceRouter.ts \
  's/      if \(!d\) throw noSuchDevice\(\);\n      const history = await db\.select\(\)/      const history = await db.select()/' "$MATRIX"

echo "== S — a device identifier does not reach across organizations =="
run "MUT-S1a evidence scope gate removed" server/deviceRouter.ts \
  's/      for \(const it of items\) \{\n        if \(!\(await evidenceInScope\(it\.evidenceRecordId, scope\)\)\) \{\n          return refuse\("Package names evidence this organization cannot see"\);\n        \}\n      \}\n\n//' "$SYNC"
run "MUT-S1b refusal names the offending id" server/deviceRouter.ts \
  's/return refuse\("Package names evidence this organization cannot see"\);/return refuse(`Package names evidence this organization cannot see: \${it.evidenceRecordId}`);/' "$SYNC"
run "MUT-S3a package row loses its device" server/deviceRouter.ts \
  's/packageRef: input\.packageRef, deviceId: input\.deviceRef, fieldDeviceId: d\.id,\n        signedWithFingerprint/packageRef: input.packageRef, deviceId: input.deviceRef, fieldDeviceId: null,\n        signedWithFingerprint/' "$SYNC"
run "MUT-S4a capture lookup unscoped again" server/db.ts \
  's/\.where\(and\(eq\(evidenceRecords\.clientCaptureRef, clientCaptureRef\), eq\(evidenceRecords\.capturedBy, capturedBy\)\)\)/.where(eq(evidenceRecords.clientCaptureRef, clientCaptureRef))/' "$SYNC"

echo "== W — the organization-switch contract =="
run "MUT-W1 unsent captures no longer block the switch" shared/organizationSwitch.ts \
  's/  if \(state\.unsentCaptures > 0\) \{/  if (false \&\& state.unsentCaptures > 0) {/' "$SWITCH"
run "MUT-W2 purge names the TARGET namespace" shared/organizationSwitch.ts \
  's/\{ step: "purge_tenant_cache", of: syncNamespace\(state\.holding\) \}/{ step: "purge_tenant_cache", of: syncNamespace(state.target) }/' "$SWITCH"
run "MUT-W3 an extra resync runs before the namespace switch" shared/organizationSwitch.ts \
  's/    \{ step: "halt_sync" \},/    { step: "halt_sync" }, { step: "resync" },/' "$SWITCH"
run "MUT-W4 permissions reloaded after the purge" shared/organizationSwitch.ts \
  's/    \{ step: "reload_permissions" \},\n    \{ step: "purge_tenant_cache", of: syncNamespace\(state\.holding\) \},/    { step: "purge_tenant_cache", of: syncNamespace(state.holding) },\n    { step: "reload_permissions" },/' "$SWITCH"
run "MUT-W5 unattributed shares the root namespace" shared/organizationSwitch.ts \
  's/return orgRef === null \? "org:~unattributed" : `org:\$\{orgRef\}`;/return orgRef === null ? "" : `org:\${orgRef}`;/' "$SWITCH" "$MATRIX"
run "MUT-W6 re-enrolment step dropped" shared/organizationSwitch.ts \
  's/  if \(state\.deviceBoundTo !== state\.target\) \{/  if (false \&\& state.deviceBoundTo !== state.target) {/' "$SWITCH"

echo
echo "=================================================="
echo "killed:    $killed"
echo "survivors: ${#survivors[@]}"
for s in "${survivors[@]:-}"; do [ -n "$s" ] && echo "  - $s"; done
echo "=================================================="
[ "${#survivors[@]}" -eq 0 ] || exit 1

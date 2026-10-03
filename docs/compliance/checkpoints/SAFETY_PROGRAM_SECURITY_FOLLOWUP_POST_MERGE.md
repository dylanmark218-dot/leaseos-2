# Safety & Compliance Program Builder — security follow-up, post-merge checkpoint (frozen)

**Frozen at:** `origin/main` **`5283a8e`** (`5283a8eaed67f44cd4e3518e737b210279702cc8`), the merge of PR #140
"fix(security): enforce tenant boundaries in safety compliance program", merged 2026-10-03T23:22:29Z.
This record is not updated after the fact; a later change gets its own checkpoint.

## What the merge is

PR #99 (the Safety & Compliance Program Builder, migration `0228`) merged before its post-merge security review
completed. #140 closes the tenant-isolation defects that review found. It merged from head `56a410b`, whose
first parent already contained `main` `832ba0a`. The merge commit's tree is identical to the gated head's
(`2d3293e` for both), so the gate result below is the result for `5283a8e` itself.

## Recorded state

| Measure | Value |
|---|---|
| Merge SHA | `5283a8e` |
| Migration head | `0241_safety_program_event_chain_unique.sql` |
| Migrations | 212 (`drizzle/*.sql`; slots 0016/0017 reserved and absent) |
| Tables | 490 declared in `drizzle/schema.ts`, 490 created by migrations (parity) |
| Test suite (gate stage 6) | 7,719 passed, 3 skipped (7,722) in 506 files |
| Fixture isolation (gate stage 6b) | 67 passed in 4 files |
| Test files / `it(` cases (gate stage 8 metrics) | 506 / 6,852 |
| Test-file type errors | 0 (pinned ceiling 0) |
| Role-authorized procedures | 925; bare `protectedProcedure` 0; ungated sites pinned 13 |
| `safetyProgram.*` procedures | 38, all `roleProcedure` |
| Gate | `scripts/ci-gate.sh` PASS on the identical tree (`56a410b`); `CI / test` green on `56a410b` |
| Dependency audit | `pnpm audit --audit-level high`: 0 high, 0 critical |
| Next free migration slot | **`0244`** (`0242`–`0243` held by `claude/fleet-equipment-portfolio-design-3d13d5`; scan of all 144 remote branches) |

## Security boundary status

Every refusal is NOT_FOUND: another organization's record does not exist from the caller's side. Each row is
covered by `server/safetyProgram.db.test.ts`, case "refuses every identifier from another organization, keeps
platform work out of an organization's view, and keeps one chain under concurrency".

| Boundary | Status on `5283a8e` | Enforced by |
|---|---|---|
| Training matrix: named workers | Closed. Another organization's user is refused. | `userInScope` |
| Policy owner | Closed | `userInScope` on `ownerUserId` |
| Corrective-action assignee | Closed | `userInScope` on `assignedToUserId` |
| Overlay customer account and evidence; corrective-action evidence | Closed | `customerAccounts` through `orgScopeWhere`; `evidenceInScope` |
| Policy-version and training-requirement overlay references | Closed | the overlay must be the caller's organization's |
| Regulatory references (shared by every organization) | Closed to organizations. `referenceUpsert` and `referenceVerify` refuse any caller acting in an organization. | `requirePlatformScope` |
| Event ledger visibility | Closed. Only the caller's organization's events; a break outside it is reported without its reference. | `orgScopeWhere` |
| Single-tenant workforce and COR counts | Closed. They follow main's single-tenant rule (0132). | `jobScope`, `workforce()` |
| Concurrent audit-chain writes | Closed. One successor per event, and the writer retries the refused insert. | `0241` UNIQUE `previousHash` |
| Financial entity on the program | Closed (from the #99 reconciliation) | `assertEntityInScope` |
| Qualifications and document validity | Canonical readers (from the #99 reconciliation) | `effectiveQualifications`, `complianceDocumentValidity` |

**Mutation proof:** removing the matrix tenant check, the reference scope rule and the audit-chain retry, one
at a time, each made the suite fail; restoring each made it pass.

**Open item (recorded, not resolved here):** #61 (F1.3) added `main`'s platform-authority model for
configuration shared by every organization. That model is `platformOrOrganizationProcedure`:
`users.role = "admin"`, plus a bootstrap exception while no organization exists. The regulatory-reference
writers use the narrower rule above instead. No organization can reach them under either rule, and no
guard requires the wrapper today. Moving them onto F1.3 is the owner's decision and would be its own change.

## Not changed

`0228_safety_program_builder.sql` was not modified. The ledger checksums applied files, so the uniqueness guard
is a separate migration. Its slot history: drafted `0233`, then moved to `0236`, `0237` and finally `0241`, each
time to the first slot above every claim (see `docs/architecture/MIGRATION_COLLISION_REGISTER.md`, "Claim: 0241").

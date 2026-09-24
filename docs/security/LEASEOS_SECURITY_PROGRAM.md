# LeaseOS security program — decomposed tranches

Against `origin/main` = `6f52b57`. Each tranche is an independently reviewable branch and pull request; none
depends on a later one; migration numbers are assigned only inside the tranche that needs them, at merge time,
against the collision register. Every tranche is tests-first with negative cases, passes `bash scripts/ci-gate.sh`
with a disposable MariaDB, regenerates `LEASEOS_CURRENT_STATE.md`, and changes no security semantics it does not
name.

## The order, and what changed from the work order's suggestion

The work order proposed SEC-1 = unified identity, SEC-2 = sessions, SEC-3 = passkeys, SEC-4 = portal/session UI,
SEC-5 = privileged access, SEC-6 = tenant/resource hardening, and so on. Repository evidence moves three things:

1. **Tenant and resource authorization hardening moves from sixth to first.** The baseline confirmed two
   cross-tenant write paths, two medical disclosures and a dozen unscoped reads, all reachable with an ordinary
   account. Each fix is a predicate the codebase already has an idiom for, needs no migration and no owner
   decision, and has a database-test idiom to copy. It is the shortest path to closing what a tester finds first.
2. **Identity and passkeys move from first to fourteenth.** Staff identity comes from an external OAuth provider;
   whether passkeys are possible is a provider decision, not code. Building WebAuthn locally before that answer
   would create the second authentication path the work order warns against.
3. **Perimeter and secure defaults become a tranche of their own (SEC-3)** because the CORS/headers/rate-limit gap
   is independent of sessions and small enough to land early.

Everything else keeps the work order's intent; numbers are reassigned so the sequence reads in execution order.

| # | Tranche | Closes (baseline §17) | Owner decision first? | Schema change? | Depends on |
|---|---|---|---|---|---|
| **SEC-0** | Security boundary survey and threat model — **this run** | — | no | no | — |
| **SEC-1** | Tenant and resource authorization hardening | V2, V3, V4, V6, V8, V9 (scope and permission halves), V11, V12 (ownership), V15 (port `3c4f997`) | no | no | SEC-0 |
| **SEC-2** | Session lifecycle and revocation | V1, part of V5, session/device ids in audit (V18) | timeouts; Bearer/preview path | yes: `sessions` | SEC-1 |
| **SEC-3** | Perimeter and secure defaults | V7, V14, V20, `errorFormatter`, boot assertions, worker assertion | rate-limit values | no | — |
| **SEC-4** | Privileged access, step-up and elevation (incl. session/device inventory UI) | V10, V19, T4 | step-up set; two-person set | yes: assurance on sessions, `privilegedElevations`, `roleEvents` | SEC-2 |
| **SEC-5** | Organization-scoped grants and membership lifecycle | V5 and the deferred design's §4 questions; structural `ctx.scope` and `scopedDb`; org columns on the listed tables | yes | yes | SEC-1, SEC-2 |
| **SEC-6** | Data classification and Restricted Records consolidation | classification enum, class-driven projection, HIGHLY_RESTRICTED mapping, export/print/offline/AI eligibility, vault break-glass validation and hash chain | classification map | yes | SEC-4, SEC-5 |
| **SEC-7** | Medical / private-vault | baseline §10 in full (Layers 1–3, custodian model, dispatch projection) | the eight open decisions | yes | SEC-6, SEC-8 |
| **SEC-8** | Encryption and key-management architecture | V13 (key ids, separate KEKs, rotation), envelope module, session key ring, DB TLS documented | KMS availability | yes: key id columns | SEC-3 |
| **SEC-9** | Secrets and service-identity management | V13 (per-service credentials), V11 (inbound HMAC, lockout writer, key rotation), worker service identity, rotation register | platform credentials | yes: `serviceIdentities` | SEC-8 |
| **SEC-10** | CI/CD secure-development gates | V17, duplicate-prefix gate, SHA pins, SBOM, scanning, security test families as gates | tool choice per dependency rule | no | — |
| **SEC-11** | Audit integrity and security detection | V18 (triggers, DB role model, `authEvents`, `securityConfigEvents`), detection rules → `securitySignals` | thresholds | yes | SEC-2 |
| **SEC-12** | AI / RAG / tool authorization hardening | V21, V22, T9: fencing, admission for every prompt input, zod output, timeouts, allow-listed hosts, LLM-only credential, model audit, `UNTRUSTED_CONTENT_CANNOT_GRANT_AUTHORITY` tests | no | no (columns on proposals) | SEC-1 |
| **SEC-13** | Incident response and evidence security | baseline §14: state table, permission split, evidence validation and hashing, server timestamps, owner and recovery fields, automatic signals intake | small | yes | SEC-11 |
| **SEC-14** | Identity, passkeys, MFA and recovery (unified human identity) | staff second factor, passkeys, portal passkeys, recovery, TOTP hardening carried from SEC-3 | identity provider | yes | SEC-2, SEC-4 |
| **SEC-15** | Mobile / offline / device security | baseline §11: scoped offline capability, attestation, revoke→sessions, manifest recompute, conflict detection, native shell build | native shell | yes | SEC-2, SEC-6 |
| **SEC-16** | Infrastructure, deployment, backup and recovery | T14, runbooks, DB role model applied, encrypted verified backups, health endpoint | platform | no | SEC-8 |
| **SEC-17** | Adversarial security testing | external penetration test before first production tenant; re-test after SEC-2, SEC-5, SEC-7, SEC-8, SEC-15 | procurement | no | as listed |
| **SEC-18** | Production security acceptance gate | written acceptance: every tranche's negative-test family green, rotation register complete, restore rehearsed, pentest findings closed or accepted | owner | no | all |

Parallelisable after SEC-1: SEC-3, SEC-10, SEC-12 touch disjoint files and may proceed alongside SEC-2.

## Standing rules for every tranche

- **Small, security-focused changes.** No drive-by refactors; a tranche that finds an unrelated defect records it
  in `docs/security/` and moves on.
- **Tests before code**, each with a named RED expectation and a focused command; negative cases are mandatory
  (wrong tenant, no tenant, wrong user, wrong role, right role wrong permission, right permission wrong record,
  expired/revoked grant, stale/revoked session, disabled account, revoked device, forged device id, manipulated
  body `orgRef`, direct id access, cross-tenant id, replayed token, invalid/expired MFA, malicious upload, prompt
  injection, unauthorized AI tool/record/context, offline claim above capture-time authority, print/export without
  authority).
- **No weakening of existing tests, no skipped suites**; a `.db.test.ts` that needs a fixture gets one.
- **Distinguish pre-existing failures from introduced ones** in the PR body, with the baseline run cited.
- **Typed security decisions and structured errors**; no secret value in any error or log.
- **No security decision in the UI only.**
- **Migrations:** additive, nullable or defaulted, numbered at merge against the collision register, with a down
  file; never speculative.
- **Dependencies:** none added without the dependency-rule table (problem, existing equivalent, maintenance,
  licence, security history, transitive impact, compatibility) in the PR.
- **Every tranche ends** by regenerating `LEASEOS_CURRENT_STATE.md`, updating `docs/security/LEASEOS_SECURITY_BASELINE.md`
  §17 rows it closed (with the commit), and asking for review before the next begins.

## First tranche

`docs/superpowers/plans/2026-09-23-leaseos-security-sec-1-tenant-resource-authorization.md`.

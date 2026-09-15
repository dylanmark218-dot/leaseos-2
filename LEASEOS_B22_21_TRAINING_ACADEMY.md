# LeaseOS v22.21 — Training Academy

Release state: **UNRELEASED checkpoint**. This build is intentionally not called gate-verified until the repository's normal pnpm dependency tree and disposable MySQL test database are available and the complete CI gate runs.

## What v22.21 adds

The Training Academy is a versioned learning and qualification subsystem, not a PDF library and not a credential printer. A learner works against one published course version. Every required module completion stores the current module hash. A final assessment cannot open until every required completion belongs to that same current version. Assessment attempts freeze the policy, randomized question set, presented answer order, course version, scores by domain and critical failures so a later course edit cannot rewrite what the learner was tested on.

Courses that require hands-on competency do not treat an online test as practical proof. Theory completion moves the assignment to `practical_pending`; a separate authorized evaluator records the practical result against the same course version. The worker cannot sign their own practical evaluation.

Certificate issuance is a separate privileged act. It checks the assignment version, passed assessment, practical evidence where required, credential boundary and the governing source snapshot. The source must have been explicitly reviewed before an employer/company certificate can be issued. `external_track_only` and `knowledge_only` courses never create external credentials.

## Credential boundaries

- **WHMIS** — employer-delivered Academy program boundary. LeaseOS can issue the employer's Academy certificate only after the governing source snapshot has been reviewed and required workplace/practical evidence is complete.
- **TDG road** — employer-delivered road program boundary. The Academy course is explicitly scoped to road work; it is not an air TDG certificate.
- **ERG 2024** — knowledge-only. It records learning/assessment, not a credential.
- **Company/site/load-securement courses** — company-certificate boundary. Generic templates remain non-issuable until the employer reviews its governing policy source.
- **Alberta Class 1 / Class 2 / Class 3, Air Brake Q, H2S Alive and First Aid** — external-track-only. LeaseOS may teach preparation material, record internal competency and display verified external records, but Academy completion cannot manufacture the external licence, endorsement or third-party certificate.

## Seeded knowledge

The code contains actual versioned lesson blocks plus assessment banks:

- 50 WHMIS questions
- 75 TDG road questions
- 25 ERG scenarios/questions
- 158 total seeded questions across 11 courses
- 48 seeded content blocks

The source records intentionally seed as **unreviewed**. This allows study and product development without silently converting a template/source reference into a company-approved regulatory determination.

## TDG direct supervision

A supervision record is bound to the trainee, named qualified supervisor, job, qualification scope and start/end window. The supervisor must personally attest physical presence. The engine explicitly refuses to treat GPS, phone, video or app monitoring alone as direct supervision. A valid record can satisfy its matching job/time requirement only; it is not a fleet-wide substitute qualification.

## Dispatch integration

Academy requirements identify the qualification code, enforcement mode and a specific recovery path. Dispatch evaluation returns `ready`, `needs_review` or `blocked` and names the missing training/qualification plus how to recover. Active direct supervision can satisfy only its matching job/time/scope.

## Learner interface

`/training-academy` now contains:

1. **My Training** — assigned courses, current version, progress and status.
2. **Lesson flow** — actual lesson/scenario/procedure content with current-module completion.
3. **Assessment gate** — locked until every required current-version module is complete.
4. **Assessment runner** — randomized questions/answer order with domain and critical-failure results.
5. **Practical pending state** — theory does not masquerade as equipment competence.
6. **Course Catalog** — credential boundary, jurisdiction, module count, bank size and external-credential warning.
7. **Tickets & Qualifications** — Academy certificates and qualification records.

## Database

Migration `0086_training_academy.sql` adds exactly 18 tables:

1. `academyCourses`
2. `academyCourseVersions`
3. `academyModules`
4. `academyContentBlocks`
5. `academyAssignments`
6. `academyModuleCompletions`
7. `academyQuestions`
8. `academyAssessments`
9. `academyAssessmentAttempts`
10. `academyAssessmentItems`
11. `academyPracticalEvaluations`
12. `academyQualifications`
13. `academyCertificates`
14. `academySourceRecords`
15. `academyDirectSupervisionRecords`
16. `academyRequirements`
17. `academyRequirementBindings`
18. `academyAuditEvents`

The source now has **303 schema tables / 303 migration-created tables**.

## Authorization

Self-scoped learner permissions are universal only to authenticated users who already hold a recognized LeaseOS domain role. The procedures themselves resolve the learner from `ctx.user.id`; they do not accept another learner ID.

Administrative acts remain separate:

- practical evaluator: HR, management, safety, shop lead
- source reviewer: management, safety
- certificate issuer: HR, management, safety
- catalog manager: management, safety
- assignment manager: HR, management, safety
- direct-supervision planner: dispatcher, management, safety
- physical-presence attestation: self-scoped to the named supervisor in the record

Source review, certificate issuance, requirement management and physical-presence attestation are sensitive permissions in the fail-closed authorization audit.

## Immutable evidence

`academyAuditEvents` is append-only at the application layer. Each event stores the prior event hash and its own hash, making the Academy event stream tamper-evident. Assessment attempts and items preserve the exact presented form separately from the mutable course catalog.

## Validation at this checkpoint

- schema/migration table parity: **303 / 303 — PASS**
- bare `protectedProcedure`: **0**
- role-authorized procedures now present: **446**
- permissions: **312**
- sensitive permissions: **107**
- universal self-scoped permissions: **12**
- test files/cases in source: **111 / 1,873**
- pure Academy TypeScript engine compile: **PASS**
- parser check of every modified TS/TSX/schema file: **PASS**
- executable Academy policy harness: **PASS**
- executable Academy authorization harness: **PASS**

The executable policy harness confirms the requested 50/75/25 bank counts, current-version module gate, deterministic randomized assessment snapshot, perfect-answer grading, separate practical gate, external-credential refusal, unreviewed-source refusal, physical-presence supervision requirement and dispatch blocker recovery path.

## What is not claimed yet

The complete Vitest/Vite/production build and MySQL migration/integration suite have **not** been rerun in this sandbox. The source snapshot did not contain the project's pnpm dependency tree, Corepack cannot download pnpm because outbound registry access is blocked, and no disposable MySQL database is available here. This checkpoint therefore remains **UNRELEASED**, not GATE-VERIFIED.

# Showcase surfaces — demo data, no production writes

These pages carry hard-coded demonstration identifiers (JOB-08421,
TR-2026-000812, unit 247, example coordinates) and demo "verified" records.
They are mounted only under `/showcase/*`, behind `ShowcaseFrame`, which sets
the showcase flag the tRPC client's `showcaseGuardLink` reads: any MUTATION
issued from a showcase surface is refused client-side with a visible error
and never reaches the server. Queries still run, so the pages show real data
where they read it.

The v22.5.1 source guard (`server/clientTruth.test.ts`) fails the gate if any
of these identifiers appears in production client code outside this tree.

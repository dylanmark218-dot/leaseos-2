# LeaseOS Reconciled GitHub Repository — 2026-09-14

This repository was reconstructed from the three September 14 LeaseOS bundles (`Chat1`, `Chat2`, `Chat3`). It preserves the actual code progression as Git snapshots, removes exact duplicated artifacts from the canonical set, retains changed historical variants, and creates branch references for the documented upgrades.

## Reconciliation totals

- Top-level archive entries reviewed: **181**
- Unique top-level payloads: **99**
- Exact duplicate copies collapsed: **82**
- Normalized filename conflicts with differing content: **0**
- Latest CAL05a source files: **730**
- Latest test/spec files: **161**
- Latest SQL files/migrations: **102**
- Upgrade branches created: **77**
- Ignored generated/backup artifacts removed from GitHub-facing `main`: **2** (still preserved in exact CAL05a history)

## What is authoritative

The Git snapshot commits are authoritative for source history. Binary source ZIPs and cumulative diffs are kept under `archive/` only as provenance. `audit/duplicate_manifest.csv` records every original archive entry and whether it was kept or collapsed as an exact duplicate.

## Important limitation

The supplied material gives exact complete source snapshots for v20, v22.16, and CAL05a, but not a full exact source tree for every intermediate B-step. Therefore the `upgrade/*` refs are historical/review pointers to the earliest exact cumulative snapshot containing that upgrade. They are **not** fabricated per-feature patches.

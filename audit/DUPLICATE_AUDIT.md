# LeaseOS Duplicate Audit

- Input bundles: **3**
- Top-level entries inspected: **181**
- Unique SHA-256 payloads: **99**
- Exact duplicate copies removed from the canonical artifact set: **82**
- Exact-duplicate groups: **56**
- Normalized-name conflict groups (same apparent filename but different bytes): **0**

## Largest duplicate groups

- **9 copies** — `LEASEOS_B22_18_COMMS_DISPATCH.md` — SHA-256 `ff9a68e94b16478c…`
- **9 copies** — `LEASEOS_B22_17_COMMUNICATIONS.md` — SHA-256 `f0b3cbcb8dda6d95…`
- **8 copies** — `LEASEOS_B22_19_OFFLINE_PACKAGE.md` — SHA-256 `9e0407ccf458d956…`
- **7 copies** — `LEASEOS_UNRELEASED_0079_CDEF.md` — SHA-256 `28f7303e09744ee4…`
- **3 copies** — `LEASEOS_B22_12_SETUP_WIZARD.md` — SHA-256 `796d7de59d0f67c8…`
- **2 copies** — `LEASEOS_ASSISTANT_WIRING.md` — SHA-256 `b9e14d058b95cbcd…`
- **2 copies** — `LEASEOS_ASSISTANT_ENGINE.md` — SHA-256 `16c320de046162cd…`
- **2 copies** — `LEASEOS_BRANCH_RECONCILIATION.md` — SHA-256 `8ece29acc8b0eab6…`
- **2 copies** — `LEASEOS_B19_END_TO_END.md` — SHA-256 `ff78b46bb1f4f8bd…`
- **2 copies** — `LEASEOS_B16_CI_DATABASE.md` — SHA-256 `3149372956f14f62…`
- **2 copies** — `LEASEOS_B18_BILLING_ADJUSTMENTS.md` — SHA-256 `894d2d6f33a38753…`
- **2 copies** — `LEASEOS_B17_1_PRODUCTION_WIRING.md` — SHA-256 `b8c057c46268f209…`
- **2 copies** — `LEASEOS_B17_WORKFLOW_CORE.md` — SHA-256 `56891b3395f08520…`
- **2 copies** — `LEASEOS_B13_DATA_GOVERNANCE.md` — SHA-256 `aff1a2fae656f5bd…`
- **2 copies** — `LEASEOS_DESIGN_SYSTEM.md` — SHA-256 `8cb911299f820d77…`
- **2 copies** — `LEASEOS_B12_ROUTING_EVIDENCE.md` — SHA-256 `97c9a3928e8d91af…`
- **2 copies** — `LEASEOS_B14_DISPATCH.md` — SHA-256 `3083f073bbf61cb2…`
- **2 copies** — `LEASEOS_B15_TRANSACTIONAL_DISPATCH.md` — SHA-256 `8f66ea89bebb3a36…`
- **2 copies** — `LEASEOS_TAXONOMY_ROUTING.md` — SHA-256 `3aca031bc9bddd5a…`
- **2 copies** — `LEASEOS_BUILD_SPEC.md` — SHA-256 `e36c1aa29bf650a5…`

The full row-by-row decision is in `duplicate_manifest.csv`. Exact-byte duplicates are removed only from the canonical artifact set; their original names and source bundles remain recorded in the manifest. Cross-version files that changed are **not** treated as duplicates.
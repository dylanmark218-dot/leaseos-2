# LeaseOS Project recovery provenance — 2026-09-14

This file records source artifacts recovered from earlier LeaseOS Project uploads after later conversations had treated some inputs as unavailable. These are **reconstructed provenance refs**, not recovered original Git history. Each archive branch is an independent commit whose tree is the recovered worktree, preserved so future reconciliation does not depend on chat availability.

## Recovery source refs

| Recovered source | Reconstructed branch | Commit | Tag | Source SHA-256 |
|---|---|---|---|---|
| `leaseos-0088-GATE-VERIFIED-UNRELEASED.zip` | `archive/recovered-0088-gate` | `7b47d00f9d7046aae4d62d6acf026aaf7c370e9f` | `recovered-source-0088-gate` | `76507adecb6d7d53c2c6b71c8f7ae2a3e6d961a80aa6ae68889bad18992ab1ee` |
| `leaseos-0088-ACADEMY-HARDENING-RECONCILIATION-UNRELEASED.zip` | `archive/recovered-0088-academy` | `4883f3e63c93ea69a2fc3e6a8fa280e665ac3205` | `recovered-source-0088-academy` | `f36754de9bfccef3f64b162cc3583e65664617b8cf9edf84ffbcfbf2a21e84d1` |
| `leaseos-fieldroute-v21-reconciled.zip` | `archive/recovered-v21-reconciled` | `85121e99732a50e512471bb47c03a0c22e463ac8` | `recovered-source-v21-reconciled` | `a65857a97834898e9afe28d57074beb7f497f164dcdedae9d16c9402d270c307` |
| `leaseos-fieldroute-v17-spatial.zip` | `archive/recovered-v17-spatial` | `2e7bc13d6296892e487a6280e7537b603d4cc3e3` | `recovered-source-v17-spatial` | `1e93774fd2ca288da539467a8d44e80645e9b4208dd9ae15f639b5cae1d59af7` |
| `leaseos-fieldroute-v18-loadsense.zip` | `archive/recovered-v18-loadsense` | `d925e3381733b7f97360e9dd15216964aba54db9` | `recovered-source-v18-loadsense` | `646fa862557e09ac93361679bf3a5eb93b549987c02b1ef3b0e821b07ab35e7d` |
| `leaseos-b23-widget-engine.zip` | `archive/recovered-b23-widget-engine` | `a6d41caeea3e48e46bd5a7c5c67fae9ea305590b` | `recovered-source-b23-widget-engine` | `d455fdec025e5c6b3204f913e5e5f09b643d1b59b9a983d22c8a9b31a6f1489a` |

Additional historical evidence retained outside these snapshot refs:

- `leaseos-integrated-ops.diff` SHA-256 `ba91fcfc2bb50b4fe79013c6e5f4c95e82886b394e2514381d47bb7ca863379e`.
- The prior Chat1–Chat5 repository remains anchored at `main` / `archive/pre-project-recovery` commit `74d99de54387894f42daa54c802e4a536eab9313`.

## Recovery decisions

### Academy
The recovered 0088 Academy source is the authoritative source for the missing Academy implementation. It was **forward-ported**, not wholesale merged. Historical migration identities that collide with the modern chain were remapped to modern slots 0107 and 0108. The recovered snapshot itself remains unchanged on its archive ref.

### Spatial
The historical v17/v21 spatial source is preserved as evidence. Modern LeaseOS already contains later legal-land, road-graph, restriction, route-evidence and approval systems, so copying the old spatial tables/engines back would create competing sources of truth. The historical source-not-supplied gap is closed without reintroducing obsolete architecture.

### LoadSense
The v18/v21 pure calibration, stability, gateway replay/gap, material-movement and billing-boundary logic was recovered. The obsolete parallel device registry was not restored. The modern port uses the existing `measurementDevices`, `calibrationEvents` and measurement-authority model, with new LoadSense-specific persistence in migration 0109. Native/authenticated gateway ingestion is deliberately still unwired.

### B23/B28
The exact recovered B23 widget package is preserved as a source ref. It is not production-integrated by this recovery tranche. B28 migrations must now start at the then-current next-free slot (currently 0110) rather than historical 0089/0090 or the previously suggested 0107/0108.

## History boundary
These refs prove what source bytes were recovered from Project storage. They do **not** prove the original historical Git commit graph, authorship metadata, or original branch object IDs unless those objects already existed in the prior unified repository.

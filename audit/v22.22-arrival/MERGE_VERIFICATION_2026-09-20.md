# Merge verification — ChatGPT v22.22 lineage into `main`

Date: 2026-09-20 · Verifier: Claude Code session `session_01WT6zntTafcKuL74iGfEHwH`

The second arrival from the ChatGPT lineage, handled as a merge rather than an
import. This records what was checked, what the instructions predicted, and the
one place reality differed from the prediction.

## 1. Artifact integrity

Seven files arrived. `SHA256SUMS.txt` lists seven entries and **six of the listed
files were present; all six verify**. The seventh,
`leaseos-recovered-source-chat4-chat5-2026-09-16.zip`, was not re-sent; the copy
from the previous package hashes to the value this manifest names
(`316903d6…`), so it is unchanged rather than missing. No mismatch anywhere, so
nothing was stopped.

The bundle carries 424 refs, the same count as before, with
`integration/reconciled-2026-09-16` advanced from `515ce64` to `d6a3433`.

## 2. It really was a merge, not an import

| | ChatGPT side | This repository |
| --- | --- | --- |
| Head | `d6a3433` | `34f26ec` |
| Commits since `515ce64` | 2 | 11 |

`git merge-base` confirms `515ce64` is the common ancestor, exactly as stated.
The source zip was never unpacked over the tree. Had it been, it would have
reverted `.github/workflows/ci.yml` to the MySQL 8.0 version and `LEASEOS_RELEASE`
to v22.20 — the two fixes CI had just verified.

## 3. Zero conflicts, and why the predicted two did not appear

The merge was expected to conflict on `LEASEOS_RELEASE` and
`.github/workflows/ci.yml`, ours winning both. **Git reported no conflicts at
all**, and that is not luck: their two commits never touch either file.
Relative to the common ancestor only this side changed them, so the merge keeps
ours with nothing to resolve. Their *zip* contains the older versions, but a zip
is a snapshot and a merge is a diff.

The two change sets turn out not to share a single file.

All six of our changes were then checked individually in the merged tree:

| Change | State after merge |
| --- | --- |
| CI service is `mariadb:10.11` | intact |
| CI calls `scripts/ci-gate.sh` | intact |
| Gate 8 reads `LEASEOS_RELEASE` | intact |
| `fileParallelism: false` | intact |
| `oosPolicyApprove` locking read | intact |
| Clock-relative workforce fixture | intact |

## 4. The conflict git could not see

Their `d6a3433` regenerates `LEASEOS_CURRENT_STATE.md` with Release **v22.22**.
This side holds `LEASEOS_RELEASE` at **v22.21**. No git relationship connects the
two files, so the merge succeeded into a tree that disagrees with itself, and
gate 8 — which now reads the file instead of scraping the document — fails on it:

| `LEASEOS_RELEASE` | Gate 8 |
| --- | --- |
| v22.21, the literal instruction | **fails** — document says v22.22 |
| v22.22 | passes, document regenerates byte for byte |

The instruction to keep ours was written against a v22.20-versus-v22.21 conflict,
which is not the conflict that exists. The merged tree genuinely is v22.22: it
carries migrations 0123 and 0124, the Academy modules wired and the HOS
separation-of-duties gap closed. `LEASEOS_RELEASE` therefore reads v22.22. The
intent of "ours wins" holds — the file stays the source of truth and never
regresses to v22.20 — while the value follows the tree.

Until the gate-8 fix landed earlier the same day, this mismatch would have passed
silently, because gate 8 fed the document its own release value.

## 5. Gate

Full `scripts/ci-gate.sh` from an empty database, MariaDB 10.11.14, Node 22,
pnpm 10.4.1:

```
== PASS ==            exit 0
migrations reach      0124
193 test files        3050 passed | 3 skipped
356 tables            120 migrations
532 role-authorized   36 external   2 integration
LEASEOS_CURRENT_STATE.md  regenerated identical
```

Every figure matches the `gate-final.log` shipped with this package.

## 6. What was not done, and why

The instructions asked for three documents to be committed at the repository
root. Two of them — `REMAINING_BUILD_REGISTER.md` and
`B28_RECONCILIATION_MATRIX.md` — **already arrived in the merge**, at
`docs/REMAINING_BUILD_REGISTER.md` and `docs/b28/B28_RECONCILIATION_MATRIX.md`,
byte-identical to the uploaded copies. Committing them again at the root would
create a second copy of each, which is the one-source-of-truth rule this project
states as a ground rule in that very register. Only the third,
`LEASEOS_RECONCILIATION_AUDIT.md`, was genuinely absent, and it is filed here.

The new gate log is filed here rather than overwriting
`audit/reconciled-2026-09-16/gate-final.log`, which is the v22.21 evidence and is
referenced by its hash in that directory's manifest. This directory follows the
repository's existing `audit/<name>-arrival/` convention.

## 7. Confidentiality

`restricted/chat5-assessor-key` is still in the bundle, at the same commit
`cc33ee3`. It was not fetched: the fetch named one refspec,
`integration/reconciled-2026-09-16`. Its objects can still arrive in the pack as
unreachable data, so the object store was checked and pruned afterwards, and the
push named one refspec explicitly — never `--all`, never `--mirror`, never tags.

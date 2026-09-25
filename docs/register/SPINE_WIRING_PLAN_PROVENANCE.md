# SPINE_WIRING_PLAN.md — where it came from, and why it was missing

`docs/register/SPINE_WIRING_PLAN.md` is the governing document of the SPINE moratorium. It was
cited in this repository before it existed in it. This record says where the copy here came from,
so that the file can be checked rather than believed, and so that a future edit lands where the
plan is actually kept.

## Recovery

| | |
|---|---|
| Canonical source | `dylanmark218-dot/leaseos` (the sibling repository), path `docs/register/SPINE_WIRING_PLAN.md` |
| Authored in | commit `df51d65a2d5a16b1e6914f8b209dfb900258f09c`, 2026-09-21 07:23:37 +0000, "Spine wiring plan, decisions recorded, three defaults proposed" — the file's only revision there |
| Blob | `fb3494741917c3fac631d13368f1e395d63b3f09` (git object id, identical in the sibling and here) |
| Read from | `leaseos` `origin/main` at `9bb26516566eaa7c2d410b1887d96707d3dfa75c`; the same blob is on `leaseos` `claude/spine-boundary-confirmation` |
| Restored here by | commit `fc35f6fc07a1ebaa155aaeaebd89cedc20834db3` on `claude/spine-wiring-plan-recovery` |
| sha256 | `d0dd3ed4ec505835a11d0205933cc93d1e9509c2213c965c8d59e08ac616d60a` |
| Content changed | no — byte for byte |

The plan's own first line reads "Against `9e1a75f82`". That commit is in the sibling's history
("#4: a trip stop names who recorded it", the `0169_trip_stop_provenance` migration), not this
one. It is a citation inside the recovered text and is left as written.

## Why it was missing

This repository began as a source snapshot: `a65d4a37` (2026-09-21 05:37) and the import commit
`6ae3856` (05:55) carried the working tree of `leaseos` without its history. The plan was written in
`leaseos` at 07:23 the same morning, after the snapshot. Every later document here that cites it —
`docs/register/PORTAL_ORG_SCOPE_DEFERRED.md` on `main`; `docs/register/SECRETARY_SPINE_MORATORIUM.md`
and `server/engineReachability.test.ts` on PR #7; `docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md`,
`server/_core/boundaryConfirmation.ts` and `server/boundaryConfirmation.test.ts` on PR #10 — was
written against the sibling's copy. Nothing deleted it here; it was never added.

No branch, tag, reflog entry, or dangling object in this repository contained the file or the
sentence "no new engines until this path is wired" before this restoration; every blob was
scanned. The moratorium was therefore enforced by quotation alone.

## Both repositories

Both carry the same plan and must stay byte-identical. The canonical copy is the sibling's: a
change to the plan is made there first, then restored here by copying the blob and updating the
sha256 above. `server/spineWiringPlan.test.ts` fails when the file here does not match this
record's hash, so the plan cannot be rewritten in place under the same name.

## What the guard proves

`server/spineWiringPlan.test.ts`:

1. the plan exists at the path the code cites, and matches the hash above;
2. the moratorium sentence, the ordering section and its four items, and the closing rule
   ("Nothing above needs a new engine…") are in it;
3. every engine the plan places on the spine is a real `server/_core` module that the
   reachability census names;
4. every citation of `SPINE_WIRING_PLAN.md` in the tree uses the canonical path.

It parses headings and table rows, never line numbers.

# Production-readiness audit — what checks out, and what does not

Against `d61baaf9c`. The audit is careful work and its Phase A ordering is right. Three things need
correcting, one of them a correction to the owner rather than the auditor.

## The release-number correction goes the other way

The report was that the snapshot table says v23.25 while the ZIP reads v23.24, with "v23.25 in no
markdown file". Checked against the commits:

| commit | `LEASEOS_RELEASE` | census pin | `docs/b23/CONFIRMED_PROVENANCE.md` | old MAD comment |
|---|---|---|---|---|
| `cd071c957` … `8ef1f44d4` | v23.24 | 50 | absent | absent |
| `b28a6a5ca` … `4c31a2935` | v23.25 | 54 | absent | present |
| `bdb71e8ec` | v23.25 | 54 | present | present |
| `4b0404491` … `02e378dbf` | v23.25 | **55** | present | present |
| `d61baaf9c` | v23.25 | 55 | present | absent |

The audit cites the census pinned at **55**, quotes `docs/b23/CONFIRMED_PROVENANCE.md`, and quotes
the old MAD comment. Those three co-occur only at `4b0404491`, `cba801f95` or `02e378dbf` — and at
all three `LEASEOS_RELEASE` reads **v23.25**. At the only commits where it reads v23.24, `docs/b23/`
does not exist at all, so the audit could not have quoted it.

At `02e378dbf` the string `v23.25` appears in two markdown files: `LEASEOS_CURRENT_STATE.md` and
`docs/b23/LEASEOS_B23_0_TRIP_OPERATIONS_CLOSEOUT.md`, whose title is literally
*"LeaseOS v23.25 — Trip operations closeout"*.

So the audit's headline row is right for the tree it read, and the v23.24 inspection was of a
different, older archive. The two artifacts are not the same tree, which is worth knowing before any
other figure from either is trusted against the other.

## CI-02 checks out exactly

164 `.sql` files, 163 distinct numeric prefixes, range `0000`–`0167`, gaps at 16, 17, 94, 95 and 98,
one duplicated prefix at `0157` (`0157_seal_verification_unavailable.sql` and
`0157_signature_device_attestation.sql`). File count undershoots by one and max-prefix overshoots by
five; the tail is the only safe read, which is why "next is 0168" held and "0164 by count" did not.

## RB-01 is real, and narrower than the required-closure list says

Verified: `registerStorageProxy` is mounted at `server/_core/index.ts:39` and serves
`app.get("/manus-storage/*")` with no session, role, tenant, ownership or evidence lookup, no rate
limit and no log. `key` comes straight from `req.params[0]` into `forgeUrl.searchParams.set("path", key)`,
so nothing in this code confines it to paths the application minted — whether the storage backend
scopes it is not visible from here.

**But the audit's first closure item is already satisfied.** Every live writer persists the *key*,
not the URL:

- `closeoutRouter.ts:358` → `fieldTicketDocuments.storageKey: stored.key`
- `auditRouter.ts:217` → `auditPackages.coverStorageKey: stored.key`
- `invoicingRouter.ts:70` → same pattern

and every live reader mints a short-lived signed URL inside a role-gated procedure via
`storageGetSignedUrl(key)` (`auditRouter.ts:265`, `telematicsRouter.ts:82`). The `/manus-storage/`
URL `storagePut` returns is discarded by all three callers. No production column holds one — the only
such strings in the tree are three fixtures in `fieldroute.test.ts`.

So the read-time authorization pattern the audit asks for **exists and is in use**. The exposure is
not leaked persisted URLs; it is that an unauthenticated read route stands over the same bucket that
holds invoices, field tickets, audit covers and telematics video, reachable by naming a key. Keys are
structurally guessable (`audit/{packageRef}/cover_{8 hex}.pdf`) with roughly 32 bits of suffix.

That makes the fix smaller than the six-item list: **delete the route, or gate it behind the same
resolution `storageGetSignedUrl` callers already perform.** Nothing has to be migrated.

Two additions:

- **The audit-trail asymmetry is the worst part, and the audit does not name it.**
  `restrictedVaultRouter` writes `restrictedAccessEvents` before serving, and the schema's own
  comment says access fails if that write fails. The proxy serves bytes and logs nothing. For any
  restricted object whose key escapes, the access log reads clean while being wrong — missing
  authorization plus a record that affirmatively says nobody looked.
- **`storageGet` is dead code.** Nothing calls it. The suspected key mismatch is real but latent:
  `storagePut` returns a key that already carries the hash suffix, and `storageGet` applies only
  `normalizeKey`, so it is correct for a caller passing the stored key and would 404 for one passing
  the original. Whoever wires it would get broken URLs, not an exposure. Delete it with the route.

## DOC-01 as a category, not a defect

Four instances of one shape, all green:

| Check | What it could not see |
|---|---|
| ~~`knowledgeWritePaths.test.ts`~~ | **withdrawn — this one was not blind.** It asserts the corpus writer list *equals* `repository.ts`, so the writes have to exist, and it scans four trees for a second writer. The path is correct and unreached, which `engineReachability` already declares. Listing it here was the same error it describes: a claim about a check made without reading its assertions |
| `reachableSet` | a doc comment, a dynamic import, and an entire directory |
| `calendarFixtures` | named the wrong cause, sending a reader after an edit that never happened |
| `scripts/current-state.sh` | regenerated its own stale sentence, so the diff step could not catch it — **verified and fixed** |

The common property of the three that stand: **a check that cannot fail for the reason it claims to
be checking, and reports health instead.** Ordinary review does not catch them because green reads as evidence. The only
reliable detection is planting the failure and confirming the check goes red — which found the
census's dynamic-import blindness and the cluster pin, and would have found the other two.

Worth adding to the audit as a category with a standing rule: a guard is not trusted until someone
has watched it fail.

**DOC-01 verified, three ways, and fixed.** `LEASEOS_CURRENT_STATE.md:71` said the production
lifecycle starts a shared outbox claimer; line 961 said *"Nothing in the production server lifecycle
starts the worker"* and closed with *"What remains is the production entry point that calls it."*
They are about the same worker: `server/_core/index.ts:35` awaits `startProductionWorker()`, which
calls `startDrainWorker` — the drain worker that paragraph names. And the sentence lived at
`scripts/current-state.sh:1011`, so gate 8 reproduced it on every run. The generator now states what
the code does, with a note in the document saying what it used to say and why the check could not
catch it.

The category therefore stands at **three** members, not four — `knowledgeWritePaths` was withdrawn
above — and each is now either fixed or recorded in the file it affects.

## Build order

Per-boundary confirmation is **done** — `cba801f95` and `02e378dbf`. That slot is closed, not
pending, and Phase B item 8 should read as satisfied for `siteBaseline` and outstanding for
`BillableStop`.

Provenance before billing is right, and for a reason worth stating: unify pricing while `tripStops`
still records no provenance and `BillableStop.confirmed` gets restated into whatever
`priceLineAndRecord` consumes as a value nobody can derive — a placeholder migrated once and touched
again later, which is exactly what deferring it was meant to avoid.

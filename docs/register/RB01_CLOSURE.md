# RB-01 closed — and the correction that made it larger than reported

The earlier finding said *"no production column holds a `/manus-storage/` path — nothing to
migrate."* That was wrong, and wrong by a method worth recording: it was concluded from a grep for
the literal string. The literal exists in exactly one place, `storage.ts`, where the path is built.
Everywhere else it travelled as `stored.url`, which no literal search can see.

## The three corrections, checked at HEAD

| Claim | Verdict | Evidence |
|---|---|---|
| Evidence upload persists `storageUrl: stored.url` and returns it | **CONFIRMED** | `routers.ts:441` persisted it into `evidenceRecords`; `:449` returned `{ id, ...stored }`; the dedup branch at `:429` returned `existing.storageUrl` |
| `_core/imageGeneration.ts` returns the minted URL | **CONFIRMED** | line 100 destructured `{ url }` and returned it as `GenerateImageResponse.url` |
| Three `storageUrl` columns | **CONFIRMED** | `evidenceRecords` (schema:54), `complianceDocuments` (189), `maintenanceDefects` (333) |

Two more things the check turned up:

- **The client never rendered it.** Zero occurrences of `storageUrl` under `client/src`, so no page,
  portal or document embedded one.
- **`compliancePassport.ts:248`** already listed `storageUrl` in
  `PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED`, so the passport never projected it either.

How the original enumeration missed it: the `storagePut` grep returned six call sites; three were
read (`invoicingRouter`, `closeoutRouter`, `auditRouter`), all persisted `stored.key`, and the
pattern was generalised. `routers.ts:103` and `imageGeneration.ts:18` were in the same output.

## What was done

1. **The route is deleted**, not gated — `server/_core/storageProxy.ts` removed and unmounted from
   `_core/index.ts`. A gated proxy would be a second authorization path to the same bytes.
2. **`storagePut` can no longer return a URL.** Its type is `Promise<{ key: string }>`, so there is
   no `.url` to assign and `tsc` rejects any caller that tries. The dead `storageGet` is deleted.
3. **Evidence upload persists `storageUrl: null`** and returns the key only; the dedup branch no
   longer returns a URL. `imageGeneration` returns a key.
4. **Migration `0168`** nulls `storageUrl` where it begins with `/manus-storage/`, on all three
   tables. `storageKey` stays the source of truth, and a value that does not begin with that prefix
   is a caller-supplied link, not a minted capability, so it is left alone. Rows touched in the CI
   database: 2 in `evidenceRecords`, 0 in the others — both were `fieldroute.test.ts` fixtures.
5. **The three `storageUrl` inputs refuse the prefix** (`routers.ts` evidence.add and two document
   paths). The route is gone, so such a value is a dead capability stored as though live.
6. **`server/storageCapability.test.ts`**, five assertions, verified by planting a re-mint — which
   fails two of them.

## What this did not cover, from the audit's closure list

- **No authenticated evidence-read procedure was added.** Nothing served evidence bytes before: the
  proxy was the only read path and the client never used it, so deleting it removed a capability
  without removing a feature. Adding one is new functionality, and it needs a decision this codebase
  deliberately has not made — `_core/attachmentAuthorizers.ts` resolves `jobs`, `maintenanceDefects`
  and `units` and says in its own header that *"what is shippable is what has an evidenced access
  path"*, explicitly declining `invoices` because *"a financial record wants a real row-level rule,
  not an existence check wearing one."* `evidenceRecords` has no resolver there. Deciding what an
  evidence object's owning record is belongs with that file's rule, not beside it.
- **Cross-tenant and revoked-access tests** were not added for the same reason: there is no
  procedure to test. They belong with the read procedure when it lands.
- **Restricted-vault objects** are unaffected — `restrictedVaultRouter` has its own logged-before-fetch
  path and never used the proxy.

## Why the structural test checks the mint site

The literal scan is kept, but it is the weaker half. The real invariant is that `storagePut` cannot
construct the value, which makes it unconstructable rather than merely unobserved. Writing the test
also reproduced the session's recurring false positive twice: it first flagged the headers explaining
the deletion, then the refusal predicate that must name the path to reject it. Comments are stripped
and the predicate exempted; the error messages were reworded instead of exempted, because every
exemption weakens the scan.

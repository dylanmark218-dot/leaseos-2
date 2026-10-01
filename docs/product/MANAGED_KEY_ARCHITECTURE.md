# Managed production key architecture — S2-KMS-A bootstrap

**Checkpoint:** S2-KMS-A — managed production key architecture / bootstrap. Addresses blocker #1 of
S2-E Phase 2A (no managed production secret-key provider). Does not touch blocker #2 (fleet
convergence) or #3 (production `LEASEOS_KEY_WEBHOOK_V1` provisioning), and does not implement
S2-E Phase 2B: `webhookSubscribe` still writes legacy ciphertext.

**Decision:** MANAGED ARCHITECTURE READY FOR VENDOR ADAPTER. **HOSTING_TARGET = UNKNOWN.**

## 1. Hosting survey

Every signal checked, and what it showed:

| Signal | Finding |
|---|---|
| Dockerfile, compose, Procfile, fly.toml, render.yaml, railway, vercel.json, netlify.toml, app.yaml, nixpacks, serverless, cloudbuild, buildspec, azure-pipelines, Helm/kustomize, Terraform, ecosystem.config | none in the tree |
| `.github/workflows` | `ci.yml` only; no deploy step, no cloud login, no registry push |
| `package.json` scripts | `build`, `start`, `worker`, `dev`, `check`, `test`, `db:push`; nothing deploys |
| README, `LEASEOS_CURRENT_STATE.md`, the programming manifest, `docs/` | no hosting platform named; the manifest's only deployment item is "pilot deployment" as a future step |
| AWS | `@aws-sdk/client-s3` was an unused production dependency, removed in the 2026-09-21 hardening (DEP-1); credential-pattern scans only. No infrastructure, no KMS usage |
| Azure / GCP / Vault / Kubernetes / Docker | appear only in dependency-audit JSON, a research archive, and a knowledge-perimeter word list; `vault` in code means the field-runtime evidence vault, not HashiCorp |
| Manus | the application began as a Manus WebDev template: `vite-plugin-manus-runtime`, Manus sandbox preview hosts in `vite.config.ts` `allowedHosts`, the Forge LLM gateway (`BUILT_IN_FORGE_API_URL`), the retired `/manus-storage/` proxy, Manus OAuth (`OAUTH_SERVER_URL`), and PR #19's note that the Bearer fallback "is the hosting platform's iframe preview sign-in path". This is a development/preview platform; nothing states it is the production host, and it offers no managed key service this repository can name |
| Issues / PRs | the only open issue (#46) is local test reliability; no PR or issue names a production platform |
| Commit history | no deployment, hosting or infrastructure commits |
| Local deployment configuration | none accessible from this session; no `.env*` files in the tree |

No vendor is proven. Vendor-specific implementation is therefore prohibited in this checkpoint, and
`productionManagedKeyBackends()` is empty on purpose.

## 2. The existing key contract and what it implies

`SecretKeyProvider` is synchronous: `getActiveKey(purpose)` and `getDecryptKey(purpose, keyId)`
return a `KeyDescriptor` holding raw 32-byte material as a `Buffer`. `encryptSecret` and
`decryptSecret` (S2-A) are synchronous and call them inline; `createSecret`, `resolveSecret`,
`rewrapSecret` (S2-B) and the MFA, webhook and provider-credential services build on those. Every
`v1.<purpose>.<keyId>.<iv>.<authTag>.<ciphertext>` envelope binds the key id in its AAD.

A managed backend cannot satisfy that model by being called inside `getActiveKey`: real managed
operations are network calls with authentication, latency and failure. Either the raw DEK is
obtained once and held, or the crypto boundary becomes asynchronous. This checkpoint does not paper
over that: it chooses the former explicitly.

## 3. Model A versus Model B

| | Model A — managed KEK, application DEKs | Model B — remote crypto operations |
|---|---|---|
| Envelope | unchanged `v1` | new version carrying backend-wrapped ciphertext; every canonical row rewritten |
| `encryptSecret` / `decryptSecret` | unchanged, synchronous | asynchronous; signatures change |
| `createSecret` / `resolveSecret` / rewrap | unchanged | async through the backend; every caller changes |
| MFA, webhooks, provider credentials | unchanged | each service and its tests rewritten |
| Retired keys | by `keyId`, as today | backend key versions, mapped into a new envelope field |
| Mid-request latency | none (unwrap at startup only) | one backend call per encrypt and decrypt, including the retry sweep and reclaim |
| Startup fail-closed | natural: no unwrap, no readiness | per-call failures surface in request handling |
| Migration risk | none | envelope migration of all existing canonical rows |

**Model A is selected**, on compatibility with the landed S2 design rather than elegance: existing
envelopes, `secretRef`s, purpose separation and retired decrypt-only keys are preserved, no secret
material enters environment variables, and startup fails closed before the port is bound.

## 4. What "managed" means, precisely

`kind: "managed"` means: the per-purpose DEKs are held **at rest** only as ciphertext wrapped by a
key the managed backend owns and never exports, and are **provisioned** into the process by a
managed unwrap operation at startup, authenticated by the workload's identity. After bootstrap the
plaintext DEKs exist **in this process's memory**, inside the bootstrap's closure, for the life of
the process; LeaseOS encrypts and decrypts with them locally exactly as it does today. This is not
HSM-only execution and it is not a claim that plaintext never exists in memory. It is custody at
rest and at provisioning time, which is what OWNER DECISION S2-1 asked for: no master key in a
shell profile or deployment variable.

## 5. The bootstrap

`server/_core/managedSecretKeys.ts` — `loadManagedSecretKeyProvider({ config, backend, require })`:

1. validate the configuration (shape, purposes, key ids, duplicates, raw-material guard);
2. require named purposes to be present;
3. `backend.probe()` — unavailable or unauthenticated → `backend_unavailable`;
4. for each purpose, unwrap active then retired keys — any failure → `unwrap_failed`; non-Buffer →
   `malformed_material`; not 32 bytes → `wrong_key_length`;
5. only then build an immutable provider (`Object.freeze`) whose `getActiveKey`/`getDecryptKey` are
   map lookups. `describe()`, `toJSON()` and `util.inspect` answer with the backend name and key ids
   only.

`server/_core/secretKeys.ts` — the one production source:

| Function | Role |
|---|---|
| `secretKeySource(env)` | `LEASEOS_SECRET_KEYS_SOURCE`: unset/`environment` → environment provider; `managed` → bootstrap; anything else refused |
| `managedKeyConfigFromEnv(env)` | parses `LEASEOS_MANAGED_KEYS` (JSON) and refuses raw key material anywhere in it |
| `productionManagedKeyBackends()` | the backends a build can name — **empty** until S2-KMS-B |
| `resolveSecretKeyProvider(env, backends, { require })` | builds the configured provider; no catch, no fallback |
| `bootstrapSecretKeys(env, backends, { require })` | resolves once per process and installs it |
| `secretKeyProvider()` | the synchronous accessor every call site uses; **throws** when the source is managed and nothing is installed |

Server: `startup.ts` awaits `bootstrapSecretKeys()` after `assertProductionSecrets` and before the
worker, the API and `readiness.markReady()`. Worker: `worker.ts` awaits it before
`startProductionWorker()`. A failure propagates to `reportStartupFailure` / the worker's fatal
handler; the process exits non-zero and never reports ready. Both log one line:
`[secrets] key provider: <source> (<backend>)`.

Operational tooling: `scripts/webhook-cutover-preflight.ts` now resolves its keys through the same
configuration and resolver. An operator never copies a DEK into a shell; under a managed source the
backend unwraps at script start, and a failed bootstrap exits 1 instead of reporting on environment
keys. The backfills (`migrateWebhookSecrets`, MFA) take a `keys` argument; the intended operational
command obtains it from `bootstrapSecretKeys()` in the same way (no such command is added here).

Call-site classification of the former `environmentSecretKeys()` uses:

| Site | Class | Now |
|---|---|---|
| `webhookDispatchService.ts` (dispatch, retry, reclaim) | runtime production | `secretKeyProvider()` |
| `_core/trpc.ts` (portal MFA verification) | runtime production | `secretKeyProvider()` |
| `portalRouter.ts` (MFA enrol / confirm) | runtime production | `secretKeyProvider()` |
| `webhookCutoverPreflight.ts` from-environment | operational readiness | `resolveSecretKeyProvider(env, backends)` with provenance `configuration` |
| `_core/secretKeys.ts` `mfaKeyReadiness` | environment-variable readiness report | unchanged by design |
| test files (4) | test | unchanged |

## 6. Configuration

`LEASEOS_SECRET_KEYS_SOURCE=managed` and `LEASEOS_MANAGED_KEYS` as JSON:

```json
{
  "backend": "<registered backend name>",
  "keys": {
    "WEBHOOK_SECRET": {
      "active":  { "keyId": "webhook-v2", "wrapped": "<backend ciphertext>", "backendKeyRef": "<KEK reference>" },
      "retired": [{ "keyId": "webhook-v1", "wrapped": "<backend ciphertext>", "backendKeyRef": "<KEK reference>" }]
    }
  }
}
```

References and wrapped ciphertext only. A 64-hex string anywhere in it is refused
(`raw_key_in_config`) before any backend is contacted. `LEASEOS_KEY_*_V1` and
`LEASEOS_PORTAL_MFA_KEY` remain for development, test and the legacy decrypt path; they are not
removed here.

## 7. Rotation semantics

Per purpose: exactly one active key, zero or more retired decrypt-only keys. A new write uses the
active key only; an old envelope decrypts under the key id it names; an unknown key id fails
closed; a duplicate key id, a purpose with retired keys but no active key, a malformed key id or
an unknown purpose fail the bootstrap before any unwrap; a purpose with no active key makes the
production write for that purpose unavailable. A retired key cannot become active except by
configuration naming it active.

## 8. Failure behaviour

| Condition | Result |
|---|---|
| backend unavailable / authentication denied | bootstrap throws `backend_unavailable`; process not ready |
| wrapped DEK missing or not the backend's format | `unwrap_failed` |
| malformed material / wrong byte length | `malformed_material` / `wrong_key_length` (active and retired alike) |
| duplicate key id | `duplicate_key_id` before any unwrap |
| required purpose absent | `missing_required_purpose` |
| managed source but no backend in the build | `backend_unknown` — the production truth today |
| any of the above | **no environment fallback**: `secretKeyProvider()` throws `not_bootstrapped` |

Optional purposes: a purpose absent from configuration is unconfigured (writes refused for it, as
with environment keys today); a purpose *present* that fails to load blocks startup entirely. The
Phase 2B precondition will pass `require: ["WEBHOOK_SECRET"]`.

## 9. Workload identity

Backend authentication is the adapter's responsibility and must use the hosting platform's workload
or instance identity; `ManagedKeyBackend` accepts no credential and this repository stores none.
Because HOSTING_TARGET is UNKNOWN, this is recorded as a deployment requirement for S2-KMS-B, not
designed here.

## 10. Leakage controls

The bootstrap module logs nothing. A backend reports failure only as a `ManagedKeyBackendError`
with one of a closed set of codes (`unavailable`, `denied`, `unknown_key`, `invalid_ciphertext`,
`internal`); the bootstrap repeats the code and nothing else — never the backend's message, never
its error class name — so no encoding of key bytes a sanitizer did not anticipate (`<Buffer aa …>`,
spaced hex, base64) can reach a log through an adapter. The provider serializes and inspects to
metadata; the raw-material guard refuses key-shaped configuration; the only startup log line is
the source and backend name. Pinned by `managedSecretKeys.test.ts` (KMS-T14 and the leak cases)
and `secretKeyWiring.test.ts`.

Two further controls from review: every backend operation (the probe, each unwrap) runs under a
deadline (`timeoutMs`, default 10 s) and a backend that never settles fails the bootstrap with
`backend_timeout` rather than holding startup — a process that neither binds nor exits would stall
a deployment indefinitely; and `LEASEOS_MANAGED_KEYS` is validated against a strict runtime schema
(`validateManagedKeyConfig`: exact fields at every level, typed values, unknown fields such as a
stray `credential` refused) before any backend is named, so `null` or an array is a coded
`config_shape` refusal rather than a `TypeError`.

## 11. Preflight integration

`managedKeyProvider` now reports `source: "configuration" | "supplied"` and `backend`. Only a
provider resolved from configuration can be ready; a provider handed to `webhookCutoverPreflight`
is a contract check and carries its own blocker. S2E2-T17 now runs through the configuration path
with a test backend; KMS-T15 pins the distinction.

## 12. Next

**S2-KMS-B — production vendor adapter.** It must begin by obtaining and proving the deployment
platform, then implement one `ManagedKeyBackend` for the managed key system available there,
register it in `productionManagedKeyBackends()`, and prove real custody, an active `WEBHOOK_SECRET`
key, decrypt by key id, retired keys, fail-closed on an unavailable backend, and a production
canonical write with no environment-held master key. Then S2-FLEET; only after both, S2-E Phase 2B.

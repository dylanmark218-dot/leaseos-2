# LeaseOS — v20.12.1 Checkpoint: Universal Permissions

| | Previous | New |
|---|---|---|
| Version | v20.12 | **v20.12.1** |
| Tables | 131 | 131 |
| Migrations | 23 | 23 |
| Procedures (role-authorized) | 142 | 142 |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 104 | 104 |
| Tests | 825 | **828** |
| Parity | 131/131 | **131/131** |
| Typecheck / Build | clean | **clean** |

*Recorded retrospectively — the change shipped with the authorization inventory
updated but without its own checkpoint document.*

## The decision

`tax.read_personal_own` was granted to driver, mechanic, shop_lead and HR, but
not to dispatcher, safety, office, management, legal, auditor or any finance
role. The permission is scoped to the session user by construction, so holding
it only ever returns the holder's own documents — which made the split
arbitrary. It tied a person's access to their own tax slips to what job they
happened to hold.

## The fix — a universal, not fifteen grants

Widening it to all fifteen roles would have expressed as a coincidence something
that is actually a rule. So it became the sole member of `UNIVERSAL_PERMISSIONS`:

> **Any authenticated user holding any recognized domain role may open their own
> Personal Tax Organizer. No operational or employer role grants access to
> anyone else's.**

Properties held by test:

- Every one of the fifteen roles can reach it.
- A user holding **no** recognized role still gets nothing — fail-closed is
  unchanged.
- **Denials still override universals.** The universal is granted after the
  denial sweep, not before.
- The list is exactly one entry long. A permission belongs there only when it is
  self-scoped **in code**, not merely self-scoped by intention.
- No procedure anywhere reads another person's organizer.

External scoped parties technically hold it and see an empty organizer, because
nothing in it is theirs.

## Files changed

`server/_core/recordsAuthorization.ts` · `recordsAuthorization.test.ts` ·
`payrollApiAuthorization.test.ts` · `PROCEDURE_AUTHORIZATION_INVENTORY.md`

No schema change. No migration. Parity unchanged.

# LEASEOS v22.19 — The offline communication package

Release: **v22.19** · 274 tables (+2) · 75 migrations (+1) · **419 procedures** (+4) · 296 permissions (+2) · **1,624 tests** (+20) · parity 274/274 · `ci-gate.sh` PASS

---

## What this is

Everything to here assumed a server the truck can reach. The road where the
communication plan matters most is the road where nothing can be fetched.

So the plan is sealed before departure and carried. A package is a snapshot, not
a view: built once, hashed, never edited — because a driver 60 km up a resource
road is acting on what they downloaded this morning, and a record that quietly
changed underneath them would make the evidence trail a lie.

---

## Completed

**The package says what it does not contain.** A driver offline cannot ask a
question, so the package answers the obvious ones before it leaves: which
channels are unverified *by key*, which kilometres have no channel at all, what
was deliberately left out. A package presenting confident-looking frequencies
without saying none has been checked against the regulator is worse than no
package.

```
3 of 4 channel(s) in this package are unverified against the regulator's
publication: LAD-4, RR-25, AB-163.050. Treat the posted sign as the answer.
18 km of this route has no channel on record. That is not "no radio needed" —
it is not known.
26 km with no cellular coverage data. Absence of data is not absence of
service, and it is not presence of service either.
```

Plus the standing notice on every package, complete ones included: *the channel
posted on the road governs over this package; do not rely on radio
communication alone for safe travel.*

**Only the channels the route names travel.** Shipping the whole 99-row bank to
drive one road invites selecting one that does not belong to it. And a **retired
service is dropped entirely** rather than carried with a warning — there is no
circumstance in which a driver offline should be choosing it, and a warning they
can scroll past is weaker than its absence.

**Each frequency carries its transmit answer and the reason, beside it.** Never
apart from it, because the two get separated exactly when somebody is in a
hurry.

**Stale by arithmetic, over four dependencies** — the assignments, the channel
records themselves, the coverage, the segments — each moving independently so a
dispatcher reading *"the channel records themselves changed"* knows a frequency
was corrected rather than that a sign was confirmed.

**Behind and stale are different facts.** Behind means a newer package exists;
stale means the world moved under the one they hold. A driver can be *current
and stale at once* — nobody has rebuilt — and that is the case dispatch most
needs to see. `packageStatus` answers it per device.

**A handover is not a carry.** The device states the hash of what it actually
stored; a mismatch is a partial download and is refused, because calling that
"carried" would be false.

---

## Files changed

| File | What |
|---|---|
| `server/_core/commPackage.ts` | **new** — sealing, manifest hashing, staleness, carried state |
| `server/commPackage.test.ts` | **new** — 20 tests |
| `drizzle/0076_offline_communication_package.sql` | **new** — packages and downloads |
| `server/commsRouter.ts` | +4 procedures; `planInputs` extracted so plan and package seal over one set of inputs |
| `server/_core/recordsAuthorization.ts` | +2 permissions, 5 role blocks, 4 map entries |
| `drizzle/schema.ts`, `scripts/current-state.sh` | tables and narrative |
| 2 test files | count pins 398 → 402 |

## Bugs found — five, and four were mine to make

**1. A stale package could not be fetched at all.** The by-label lookup filtered
on `current`, so the moment a package went stale a driver asking for it got
*"build one before departure"* — nothing. Leaving a driver with no package is
worse than an out-of-date one they have been told is out of date. Now handed
over with the warning.

**2. Rebuilding after a stale restarted the version at 1** and lost the
supersession chain, because the predecessor lookup had the same `current`-only
filter. It broke exactly when a rebuild mattered most: after the world moved.

**3. Sealing and checking used different bases.** The build hashed channel
records over *every assigned* key; the status check hashed over the *carried*
keys. Any segment with a second assignment made every package stale
instantly. Both now seal over what the package carries.

**4. A confirmed sign reported two changes instead of one.** `channelRecords`
was derived from the current assignments, so changing an assignment also changed
which records were hashed — telling a dispatcher a frequency had been corrected
when none had. The two dependencies answer different questions and now move
independently.

**5. Two procedures shared one name.** `packageAcknowledge` was wired as
`roleProcedure("comms.packageFetch")`, leaving its map entry orphaned and the
authorization inventory describing a procedure that was not there. Caught by the
orphan-mapping test.

### A recurring hazard, now recorded

**Twice in three checkpoints I passed a *permission* where `roleProcedure` wants
a *procedure name*.** Both times the wiring-time check caught it loudly at
import, which is the design working — but it is a hazard worth naming in this
file, alongside the `"geo.access.decide"` anchor collision from v22.16. The two
namespaces look alike (`comms.read` vs `comms.channelList`) and the call site
gives no hint which one it wants.

**Test isolation bit again — fourth time.** A channel verified by another file's
test decided this file's answer. Fixed by establishing the precondition
explicitly, as before.

## Verification

Typecheck clean · parity 274/274 · 1,624/1,624 · production build · bare
`protectedProcedure` 0 · portal 36 external, 0 role · inbound 2 integration ·
current-state regenerated and matching. Full `ci-gate.sh` from an empty
database: **PASS**.

---

## Remaining gaps — named, not implied

**Nothing rebuilds automatically, and nothing reaches a driver who has already
left.** LeaseOS detects staleness and names it per device; acting on that is
still a person opening a screen. The research called this *"tomorrow's trip
affected"* — the query now exists, the notification does not.

**The package is served, not stored.** `packageFetch` returns the sealed content
and records the download; persisting it into the field runtime's encrypted
vault, and reading it with no network, is the client half and is not built. The
acknowledgement is the seam where that lands.

**Still no importer** for ISED, BC or CRTC. Unchanged and still the largest gap.

**A prompt is still not proof.** No call-reminder feature exists, so nothing
claims a radio call was made. When one is built:
`promptDelivered` / `driverConfirmed` / `transmissionVerified`, three fields,
and only a certified radio interface sets the third.

**The driver screen still does not exist.**

## Next recommended step

**Persist the package into the field runtime's vault and read it with no
network.** The server half is done and hashed; the client half is what makes any
of this true on a road rather than in an office, and the acknowledgement
handshake was built as its seam. Everything else on the list — importers,
notifications, the driver screen — is worth more once a package can actually
survive losing signal.

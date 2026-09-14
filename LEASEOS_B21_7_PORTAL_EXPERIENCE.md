# LeaseOS — v21.7 Checkpoint: Portal Experience

| | Previous | New |
|---|---|---|
| Version | v21.6 | **v21.7** |
| Tables / migrations | 182 / 42 | **182 / 42** — no schema change |
| Procedures | 224 | **224** — no new API |
| Tests | 1,297 | **1,308** |
| Test files | 60 | **61** |
| Client build | passes | **passes, with the shell** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## One shell, role-composed

`client/src/portal/` is the shell the v21.0 checkpoint said the server was
ready for. It reads `portals.mine` for which portals this session holds and
the five surfaces — My Day, Exceptions, Inbox, Search, Timeline — every one
of which the server already filters to what the caller may see or act on.
**The shell decides nothing about permission.** It renders what it is given,
and every decision about what a person sees first lives in `viewModels.ts`
as a pure function, tested without a browser.

The specification's first screen, verbatim from the view-model test:

> GOOD MORNING, DYLAN · Current assignment JOB-24198 — Unit 142 · 5 things
> need attention: disposal ticket needs verification, odometer missing on
> Trip 9, fuel receipt needs review, and 2 more · Next: Drive to Disposal
> Facility — Navigate · Waiting for 1 — confirm your fuel receipt ·
> QUICK CAPTURE Receipt Ticket Photo Defect Incident Voice

The same backend, read by the office, is a table of counts with zeros kept
as information: Critical, Needs review, Waiting on field, Billing, Dispatch,
Fleet, Workforce. The most operational portal a person holds opens first;
the switcher lists only the portals they hold; a session with none is told
why rather than shown a gap.

**Quick capture is for people who capture.** Six buttons for the field; photo,
defect and voice for the yard; bill and receipt for the office; nothing for
the executive or the auditor. Each maps to the server form where one exists
and to pure evidence where none does.

**The indicators say what a worker reads.** *Offline · 3 queued · oldest 8h.*
*2 pending · oldest 7m.* *1 needs attention · 2 pending.* *All synchronized.*
The attention badge shows the critical count when there is one, else the
total, and hides at zero. The context ribbon carries the portal, the
assignment, and *Working offline* or *Device revoked — recapture on an
enrolled device*.

---

## The field runtime, mounted

`runtimeBootstrap.ts` mounts a runtime on `window.leaseosRuntime`. On a
device the native shell mounts its own, on the encrypted store and keystore,
before the app loads, and this does nothing. In a plain browser it mounts the
in-memory adapters — the outbox, the queue and the sync protocol, **without
at-rest protection, and it says so**. Quick Capture saves locally first and
queues only what relates to a job or unit, exactly as the outbox rule
requires; the sync indicator reads the outbox; reconnecting triggers a sync.

---

## What is proven here, and what is not

Proven: the view-models (eleven tests), the shell typechecking against the
real router types, and the client building with the shell inside it. Not
proven: a person using it. The document's list stands — Playwright, mobile,
offline→online, mid-upload loss, process kill, two-device conflict, glove
mode, small phone — and none of it runs in this container. The shell is
built so that when those tests exist they test the shell, not the decisions,
which are already tested.

---

## Files

**New:** `client/src/portal/viewModels.ts` · `PortalShell.tsx` ·
`panels/MyDayPanel.tsx`, `ExceptionsPanel.tsx`, `InboxPanel.tsx`,
`TimelinePanel.tsx` · `UniversalSearch.tsx` · `SyncIndicator.tsx` ·
`QuickCapture.tsx` · `runtimeBootstrap.ts` · `server/portalViewModels.test.ts`
(11)

**Changed:** `client/src/App.tsx` (`/portal`, `/portal/:portal/*`). The
existing workspace pages are untouched.

---

## Where the release sequence stands

v21.6 and v21.7 are the two the direction document said to stop postponing,
and both now exist as far as a container can take them: the runtime's logic
proven against the server, the shell built against the surfaces. Both finish
on a device. Next on the sequence is **v21.8, GST/HST and the finance close
expansion** — the same shape as every rule before it: a derivation over
records that carry their source, with the rate held unverified until a
person verifies it. And **P9 runs beside all of it**, the workstream only a
person can close.

# LeaseOS — Industrial Precision Design System

**Deliverable:** `leaseos-design-system.html` — tokens, component library and the five reference
templates, in one file with light/dark modes. No build step.
**Architecture:** unchanged. B15 engines, gates, provenance and lifecycle are untouched.

---

## 1. Why this came before B16

Agreed, and for the reason given: every new subsystem would otherwise inherit the current
navigation, card and table patterns. Five templates now, or fifty screens later.

---

## 2. The design idea

The brief pinned down palette, type, radii, spacing and status language precisely, so those are
implemented exactly as specified. Where it left room, the choice was **Manrope over Inter** — both
were offered, Manrope carries more character while staying professional, and Inter is the
everything-default.

The real design idea isn't the palette. It's that **density is the variable and components are the
constant**:

| Experience | Mode | Density | Primary actions |
|---|---|---|---|
| Field — driver, mechanic | Dark | One thing at a time | 1 |
| Operations — dispatch, office | Light | Exception-first, then dense | 2–4 |
| Client | Light | Spacious, outcomes only | 1–2 |

Same `StatusBadge`, same `Card`, same tokens. A driver's screen and a client's portal are built
from identical parts at different densities. That's what stops LeaseOS looking like five products.

---

## 3. Status system — the signature

Six states, one vocabulary, identical everywhere:

`✓ Ready` · `! Review` · `× Blocked` · `? Unknown` · `○ Pending` · `↻ Syncing`

**Icon and word carry the meaning; colour reinforces it.** These read correctly in greyscale, at a
glance, and to someone who can't distinguish red from green. Red appears only for a genuine safety
or legal stop — if half a screen is amber, nothing reads as urgent.

Defined once in `STATUS` and rendered through one `st()` helper. A state cannot look one way on
Dispatch and another on Documents, because there is only one place it's built.

---

## 4. Plain language, technical truth preserved

Enums are translated in one map (`HUMAN`), never inline:

| Engine value | What a person reads |
|---|---|
| `eligible_review` | Needs review |
| `partially_staffed` | Crew incomplete |
| `dependency_change` | Something changed since the last safety check |
| `unknown` | Not established |

The identifier stays available in the evidence drawer. An auditor needs the exact enum; a driver at
06:00 needs to know the truck can't leave. Same record, two audiences, one translation layer — and
because it's one layer, the vocabulary can't drift.

---

## 5. Progressive disclosure

Three levels, applied consistently:

```
TDG certification              ✓ Current      ← summary
  ▸ View details                              ← explanation
      Expires · Verified by · Source · Confidence · Fingerprint   ← evidence
```

Nothing is removed. It's sequenced. Every `details.evidence` in the system follows this shape,
including the one on the client invoice that explains where each charge came from.

---

## 6. Navigation: 35 items → 9

**Home · Jobs · Dispatch · Fleet · People · Documents · Billing · Map · More**, role-filtered.

The old prototype's 35 screens don't disappear — they become contextual subnavigation inside these
domains. The **Job Workspace** does most of that work: one Job with `Overview | Dispatch | Trips |
Loads | Safety | Documents | Billing | History`, role-filtered, so nobody has to remember which
global module holds which part of a job.

Global search sits in the command bar on every operations screen. Typing `DT-2026-004821-01`,
`VAC-27` or `04-12-084-06W5` should all resolve — the tracking chain from B11 is what makes that
possible and it's LeaseOS's most under-exposed strength.

---

## 7. The five templates

**Driver** — dark by default, single column, one 60px primary action with the GPS proposal as its
subtitle, three secondary buttons, then progress and what's still needed. Persistent mic for
*Tell LeaseOS*. Offline state stated plainly: *"Saved on this device. Two items waiting for signal.
Nothing is lost."* No administrative complexity visible at all — the manifests, HOS events and
billing evidence are being written underneath.

**Dispatch** — three columns: what needs someone now, the schedule, what's available. Six restrained
metric cards, not six colour blocks. The at-risk job shows the B15 pre-departure distinction in
human terms — *"Scheduled, not yet cleared to depart"* — with the engine state (`eligible_review ·
checked 04:12`) in the drawer.

**Job Workspace** — one exception banner at the top answering "what needs attention", then tabs,
then progress and health side by side. The unconfirmed departure time expands to explain that GPS
proposes and a person confirms.

**Office** — a priority queue, not a table of everything. Each card states the consequence:
*"Only the disposal charge is held — the other four lines can invoice now."* Normal completed work
doesn't compete for attention.

**Client** — the most generous spacing in the system, light only, outcomes and proof. No match
scores, no fingerprints, no OCR status. Four confirmations, three big numbers, documents, and one
invoice with an evidence drawer that explains every line in plain terms.

---

## 8. Two bugs found while building

**An invalid CSS declaration** — `border-radius(--r-input)` — sitting above the correct one. Silently
ignored by browsers, which is exactly why it survived.

**`st()` accepted a size argument it never used**, so `.st.lg` never applied anywhere it was called.
The badge rendered at default size and looked fine, which is how that class of bug persists.

---

## 9. Migration plan

Nothing is thrown away. `leaseos-prototype.html` (35 screens) stays as the **functional and IA
reference** — it documents behaviour this file doesn't attempt to re-cover.

Order:

1. Port tokens and `st()` into the React app as a `tokens.css` + `<StatusBadge>` — everything else
   depends on them
2. `AppShell`, `CommandBar`, `GlobalSearch`, `PageHeader`, nine-item nav
3. Job Workspace — highest leverage, absorbs the most existing screens
4. Driver Home — biggest change for the people with the least patience for software
5. Dispatch Command Centre — the demo screen
6. Office, then Client
7. Retire old screens only as their content lands in a workspace tab

**Do this incrementally.** The operational code keeps working throughout; this is a presentation
layer over engines that don't change.

---

## 10. Not done

- Component library exists as CSS classes, not React components. Porting is mechanical but real.
- Map panel, notification drawer, signature panel, voice capture sheet, confirmation sheet and
  filter chips are specified in the inventory but not built — they need the screens they live in.
- Marketing site not attempted. It's a separate brief and shouldn't borrow product chrome.
- No responsive tablet/in-cab layout yet. Phone and desktop are handled; the in-cab case sits
  between them and deserves its own pass rather than a breakpoint.

---

## 11. Status

Engines: **261 tests across 13**, untouched this pass.
71 tables · 14 migrations · typecheck unchanged (1 pre-existing error, Phase 0 item 3).

Ready for B16 once the tokens and `StatusBadge` are ported — after that, new subsystems inherit the
visual language instead of inventing one.

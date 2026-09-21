# LEASEOS — CLIENT ARCHITECTURE, ACCESS MODEL & BUILD SEQUENCE

**Status:** Owner decisions — 2026-09-18
**Scope:** How LeaseOS is delivered to each audience (office, driver, mechanic, subcontractor, customer), how access is scoped, and the order in which it gets built.
**Relationship to other docs:** This is an addendum to `LEASEOS_MASTER_PROGRAMMING_MANIFEST`. It does not override any invariant in that document — it applies them to the client/delivery layer.

---

## 1. DELIVERY ARCHITECTURE

### 1.1 One codebase, two delivery modes

LeaseOS is **one web codebase**, not separate applications per audience.

| Audience | Delivery | Why |
|---|---|---|
| Office / dispatch / billing | Plain browser, no install | Desk-bound, on wifi, large screens, never leaves connectivity |
| Driver | Web app wrapped natively (Capacitor) | Needs device GPS, background location, camera, durable offline |
| Mechanic (shop) | Either — browser on shop tablet, or wrapped app | Shop usually has wifi |
| Mechanic (field / yard) | Wrapped app | Walkarounds, defect photos, release captured at the vehicle with no signal |
| Subcontractor driver | Wrapped app, restricted shell | Same field needs, narrower data |
| Customer representative | Secure link, **no account** | Signs and observes only; see §4 |

### 1.2 Why a wrapper and not a pure PWA

A Progressive Web App covers installability and basic offline, but is **not sufficient** for:

- background location while the app is closed or backgrounded,
- reliable large-payload offline queues (photos, voice, signatures),
- consistent behaviour on iOS.

A native shell (Capacitor) wraps the same web build and exposes device GPS, camera, filesystem and background location. **One codebase, one build pipeline, one set of business logic.**

### 1.3 Rule of thumb

> Anyone who may be away from connectivity and needs camera, GPS, or offline capture gets the wrapped app. Everyone else uses the browser.

---

## 2. ROLE & SHELL MODEL

### 2.1 One app, one login, many shells

There is a single sign-in. The authenticated role selects which **shell** renders:

- **Driver shell** — large one-tap operational events, voice entry, trip/load/disposal flow
- **Mechanic shell** — defect queue, work orders, release
- **Office shell** — Exception Centre, dispatch, documents, billing
- **Admin shell** — configuration, roles, numbering sequences, regulatory sources

This matches the role switcher already present in the prototype. Do not fork the codebase per role.

### 2.2 Permissions attach to roles, not people

- A role defines a permission set once.
- People are assigned roles; they inherit the set.
- Changing what a role can do updates every holder.
- **A person may hold multiple roles simultaneously** (e.g. foreman = mechanic + dispatcher). Effective permissions are the union.

A "field mechanic" is **not** a new role. It is the mechanic role running on field hardware.

### 2.3 Server-side enforcement (non-negotiable)

Consistent with the existing manifest rule and the `roleProcedure` pattern already in `cand`:

- The shell decides **what is displayed**. It never decides **what is permitted**.
- Every sensitive action re-checks authorization server-side on every call.
- Hiding a button is a convenience, never a control.
- Cross-company data access is refused at the data layer, not filtered in the UI.

### 2.4 Admin shell hardening

The admin shell controls numbering sequences, per-customer billing configuration, role definitions, and regulatory source registration — i.e. it can change how the whole system numbers invoices and who may release a truck.

- Desk/browser only.
- Second factor required for admin sign-in.
- All admin configuration changes audited with actor, role, timestamp, old value, new value.

---

## 3. SUBCONTRACTOR & TENANCY MODEL

### 3.1 The problem

Subcontractors and owner-operators are not employees, but they must record trips and capture evidence. They must never see rate cards, billing, other customers, or the full job list.

### 3.2 Delegated company onboarding

Do **not** hand-create every subcontractor driver account — that makes the carrier the bottleneck.

1. Onboard the **subcontractor company** as an entity (the commercial org model already supports the Subcontractor/Owner-Operator role).
2. Create **one delegated "contractor admin"** account for their owner/dispatcher.
3. That admin invites and manages their own drivers within their own fenced scope.
4. Invited drivers self-register via invite link and land inside the restricted shell.

### 3.3 Tenant isolation

- Every record is stamped with its owning company.
- The server refuses to serve records across the tenant boundary — enforced in the data access layer, test-pinned.
- A subcontractor driver poking at the API must be **unable** to retrieve another company's data, not merely unable to see it.

### 3.4 Strategic note

This delegated multi-tenant machinery is the same machinery required to sell LeaseOS to entirely separate carriers. Once subcontractor tenancy works, onboarding a paying customer company is the same operation. Build it once, correctly.

### 3.5 Sequencing

Multi-tenancy is the **hardest** part of the client layer and is deliberately sequenced last (see §5). Do not build it before the single-company evidence spine is proven.

---

## 4. CUSTOMER PORTAL

### 4.1 Access model

The customer representative (e.g. company-man at the lease) has **no LeaseOS account**. Access is a secure, scoped link — permissions enforced server-side, consistent with the existing QR/digital-passport rule.

The link began as one-time field-ticket signature capture and extends into a live window on that customer's **own active job**.

### 4.2 Live tracking

Tracking reuses GPS breadcrumbs already captured for the trip record. This exposes an existing slice of data — it is not a second tracking system.

**Scoping rules:**

- **Job-boxed** — visible only for that specific ticket/job.
- **Time-boxed** — goes dark the moment the job closes.
- **Never beyond the job** — no route home, no meal stops, no next customer, no other jobs.

### 4.3 Driver privacy boundary

> **The customer sees their job, not your driver.**

Sort every proposed portal field into *job* or *driver*. Job data may be exposed; driver data may not.

| Exposed to customer | Withheld from customer |
|---|---|
| Volume moved on their job | Breaks taken |
| Round-trip time, loading time, turnaround | Driver location after job close |
| Arrival / departure at **their** site | Other customers, other jobs |
| Incidents occurring on **their** site | HOS status, duty history, personal data |

**Breaks are explicitly withheld.** They are driver behaviour rather than job outcome, they invite a customer to audit a person's day, and they are frequently legally required rest rather than slack. Breaks remain internal to office and compliance.

### 4.4 Tracking is not evidence

The live position is a **courtesy view**. It never writes to the evidence chain.

- A truck rendering near the gate does **not** set `ARRIVED`.
- Confirmed arrival still requires the driver's explicit confirmation (`PROPOSE → SHOW EVIDENCE → HUMAN CONFIRMATION → COMMIT`).
- The map layer and the evidence layer remain structurally separate. A provisional live dot must never leak into confirmed operational fact.

### 4.5 Portal tiers

Portal depth is a **per-customer configuration setting**, sitting alongside the existing per-customer billing configuration. One product with a knob — not two products.

**Light tier** — septic, freight, one-off hauls
Tracking only. "Where's my truck / where's my freight." Package-tracker simplicity. Table stakes.

**Heavy tier** — oilfield
Full operational dashboard: volume moved, round-trip times, loading times, turnaround, incident alerts. For a company-man paid to audit and control cost, this depth *is* the selling feature. Intended as a **priced premium tier**.

### 4.6 Billing alignment

Volumes shown in the portal are the same confirmed, scale-verified figures that flow to billing. The customer watches the exact number they will be invoiced on, as it happens. This pre-empts disputes rather than resolving them after the fact.

### 4.7 Incident alerts

Incident notifications fan out from the **existing** incident capture path (AI Secretary / incident records) to the customer portal when the event occurred on that customer's site. This is event routing to an additional audience — not a separate alarm system.

---

## 5. BUILD SEQUENCE

Each phase depends on the one before it. The discipline is **not to pull the later, more exciting phases forward**.

### Phase 1 — Evidence spine (single company, own crew)
One driver runs one job end to end: dispatch → drive → load → confirmed evidence → offline capture → sync → clean record. Web app plus wrapped driver app. No subcontractors, no portal, no tiers.
*Gate: a driver completes the full chain without paper.*

### Phase 2 — Internal seats
Mechanic and office shells on the same app. Role-based login, server-enforced permissions. Defect → work order → repair → test → mechanic release → dispatch recalculation. Exception Centre for the office.
*Still single-company.*

### Phase 3 — Money
Billing book, evidence-linked billing lines, invoicing, customer acceptance and dispute history. Works only because Phase 1 made the evidence trustworthy.

### Phase 4 — Light customer window
The basic secure tracking link. First outward-facing surface; the easier tier, so it precedes the dashboard. Driver-privacy boundary enforced from day one.

### Phase 5 — Premium dashboard
The oilfield tier — volumes matched to billing, round-trip and loading times, incident alerts. Gated per customer, priced as premium. Requires Phase 3 billing and Phase 4 portal plumbing.

### Phase 6 — Subcontractors & multi-tenancy
Delegated contractor admins, sealed tenant walls, invite flows. Last because it is hardest — and because it doubles as the foundation for selling LeaseOS to other carriers.

---

## 6. INVARIANTS ADDED BY THIS DOCUMENT

1. One codebase; role selects the shell; the shell never grants permission.
2. Cross-tenant isolation is enforced at the data layer and test-pinned.
3. Customer portal access is scoped, time-boxed, and job-boxed by default.
4. Live location is provisional and never writes confirmed operational state.
5. Driver-behaviour data (breaks, off-job location, HOS status) is never exposed to a customer.
6. Portal depth is configuration, not a code fork.
7. Multi-tenancy is built after the single-company evidence chain is proven, never before.

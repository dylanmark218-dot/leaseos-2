# Data permission requests — 511 Alberta, AER ST107, Saskatchewan IRIS / Manitoba Petroleum Branch

**Purpose.** Three of the eleven P6 items are blocked on a written answer from a data authority:
P6.3 (511 Alberta), P6.8 (AER ST107), P6.9 (Saskatchewan IRIS and Manitoba Petroleum Branch). These
are the requests to send. Each is drafted so that a **partial** answer is still usable — the
authority can say yes to some uses and no to others, and LeaseOS can record exactly that.

**Why they are worded this way.** A request that asks "may we use your data?" gets either a vague
yes that does not survive a later dispute, or a cautious no. Each letter below names the specific
uses, one per line, and asks for a yes or no against each. That is harder to write and much easier
to answer.

**What to do with the reply.** Record it against the source record and attach the document. Until
then each source stays `commercialUsePermitted: unknown` and the import gate refuses — which is the
correct state, not a problem to work around. A decline is as recordable as a grant; what LeaseOS
cannot store is silence.

---

## 1 — 511 Alberta

**To:** Government of Alberta — Transportation and Economic Corridors, 511 Alberta program
**Re:** Permission for commercial use of the 511 Alberta Developer API
**Source record:** `ab511` · API key held · no licence published alongside the API

> Subject: Written permission request — commercial use of 511 Alberta API data
>
> Hello,
>
> We operate LeaseOS, a commercial-vehicle operations platform used by trucking and oilfield
> carriers working in Alberta. We hold a 511 Alberta developer key and have read the developer
> documentation, which sets out the key requirement and the ten-calls-per-sixty-seconds throttle but
> does not state a licence or any terms for commercial use.
>
> Rather than assume, we are asking directly. We would like written confirmation of which of the
> following uses are permitted. Our system currently refuses to use 511 data for any of them, and
> will continue to refuse for any use you do not confirm.
>
> | # | Use | Permitted? |
> |---|---|---|
> | 1 | Retrieve road conditions, events, alerts and bridge restrictions through the API, within the published throttle | |
> | 2 | Store the retrieved data in our system, and retain it as a record of what was reported at a given time | |
> | 3 | Derive routing decisions from it — for example, treating a reported closure as a restriction on a road segment | |
> | 4 | Display the information, attributed to 511 Alberta, to our paying commercial customers inside our product | |
> | 5 | Include it in an offline data package on a driver's device, so it remains readable where there is no cellular signal | |
> | 6 | Show the reported condition to our customer's own client (for example, the oil and gas operator whose load is being hauled) as part of a job status view | |
>
> Two things we are **not** asking for: we do not wish to republish 511 data as a public feed, and
> we do not wish to resell it as a dataset. Our use is operational — helping a specific driver on a
> specific trip avoid a closure, and keeping a record of what was reported at the time.
>
> We are glad to carry whatever attribution you require, and to state the retrieval time alongside
> anything displayed, so that no one mistakes a cached condition for a live one.
>
> If any of these uses requires a formal agreement or a different licence tier, please tell us which
> and we will follow that process.
>
> If the answer to any of them is no, that is a useful answer and we will record it as such.
>
> With thanks,
> [name, title, company, contact]

---

## 2 — Alberta Energy Regulator, ST107

**To:** Alberta Energy Regulator — data and information services
**Re:** Mirroring ST107 (well and facility licence status) in a commercial product
**Source record:** not yet seeded · currently the directory stores the WM approval number and links out

> Subject: Written permission request — mirroring ST107 data in a commercial operations platform
>
> Hello,
>
> We operate LeaseOS, a commercial-vehicle and oilfield operations platform. Our customers haul to
> and from licensed facilities in Alberta, and they need to know that the facility they are
> delivering to holds a current approval before the load leaves.
>
> Today we store only the facility's approval number and link out to AER for the status, so that
> nobody relies on a copy of your record that may have gone stale. That is safe and it is slow: a
> driver at a lease with no signal cannot follow a link.
>
> We would like written confirmation of which of the following are permitted.
>
> | # | Use | Permitted? |
> |---|---|---|
> | 1 | Retrieve ST107 on a scheduled basis and store a copy, recording the date of the extract we hold | |
> | 2 | Show a facility's licence status inside our product to our commercial customers, stating the extract date | |
> | 3 | Use it operationally — for example, warning a dispatcher that a destination facility's approval is not current in the extract we hold | |
> | 4 | Include it in an offline package on a driver's device for the specific facilities on that driver's trip | |
> | 5 | Retain historical extracts as evidence of what the record showed on the date a load was dispatched | |
>
> Item 5 matters to us more than it may appear. When a load is questioned months later, the useful
> record is what the regulator's data said **on the day**, not what it says now. We would keep those
> extracts as evidence rather than presenting them as current.
>
> We are not asking to republish ST107, to offer it as a dataset, or to present our copy as
> authoritative. Anything we display would be attributed to AER and marked with the extract date, and
> our product would continue to direct anyone needing the authoritative status to AER.
>
> If mirroring is not permitted, please say so and we will keep the link-out approach.
>
> With thanks,
> [name, title, company, contact]

---

## 3 — Saskatchewan IRIS and Manitoba Petroleum Branch

**To:** Government of Saskatchewan — IRIS / Ministry of Energy and Resources; and Manitoba Petroleum Branch
**Re:** Terms for caching facility data under the Standard Unrestricted Use Data Licence
**Source records:** not yet seeded

> Subject: Confirmation request — caching facility data for offline operational use
>
> Hello,
>
> We operate LeaseOS, a commercial-vehicle operations platform used by carriers working in
> Saskatchewan and Manitoba. We are seeking confirmation of the terms that apply to facility and
> well data published through [IRIS / the Petroleum Branch GIS], specifically where that data is
> cached for offline use.
>
> Our understanding is that this data is published under a standard unrestricted use licence. Before
> relying on that understanding we would like it confirmed in writing, because our use has two
> characteristics that a general licence may not have contemplated:
>
> | # | Use | Permitted? |
> |---|---|---|
> | 1 | Store a copy of the published facility and well data, recording the date of the extract | |
> | 2 | Package the subset relevant to a specific trip onto a driver's device, so it is readable with no cellular signal | |
> | 3 | Display it to our commercial customers within our product, attributed, with the extract date shown | |
> | 4 | Retain historical extracts as a record of what the data showed on the date a load was dispatched | |
>
> If the standard licence already covers all four, a short confirmation to that effect is all we
> need and we will record it against the source. If any of them falls outside it, please tell us
> which.
>
> We would carry whatever attribution the licence requires, and would show the extract date alongside
> anything displayed so that a cached record is never mistaken for a live one.
>
> With thanks,
> [name, title, company, contact]

---

## Recording the answers

Whatever comes back — grant, partial grant, decline, or a pointer to a different licence tier — is
recorded against the source record with the document attached, and the gate opens only for the uses
actually confirmed.

Three things worth holding to when the replies arrive:

**A partial grant is recorded as a partial grant.** If an authority permits retrieval and storage
but not customer display, the source record should say exactly that rather than rounding to yes.
`commercialUsePermitted` and `redistributionPermitted` are separate fields for this reason — v22.74
established that permission for one purpose proves nothing about another.

**A decline is a result, not a failure.** It is recordable, and it ends the uncertainty. The state
that cannot be stored is silence, which is why these letters ask for a no as explicitly as a yes.

**Silence is not consent.** If an authority does not reply, the source stays `unknown` and the gate
stays shut. No amount of elapsed time converts an unanswered question into a permission.

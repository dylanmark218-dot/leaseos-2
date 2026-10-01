# Data permission requests — 511 Alberta, AER ST107, Saskatchewan IRIS / Manitoba Petroleum Branch, Saskatchewan Highway Hotline, the other 511s, and the Ontario 511 logo

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

## 4 — Saskatchewan Highway Hotline

**To:** Saskatchewan Highway Hotline, via https://hotline.gov.sk.ca/contact
**Re:** Machine-readable access and terms for Highway Hotline information
**Source record:** `sk_highway_hotline` · no developer API published · the website is not scraped

Unlike the others, this one asks for access before it asks for rights. There is nothing published
to call, and reading the public website with a script is not a substitute: a page layout is not a
contract, and it would let LeaseOS read data it has no recorded right to use.

> Subject: Request for data access and terms — Highway Hotline information in a commercial platform
>
> Hello,
>
> We operate LeaseOS, a commercial trucking and oilfield transportation platform used by carriers
> working in Saskatchewan. We would like to use official Highway Hotline information for road
> conditions, closures, construction, over-dimensional load notices, winter and ice-road information
> and ferries. We would keep it alongside our own routing, showing the source and the time it was
> retrieved.
>
> We understand a public Highway Hotline developer API existed in the past. We could not find one
> today. We have not scraped the website and will not.
>
> Could you tell us whether Saskatchewan offers any of the following, and on what terms?
>
> | # | Question | Answer |
> |---|---|---|
> | 1 | An API or machine-readable feed (Open511, JSON, XML, GeoJSON, ArcGIS/WFS or similar) | |
> | 2 | Developer credentials or a key, and how to apply | |
> | 3 | A licence or terms of use covering display of the information to our commercial customers | |
> | 4 | Whether the information may be stored, and kept as a record of what was reported at a time | |
> | 5 | Whether it may be included in an offline package on a driver's device | |
> | 6 | Required attribution wording or branding | |
> | 7 | Rate limits or caching requirements | |
>
> Our use is operational. We do not want to republish Highway Hotline data as a public feed or resell
> it. We would never present it as LeaseOS's own information.
>
> If the answer to any of these is no, that is a useful answer and we will record it as such.
>
> With thanks,
> [name, title, company, contact]

---

## 5 — Manitoba 511, New Brunswick 511, 511 Yukon, 511 Newfoundland and Labrador

*Superseded for sending by §6, which tracks each of these separately with the full question list.
Kept because it records why the four are blocked.*

**Source records:** `mb511`, `nb511`, `yt511`, `nl511` · keys available on registration · no licence
published alongside any of the four APIs

These four run the same 511 platform as Alberta and are in the same position: the developer page
documents the key and the "Ten calls every 60 seconds" throttle, and the Developer Resources page
states no licence. Send the §1 letter to each one, changing only the name of the service.

- **Yukon first.** Its API publishes weight restrictions and bridge restrictions, which matter more
  for trucks than anything else on the four.
- **Manitoba** publishes winter-road information.
- **New Brunswick and Newfoundland and Labrador** publish ferry information.

Ontario is not on this list. Its Developer Resources page puts the data under OGL – Ontario and
names commercial vendors, so `on511` is verified. It still needs a developer key. One question
remains for Ontario: its page calls the 511 logo "mandatory", but OGL – Ontario excludes logos from
what it grants. Ask Ontario 511 in writing where, if anywhere, the logo may be shown. Until they
answer, show the licence attribution line and no logo.

---

## 6 — Provincial road information: one tracked request per jurisdiction

§1, §4 and §5 above stay as drafted. This section replaces "send the §1 letter to each one" with a
separate request per jurisdiction. Each has its own status line, so an answer from one province is
never read as covering another. All six use the same eleven questions. Each question is a distinct
use, so a partial answer can be recorded exactly.

**Nothing here is approved.** Every status below is **NOT SENT**. Each source stays
`commercialUsePermitted: unknown` and `rights_review` until a written answer is attached to its
registry record through `geo.sourceReview`. A reply that answers some questions opens only those
uses.

### The eleven questions

> | # | May LeaseOS… | Yes / No / Conditions |
> |---|---|---|
> | 1 | retrieve the data programmatically through your published API or feed, within your stated rate limits? | |
> | 2 | cache it on our servers, so one collection serves all our customers instead of each device calling you? | |
> | 3 | normalize it — convert your records into our internal format, with your source and retrieval time kept on every record? | |
> | 4 | store historical copies for audit and evidence, so we can show what was reported when a route was approved? | |
> | 5 | display it inside a commercial product to paying customers? | |
> | 6 | use it for commercial-vehicle route decision support — for example, flagging an approved route for review when you report a closure on it? | |
> | 7 | display warnings we derive from it on a route ("closure reported on Hwy X, km 12–18"), attributed to you? | |
> | 8 | redistribute limited derived information to our authenticated customers and their drivers — not as a dataset or public feed? | |
> | 9 | include it in an offline route package on a driver's device, for use where there is no cellular signal? | |
> | 10 | keep the source evidence after the event has expired upstream, as part of the record of a trip? | |
> | 11 | show attribution once in the app (a data-sources page and the screens that show your data), rather than on every map marker? | |
>
> We are **not** asking to republish your data as a public feed or to resell it as a dataset. If a
> use needs a formal agreement or a different licence tier, please tell us which. If the answer to
> any question is no, that is a useful answer, and we will record it.

Use the §1 letter's opening and closing for each request, with the table above in place of §1's
six-row table. Saskatchewan uses §4's opening instead, because it asks for access before rights.

### Tracking

| # | Jurisdiction | Source record | Send to | Key held | Status | Sent | Answer |
|---|---|---|---|---|---|---|---|
| 6.1 | Alberta | `ab511` | 511 Alberta, via the contact link on https://511.alberta.ca/ | yes | **NOT SENT** | — | none |
| 6.2 | Manitoba | `mb511` | Manitoba 511, via the contact link on https://www.manitoba511.ca/ | obtainable | **NOT SENT** | — | none |
| 6.3 | New Brunswick | `nb511` | New Brunswick 511, via the contact link on https://511.gnb.ca/ | obtainable | **NOT SENT** | — | none |
| 6.4 | Yukon | `yt511` | 511 Yukon, via the contact link on https://511yukon.ca/ | obtainable | **NOT SENT** | — | none |
| 6.5 | Newfoundland and Labrador | `nl511` | 511 NL, via the contact link on https://511nl.ca/ | obtainable | **NOT SENT** | — | none |
| 6.6 | Saskatchewan | `sk_highway_hotline` | Highway Hotline, https://hotline.gov.sk.ca/contact | no API | **NOT SENT** | — | none |

Notes for each one:

- **6.1 Alberta.** Its public terms permit non-commercial reproduction and require written
  permission for commercial use (`server/_core/knowledge/leaseos_511_alberta_license_gate.json`).
  The request is therefore for that written permission. It does not ask Alberta to confirm an open
  licence, because Alberta has none.
- **6.4 Yukon.** Send first. Its API publishes weight restrictions and bridge restrictions, which
  matter more for trucks than anything else among the five.
- **6.6 Saskatchewan.** Questions 1–11 follow §4's access questions. Nothing scrapes the Hotline
  website while this is outstanding (`server/canadianProviderRuntime.test.ts` holds that).

When an answer arrives:

1. Set the row's status to the date received.
2. Fill in **Answer** (granted / partial / declined / other licence).
3. Attach the document to the registry record through `geo.sourceReview`.
4. Record only the uses actually granted.

---

## 7 — Ontario 511: may the 511 logo be shown, and where?

**Source record:** `on511` (cleared under OGL – Ontario for the data) · **Status: NOT SENT**

The data is cleared. The logo is a separate, unresolved question:

- **The developer page** (https://511on.ca/developers/resources) says the Ontario 511 logo is "a
  variation of the national 511 logo, a federally registered trademark owned by … AASHTO" and that
  "use of the logo is mandatory in conjunction with Ontario 511".
- **OGL – Ontario** (https://www.ontario.ca/page/open-government-licence-ontario) "does not grant you
  any right to use … the names, crests, logos, or other official symbols of the Information Provider"
  or "Information subject to other intellectual property rights, including … trade-marks and
  official marks".

So one page says the logo is required and the licence the data is under excludes it. LeaseOS will
not resolve that conflict by assumption.

**Until Ontario answers in writing:**

- no Ontario 511 logo or branding graphic is shipped
- the attribution projection carries `logoPermitted: false`
- the textual licence attribution, *"Contains information licensed under the Open Government Licence
  – Ontario"*, is shown wherever Ontario data appears

> Subject: Ontario 511 logo — where may it be shown in a third-party application?
>
> Hello,
>
> We use Ontario 511 data under the Open Government Licence – Ontario in LeaseOS, a commercial-vehicle
> operations platform, with the OGL – Ontario attribution statement.
>
> Your Developer Resources page says use of the Ontario 511 logo is mandatory in conjunction with
> Ontario 511. The Open Government Licence – Ontario excludes logos and official marks from what it
> grants. We would like to do what you require without using a mark we have no right to use.
>
> Could you tell us:
>
> 1. Whether we must display the Ontario 511 logo, or whether the OGL – Ontario attribution
>    statement is sufficient.
> 2. If the logo is required, which artwork and usage guidelines apply, and whether we need a
>    separate permission or agreement (including from AASHTO for the national 511 mark).
> 3. Where it should appear: a data-sources page, alongside Ontario-sourced warnings, or elsewhere.
>
> We will not display the logo until we hear from you.
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

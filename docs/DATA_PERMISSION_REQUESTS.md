# Data permission requests — 511 Alberta, AER, Saskatchewan IRIS

**Status: drafts for Dylan to send.** These unblock **P6.3**, **P6.8** and **P6.9**, which between
them gate **P2.2** and much of **P2.4**. They are the longest-lead items on the register — an
authority answers in weeks, not days — so they should be in flight while other work proceeds.

## Why these are worded the way they are

A vague ask gets a vague answer, and a vague answer cannot be recorded. The gate needs two specific
facts per source — *may we use this commercially* and *may we redisplay it to our customers* — and
anything that does not answer both leaves the source at `unknown`, which refuses.

So each letter:

- **names the exact uses**, in the order the data actually flows, rather than asking for "permission
  to use the data";
- **says what we will not do**, because the fastest route to a refusal is an ask that sounds like
  republishing someone's dataset as our own;
- **offers the attribution we will carry**, since that is usually what the authority wants and is
  cheap for us to commit to;
- **asks for a written answer either way** — a documented decline is as useful to the register as a
  permission, and far more useful than silence.

Each is short on purpose. The person who reads it has to be able to forward it to whoever actually
decides, without editing.

---

## 1 — 511 Alberta (`ab511`)

**To:** Government of Alberta — Transportation and Economic Corridors, 511 Alberta programme
**Blocks:** P6.3 → P2.2, and the dynamic-restriction overlay in the mapping spec (§8)

> **Subject: Commercial use permission — 511 Alberta developer API**
>
> Hello,
>
> We operate LeaseOS, a commercial vehicle operations platform used by trucking and oilfield
> carriers working in Alberta. We hold a 511 Alberta developer API key.
>
> We would like written confirmation of what that key permits, because the developer page states the
> access terms and the throttle but does not state a licence for the data itself.
>
> Specifically, we are asking whether we may:
>
> 1. **retrieve** Road Conditions, Events, Alerts and Bridge Restrictions via the API, at the
>    published rate of ten calls per sixty seconds;
> 2. **cache** those responses on our own servers so that a driver who has lost cellular coverage
>    still sees the conditions that applied when the trip was planned;
> 3. **use them commercially** — that is, inside a paid product, to inform commercial-vehicle route
>    evaluation for our customers;
> 4. **redisplay** the condition or closure affecting a specific road segment to the carrier
>    operating on it, and to that carrier's own customer where the carrier chooses to share trip
>    status.
>
> What we are **not** asking for, and will not do: we will not republish 511 Alberta data as a
> dataset, will not offer it as a feed to third parties, and will not present it as anything other
> than Government of Alberta information.
>
> We will carry attribution in the form you prefer. Our default, unless you direct otherwise, is
> "Road condition information © Government of Alberta, retrieved via 511 Alberta" shown wherever the
> data appears, with the retrieval timestamp.
>
> If any of the four uses above is not permitted, we would be grateful to know which — a documented
> "no" is genuinely useful to us, because our system refuses to use a source whose permissions are
> unrecorded, and we would rather it refuse for a reason we can point at than by default.
>
> If there is a licence agreement or terms document that already covers this, please point us at it
> and we will work from that instead.
>
> Thank you,
> [name, title, company, contact]

---

## 2 — Alberta Energy Regulator (`aer_st37`, `aer_st102`, `aer_st107`)

**To:** Alberta Energy Regulator — data or licensing contact
**Blocks:** P6.8 → P2.4

One letter for all three datasets. Asking three times invites three separate reviews and three
chances for one to stall.

Note for the sender: ST37 and ST102 are recorded in our registry as carrying **AER Terms of Use /
Copyright and Disclaimer**, and ST107 as carrying **no stated licence**. The letter asks about all
three together but flags that difference, because pretending we have not read the terms is worse
than asking how they apply.

> **Subject: Commercial use and redisplay — ST37, ST102 and ST107**
>
> Hello,
>
> We operate LeaseOS, a commercial vehicle and oilfield operations platform. Our customers are
> carriers hauling to and from licensed sites in Alberta, and we use well and facility identity to
> make sure a load is recorded against the right location — the surface LSD, the downhole UWI, and
> the facility that receives it.
>
> We would like written confirmation of the permitted use of three AER datasets:
>
> - **ST37** — List of Wells in Alberta
> - **ST102** — Facility List
> - **ST107** — Well and Facility Licence data
>
> We have read the AER Terms of Use and Copyright and Disclaimer that accompany ST37 and ST102. We
> are asking how they apply to our specific use, and separately what terms apply to ST107, for which
> we have not found a stated licence.
>
> Our intended use, in order:
>
> 1. **mirror** the datasets on our own servers, refreshed on a schedule we agree with you;
> 2. **resolve** a licence number, well identifier or facility name entered by a dispatcher or read
>    from a field ticket, to confirm we have the right location on a manifest;
> 3. **use that resolution commercially**, inside a paid product;
> 4. **show the matched record** — licence number, operator, location, status — to the carrier using
>    it, and on the manifest and disposal documents that carrier produces.
>
> We are **not** asking to redistribute the datasets. We will not offer AER data as a download, a
> feed or a searchable public directory, and we will not present it as our own.
>
> We will carry attribution as you direct, and will show the date of the AER release each record
> came from so that a reader can tell how current it is.
>
> If any of these uses requires a licence agreement, we would be glad to enter one. If any is not
> permitted, please tell us which — our system holds a source as unusable until its permissions are
> recorded, so a documented decline lets us configure it correctly rather than leaving it blocked by
> default.
>
> Thank you,
> [name, title, company, contact]

---

## 3 — Saskatchewan IRIS (`sk_iris`)

**To:** Government of Saskatchewan — Ministry of Energy and Resources, IRIS
**Blocks:** P6.9 → P2.4

Note for the sender: the register refers to a *Standard Unrestricted Use Data Licence*. If
Saskatchewan has already published that licence and it covers commercial use and redisplay, this
letter becomes a much shorter confirmation — **check for the published licence before sending**, and
if it exists, ask only whether it applies to IRIS well and facility data.

> **Subject: Commercial use and redisplay — IRIS well and facility data**
>
> Hello,
>
> We operate LeaseOS, a commercial vehicle and oilfield operations platform whose customers haul to
> and from licensed sites in Saskatchewan. We use well and facility identity to confirm that a load
> is recorded against the correct location on its manifest and disposal documents.
>
> We would like written confirmation of the permitted use of IRIS well and facility data, and
> whether the Standard Unrestricted Use Data Licence applies to it.
>
> Our intended use is to mirror the data on our own servers, resolve identifiers entered by a
> dispatcher or read from a field ticket, use that resolution inside a paid product, and show the
> matched record to the carrier using it and on the documents that carrier produces.
>
> We are not asking to redistribute the data as a dataset, a feed or a public directory.
>
> We will carry the attribution the licence requires, and will show which IRIS release each record
> came from.
>
> If the Standard Unrestricted Use Data Licence already covers this, a short confirmation is all we
> need. If it does not, please tell us what does — or that this use is not permitted, which we would
> record as a decline rather than leave open.
>
> Thank you,
> [name, title, company, contact]

---

## When an answer arrives

Whichever way it goes, it gets recorded against the **source key**, not the dataset name:

| Source key | Registry |
|---|---|
| `ab511` | `externalDataSources` |
| `aer_st37`, `aer_st102`, `aer_st107` | `externalDataSources` |
| `sk_iris` | `externalDataSources` |

`externalDataSources` governs **imports**. `knowledgeSources` governs **assistant passages**, and is
a different gate — a permission recorded against the wrong one leaves the real gate shut while
reading as open (v23.11).

A permission moves a source to `commercialUsePermitted: "yes"` and `status: "verified"` **only with
the written answer stored against it**. A decline is recorded as `"no"` with the same evidence. The
one thing neither of them is, is `unknown` — which is what all five say today, and why they refuse.

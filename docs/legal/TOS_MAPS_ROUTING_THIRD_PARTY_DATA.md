# Terms of Service — Maps, Routing and Third-Party Transportation Data

**Status: DRAFT. Counsel has not reviewed it.** Register row L21. This is the section of the LeaseOS
Terms of Service (L2) that covers government and third-party road data. Have a Canadian
technology/commercial lawyer review it before launch, after the provider answers in
`docs/P6_DATA_PERMISSION_REQUESTS.md` have come back. Those answers may change what this section
has to say.

The section is different from provider attribution. Attribution is what each publisher requires LeaseOS
to show (`collectAttributions()` builds it from the registry; see `DATA_SOURCES.md`). This section is
LeaseOS's own position toward its users.

**Dependency:** the text below refers to a "Data Sources and Attributions page". That page does not
exist yet. The data behind it does: `attributionProjection()` in `server/transportFeedRuntime.ts`,
served today to administrators by `geo.transportFeeds`. Each entry carries the provider,
jurisdiction, dataset, licence and URL, required attribution text, source page, and rights status
and date. It never carries a credential, a review note or an internal note. Build the page, and
decide who may read the projection (today it requires `geo.source.review`), before this section is
published. Until then, the reference points at nothing.

**Ontario logo:** no provider logo is used. Ontario's developer page calls the 511 logo mandatory,
while OGL – Ontario excludes logos from its grant. The question is tracked in
`docs/P6_DATA_PERMISSION_REQUESTS.md` §7. The projection carries `logoPermitted: false` until a
written answer is recorded.

---

### Maps, Routing and Third-Party Transportation Data

LeaseOS may display, process, combine or derive routing and transportation information from
third-party and government information providers, including provincial and territorial
road-information services, open-data services, mapping providers and transportation authorities.

Third-party information may include road conditions, closures, construction, incidents,
weather-related conditions, seasonal restrictions, weight restrictions, bridge restrictions,
inspection facilities, rest areas, ferry information and other transportation information.

Third-party information remains subject to the applicable provider's licence, terms of use,
attribution requirements and intellectual-property rights. LeaseOS does not claim ownership of
third-party government information merely because that information is displayed, normalized,
cached, analysed or incorporated into a LeaseOS route assessment.

Applicable data-source attribution and licence information is available through the LeaseOS Data
Sources and Attributions page.

Third-party transportation information may be delayed, incomplete, inaccurate, unavailable,
superseded or inconsistent with posted road signs, permits, emergency directions or instructions
issued by a competent road or regulatory authority.

LeaseOS routing, mapping, alerts and compliance assessments are decision-support tools. They do not
replace posted signs, issued permits, regulatory requirements, carrier obligations, driver
obligations, instructions of law-enforcement or transportation authorities, or the exercise of
reasonable professional judgment.

A route displayed by LeaseOS does not, by itself, represent a guarantee that the route is legal,
open, safe or suitable for a particular vehicle, load, dangerous good, axle configuration, weight or
dimension.

Where LeaseOS does not possess sufficient verified information to determine a material
transportation restriction, the system may designate the result as unknown, review required,
unavailable or another equivalent status rather than representing the condition as compliant.

Users must comply with current legislation, permits, posted restrictions and directions issued by
the applicable transportation or regulatory authority.

LeaseOS and its third-party information providers do not warrant uninterrupted availability of
external data services. External APIs, datasets, licences, access limits and data formats may be
changed, suspended or discontinued by their respective providers.

Nothing in LeaseOS creates or implies endorsement, sponsorship or certification by any government,
transportation authority or third-party information provider unless expressly stated by that
organization.

---

### How the code already matches this text

| Clause | Where it is enforced |
|---|---|
| Third-party information is decision support, not a verdict | `RoadAdvisory.advisoryOnly: true` is structural; `feedSourceFor` sets `advisoryOnly` on every provincial feed |
| Unknown rather than compliant | `evaluateSourceUsage` refuses on `unknown`; a stale feed resolves to `unknown`, never PASS (`externalDataRegistry.ts`) |
| Subject to each provider's licence | The collector's CLEARED gate refuses any source without a recorded licence review, and records the refusal as a run |
| No implied endorsement | OGL – Ontario and OGL – BC both exclude official marks. No government logo is shown until the permission to show it is recorded (`SOURCE_CAVEATS.on511`, `logoPermitted: false`) |
| Information may be delayed, unavailable or superseded | A provider outage, a page that may be cut short, or an empty listing never withdraws a held advisory. The health screen names the failure (`docs/transport/CANADIAN_PROVIDER_RUNTIME.md`) |
| A displayed route is not a guarantee | A closure reported on an approved route makes the approval stale, and dispatch readiness stops reporting it as eligible until a person re-approves it. A reported condition never makes a route legal, and never clears a verified restriction |

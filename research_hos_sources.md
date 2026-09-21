# HOS and short-haul source notes

LeaseOS must treat the following as configurable compliance profiles, not universal legal advice. Jurisdiction, vehicle, load, carrier status, provincial/state rules, and cross-border operation can change the result.

| Jurisdiction | Verified source finding | Product implication |
|---|---|---|
| Canada | Transport Canada states that a federally regulated driver operating within 160 km of the home terminal and returning each day is not required to complete a RODS and therefore does not require an ELD; if the driver goes outside 160 km at any time, an ELD is required. | Track home-terminal radius, daily return, and an immediate escalation event when the boundary is crossed. |
| Canada | Transport Canada says federally regulated carriers/drivers subject to RODS need a certified compliant ELD; provincial/territorial enforcement and requirements must also be checked. | Store operating jurisdiction and cross-border status; require regulator-profile review. |
| United States | FMCSA describes a short-haul exception for operations within a 150 air-mile radius that return to the normal work reporting location within a 14-consecutive-hour duty period; drivers using the exception are not required to keep RODS or use ELDs. | Use air-mile radius for the U.S. federal profile, not a road-distance conversion. |
| United States | FMCSA summarizes an 11-hour driving limit after 10 consecutive hours off duty and a 14-hour driving window for property-carrying drivers. | Keep separate driving, on-duty window, and off-duty calculations. |
| United States | 49 CFR Part 395 is continuously updated and contains the controlling federal HOS/ELD provisions; it is authoritative but the eCFR itself is unofficial. | Persist source version/date and require human/legal review of production rules. |

## Safety boundary

The app should never decide legal compliance from radius alone. It should evaluate radius, daily return, duty duration, prior off-duty time, driving time, jurisdiction, HazMat/placard context, emergency or special operating conditions, vehicle/carrier profile, and current provincial/state rules. If any required input is unknown or a route/load crosses a jurisdiction boundary, the result should be **review required** and the driver should be directed to the applicable full-log/ELD workflow.

## References

1. [Transport Canada — ELD handout for motor carriers and drivers](https://tc.canada.ca/en/road-transportation/electronic-logging-devices/eld-handout-motor-carriers-drivers)
2. [FMCSA — Who is exempt from the ELD rule?](https://www.fmcsa.dot.gov/hours-service/elds/who-exempt-eld-rule)
3. [FMCSA — Summary of Hours of Service Regulations](https://www.fmcsa.dot.gov/regulations/hours-service/summary-hours-service-regulations)
4. [eCFR — 49 CFR Part 395](https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395)

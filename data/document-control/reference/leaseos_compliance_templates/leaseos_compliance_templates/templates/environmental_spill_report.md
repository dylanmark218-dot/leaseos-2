# {{title}}

**Incident Ref:** {{incidentRef}}
**Jurisdiction:** {{jurisdiction}}
**Verification Status:** {{verificationStatus}}

## 1. Incident Record

- Discovery date: {{discoveryDate}}
- Discovery time: {{discoveryTime}}
- Reported to company: {{reportedToCompanyAt}}
- Reporter: {{reporterName}}
- Job: {{jobRef}}
- Truck / unit: {{unitRef}}
- Trailer: {{trailerRef}}

## 2. Location & Release

- Site / facility: {{siteName}}
- Lease / well: {{leaseOrWellId}}
- County / parish: {{countyOrParish}}
- Location description: {{locationDescription}}
- Coordinates: {{latitude}}, {{longitude}}
- Released material: {{releaseMaterial}}
- Release source / observed origin: {{releaseSource}}
- Quantity: {{estimatedQuantity}} {{quantityUnit}} ({{quantityPrecision}})
- Affected media: {{affectedMedia}}

## 3. Immediate Observations & Actions

- Injury / exposure observed: {{injuryOrExposureObserved}}
- Fire / explosion observed: {{fireOrExplosionObserved}}
- Containment actions: {{containmentActions}}
- Cleanup actions: {{cleanupActions}}
- Waste generated reference: {{wasteGeneratedRef}}
- Weather / site conditions: {{weatherConditions}}
- Nearby receptors / sensitive areas: {{nearbyReceptors}}

## 4. Agency Notifications

{{#each agencyNotifications}}
| Agency | Contact / method | Date / Time | Contact person | Case / reference |
|---|---|---|---|---|
| {{this.agency}} | {{this.method}} | {{this.dateTime}} | {{this.contact}} | {{this.reference}} |
{{/each}}

## 5. Evidence

{{#each photosEvidence}}
- {{this.type}} — {{this.reference}} — {{this.description}}
{{/each}}

## 6. Reporting Decision & Corrective Action

- Reporting determination: {{reportingDetermination}}
- Reviewer reporting basis: {{reportingBasis}}
- External case numbers: {{externalCaseNumbers}}
- Corrective action plan: {{correctiveActionPlan}}
- Closed at: {{closedAt}}

**Verified by:** {{verifiedBy}}

**Reviewer notes:**
{{reviewNotes}}

> This form records observations, notifications, evidence, and a human review decision. Reportability can depend on material, quantity, media, location, jurisdiction, permits, and other facts; the engine should not infer a legal reporting conclusion from this template alone.

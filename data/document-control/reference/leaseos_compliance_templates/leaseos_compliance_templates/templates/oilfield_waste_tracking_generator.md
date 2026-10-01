# {{title}}

**Document Ref:** {{documentRef}}
**Jurisdiction:** {{jurisdiction}}
**Verification Status:** {{verificationStatus}}

## 1. Generator / Waste Origin

- Generator: {{generatorLegalName}}
- Generator / regulator ID: {{generatorId}}
- Contact: {{generatorContact}}
- Lease / site: {{leaseOrSiteName}}
- Lease / facility ID: {{leaseOrFacilityId}}
- Well / asset ID: {{wellOrAssetId}}
- County / parish: {{countyOrParish}}
- Origin coordinates: {{originLatitude}}, {{originLongitude}}

## 2. Waste Profile

- Waste profile ID: {{wasteProfileId}}
- Waste type: {{wasteType}}
- Description: {{wasteDescription}}
- Classification status: {{wasteClassificationStatus}}
- Waste / regulatory codes: {{wasteCodes}}
- Quantity: {{quantity}} {{quantityUnit}}
- Container / vessel: {{containerType}}
- Container count: {{containerCount}}

## 3. Transport

- Transporter: {{transporterName}}
- Permit / authorization: {{transporterPermitNumber}}
- USDOT: {{transporterUsdotNumber}}
- Driver: {{driverName}}
- Unit: {{unitNumber}}
- Pickup date / time: {{pickupDate}} {{pickupTime}}
- Manifest number: {{manifestNumber}}
- Shipping-paper reference: {{shippingPaperReference}}

## 4. Destination & Receipt

- Destination facility: {{destinationFacilityName}}
- Destination facility ID / permit: {{destinationFacilityId}}
- Destination address: {{destinationAddress}}
- Receiving date: {{receivingDate}}
- Receiving ticket: {{receivingTicketNumber}}

### Custody Events

{{#each custodyEvents}}
| Event | Date / Time | Party | Reference | Signature |
|---|---|---|---|---|
| {{this.event}} | {{this.dateTime}} | {{this.party}} | {{this.reference}} | {{this.signature}} |
{{/each}}

## 5. Evidence & Certification

**Supporting evidence:**
{{#each supportingEvidence}}
- {{this.type}}: {{this.reference}}
{{/each}}

**Generator certification:**
{{generatorCertificationText}}

Generator signer: {{generatorSignatureName}}
Transporter signer: {{transporterSignatureName}}
Receiver signer: {{receiverSignatureName}}

## 6. Review

- Verified by: {{verifiedBy}}
- Verified at: {{verifiedAt}}
- Status: {{verificationStatus}}

**Reviewer notes:**
{{reviewNotes}}

> This is a jurisdiction-configurable tracking template. Where a federal, state, tribal, or local manifest or waste profile is required, use the applicable prescribed form/system and retain its reference here.

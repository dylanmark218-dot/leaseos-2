# {{title}}

**Document Ref:** {{documentRef}}
**Jurisdiction:** {{jurisdiction}}
**Survey Date:** {{surveyDate}}
**Handling Status:** {{handlingStatus}}

## 1. Survey Record

- Site / lease: {{siteOrLeaseName}}
- Well / equipment: {{wellOrEquipmentId}}
- Survey start: {{surveyStartTime}}
- Survey end: {{surveyEndTime}}
- Surveyor: {{surveyorName}}
- Radiation Safety Officer: {{rsoName}}
- License / registration: {{licenseOrRegistrationNumber}}

## 2. Instrument & Calibration

- Manufacturer: {{instrumentManufacturer}}
- Model: {{instrumentModel}}
- Serial number: {{instrumentSerialNumber}}
- Calibration date: {{instrumentCalibrationDate}}
- Calibration evidence: {{instrumentCalibrationEvidenceRef}}

## 3. Radiation / Contamination Observations

- Background: {{backgroundReading}} {{backgroundUnit}}
- Maximum gamma reading: {{maxGammaReading}} {{gammaReadingUnit}}
- Maximum reading location: {{maxReadingLocation}}
- Surface contamination result: {{contaminationResult}}
- Removable contamination result: {{removableContaminationResult}}
- Radionuclides identified: {{radionuclidesKnown}}

### Samples

{{#each samples}}
| Sample ID | Location | Material | Result | Lab / Report |
|---|---|---|---|---|
| {{this.sampleId}} | {{this.location}} | {{this.material}} | {{this.result}} | {{this.reportReference}} |
{{/each}}

## 4. Handling / Transfer / Disposal

- Affected material / equipment: {{affectedMaterial}}
- Handling status: {{handlingStatus}}
- Packaging: {{packagingDescription}}
- Labeling: {{labelingDescription}}
- Transportation classification / review reference: {{transportationClassificationRef}}
- Destination facility: {{destinationFacilityName}}
- Destination permit / license: {{destinationPermitOrLicense}}
- Transfer date: {{transferDate}}

### Chain of Custody

{{#each chainOfCustody}}
| Event | Date / Time | From | To | Reference |
|---|---|---|---|---|
| {{this.event}} | {{this.dateTime}} | {{this.from}} | {{this.to}} | {{this.reference}} |
{{/each}}

## 5. Review

- Reviewer decision: {{reviewDecision}}
- Verified by: {{verifiedBy}}
- Verified at: {{verifiedAt}}

**Attachments:**
{{#each attachments}}
- {{this.type}} — {{this.reference}}
{{/each}}

**Reviewer notes:**
{{reviewNotes}}

> NORM controls are jurisdiction-specific. Keep the governing radiation-control license/registration, survey records, transportation classification, and receiving/disposal authorization as evidence. Do not use this template as a substitute for an issuing authority's prescribed form.

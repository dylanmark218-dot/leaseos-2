# LeaseOS Unified Document-Control Template Catalog

Cataloged **46 canonical document definitions** from **81 source artifacts** across **10 uploaded template collections**.

## Core import rule

**A template is optional.** Every definition must support Document Control without requiring a LeaseOS-generated template. A company may use the LeaseOS template, map its own template, or scan/import an external document while preserving issuer/provenance and external sequence numbers.

The numbering policy values below are implementation candidates, not regulatory claims. Claude must reconcile them with the live LeaseOS repository and tenant/jurisdiction configuration before migration or seed work.

## Assets / Niche Operations

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `equipment_rental_contract_and_inventory_log` | Equipment Rental Contract and Inventory Log | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `hazard_communication_sds_acknowledgment` | Hazard Communication / SDS Acknowledgment | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `lumber_hotshot_delivery_ticket` | Lumber / Hotshot Delivery Ticket | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `returnable_asset_tracking_rental_receipt` | Returnable Asset Tracking / Rental Receipt | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |

## Carrier Compliance & Permits

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `boc_3_process_agent_record` | BOC-3 / Process Agent Record | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `carrier_credential_and_permit_checklist` | Carrier Credential & Permit Checklist | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `carrier_insurance_evidence_record` | Carrier Insurance Evidence Record | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `dot_fmcsa_registration_and_authority_record` | DOT / FMCSA Registration & Authority Record | 2 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `dot_roadside_inspection_compliance_record` | DOT / Roadside Inspection Compliance Record | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |

## Environmental Compliance

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `environmental_spill_incident_report` | Environmental / Spill Incident Report | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `environmental_compliance_spill_reporting_form` | Environmental Compliance / Spill Reporting Form | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `environmental_corrective_action_and_closeout_record` | Environmental Corrective Action & Closeout Record | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `environmental_release_notification_log` | Environmental Release Notification Log | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `spill_response_and_site_inspection_checklist` | Spill Response & Site Inspection Checklist | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |

## Freight & Transportation

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `bill_of_lading` | Bill Of Lading | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `commercial_invoice` | Commercial Invoice | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `freight_and_oilfield_manifest` | Freight And Oilfield Manifest | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `proof_of_delivery` | Proof Of Delivery | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `rate_and_load_confirmation` | Rate And Load Confirmation | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `weighing_and_inspection_report` | Weighing And Inspection Report | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |

## Incident & Evidence

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `accident_investigation_report` | Accident Investigation Report | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `incident_report` | Incident Report | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `injury_report` | Injury Report | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `near_miss_report` | Near Miss Report | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |

## NORM / Radiological

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `norm_equipment_survey_release_record` | NORM Equipment Survey / Release Record | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `norm_material_classification_and_disposition_record` | NORM Material Classification & Disposition Record | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `norm_material_transfer_chain_of_custody` | NORM Material Transfer / Chain of Custody | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `norm_survey_and_handling_record` | NORM Survey & Handling Record | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |
| `norm_survey_field_sheet` | NORM Survey Field Sheet | 1 | `ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED` |

## Oilfield / Waste

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `disposal_ticket_waste_disposal_receipt` | Disposal Ticket / Waste Disposal Receipt | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `hazardous_waste_manifest_e_manifest_tracking_log` | Hazardous Waste Manifest / e-Manifest Tracking Log | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `oilfield_load_ticket_load_record` | Oilfield Load Ticket / Load Record | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |
| `oilfield_waste_profile_and_characterization_record` | Oilfield Waste Profile & Characterization Record | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `oilfield_waste_tracking_generator_compliance_form` | Oilfield Waste Tracking / Generator Compliance Form | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `waste_load_and_container_inspection_checklist` | Waste Load & Container Inspection Checklist | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `waste_manifest_hazardous_waste_manifest_internal_record` | Waste Manifest / Hazardous Waste Manifest - Internal Record | 1 | `INTERNAL_CONTROL_NUMBER_PLUS_OFFICIAL_EXTERNAL_REFERENCE_WHEN_APPLICABLE` |
| `waste_pickup_transfer_ticket` | Waste Pickup / Transfer Ticket | 1 | `CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES` |

## Safety & Daily Operations

| Definition key | Display name | Variants | Numbering candidate |
|---|---|---:|---|
| `daily_safety_report` | Daily Safety Report | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `hazard_assessment` | Hazard Assessment | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `job_safety_analysis` | Job Safety Analysis | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `pre_job_safety_checklist` | Pre Job Safety Checklist | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `safety_meeting_minutes` | Safety Meeting Minutes | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `site_safety_checklist` | Site Safety Checklist | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `tailgate_meeting_log` | Tailgate Meeting Log | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `toolbox_talk` | Toolbox Talk | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |
| `worksite_inspection_report` | Worksite Inspection Report | 1 | `CONTROLLED_SEQUENCE_CANDIDATE` |

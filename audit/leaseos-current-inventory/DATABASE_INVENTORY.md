# LeaseOS — database inventory

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only audit. Nothing was dropped, altered or created.

**408 production tables**, all created by one of **165 migrations** (`0000`–`0168`). Every table's `CREATE TABLE` was located in a migration — there are no schema-only tables.

## Method

- **Principal writer** — a production (non-test) file containing `insert(<table>)`, `update(<table>)` or `delete(<table>)`, or a raw-SQL `INSERT/UPDATE/DELETE` against it.
- **Principal readers** — production files containing `from(<table>)` or otherwise referencing the table symbol.
- **Tenant strategy** — LeaseOS has no per-row tenant column on most tables. Scope is carried by `coreRecordOwnership(orgRef, recordType, recordId)` for `unit`, `operator`, `load` and `financial_entity`, and reached through `ownershipScopeWhere()` (`server/db.ts:791`). Tables scoped through a unit or operator inherit it; tables with their own `orgRef`/`tenantId` column are noted.
- **Related feature** is the domain grouping below; **related router/service** is the principal reader/writer file.

Purpose is stated where the schema or its comments state it. Where they do not, the entry says so rather than inventing one.

---

## AI / assistant (8 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `tailgateMeetings` | `0005_closed_madripoor` | `db.ts` | `auditRouter.ts`, `db.ts` | yes |
| `dailyLogs` | `0010_billing_records_chain` | **none** | **none** | yes |
| `operatorAvailability` | `0013_dispatch_operations` | **none** | **none** | **no** |
| `assistantProposals` | `0014_assistant_proposals` | `_core/assistantCommitService.ts`, `db.ts` | `_core/assistantCommitService.ts`, `db.ts` +1 | yes |
| `assistantCommitReceipts` | `0025_assistant_commit_receipts` | `_core/assistantCommitService.ts` | `_core/assistantCommitService.ts`, `surfacesService.ts` | yes |
| `assistantQuestions` | `0027_document_extraction_questions` | `questionQueueService.ts` | `questionQueueService.ts`, `surfacesService.ts` | yes |
| `assistantQueries` | `0101_knowledge_passages` | `assistantAskRouter.ts` | `assistantAskRouter.ts` | yes |
| `commercialChainSequences` | `0117_commercial_chain_numbers` | `contractorOperationsRouter.ts` | `contractorOperationsRouter.ts` | **no** |

## AI / knowledge (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `transferAcknowledgements` | `0005_closed_madripoor` | `db.ts` | `db.ts` | **no** |
| `programAcknowledgements` | `0036_compliance_master_registry` | **none** | `auditRouter.ts` | **no** |
| `knowledgePassages` | `0101_knowledge_passages` | `assistantAskRouter.ts` | `assistantAskRouter.ts` | yes |
| `knowledgeSources` | `0118_knowledge_source_registry` | `_core/knowledge/repository.ts` | **none** | yes |
| `knowledgeVersions` | `0118_knowledge_source_registry` | **none** | **none** | yes |
| `knowledgeChunks` | `0118_knowledge_source_registry` | `_core/knowledge/repository.ts` | `_core/knowledge/repository.ts` | yes |

## AP / purchasing (5 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `vendors` | `0006_clean_namor` | `commercialOfficeRouter.ts`, `commercialRouter.ts` +1 | `_core/recordsAuthorization.ts`, `auditRouter.ts` +8 | yes |
| `purchaseAuthorizations` | `0034_roadside_purchasing_ap` | `purchasingRouter.ts` | `purchasingRouter.ts`, `surfacesService.ts` | yes |
| `vendorBills` | `0034_roadside_purchasing_ap` | `commercialRouter.ts`, `gstRouter.ts` +1 | `_core/exceptionCentre.ts`, `_core/profitability.ts` +9 | yes |
| `vendorBillLines` | `0034_roadside_purchasing_ap` | `commercialRouter.ts`, `purchasingRouter.ts` | `commercialSetupRouter.ts`, `purchasingRouter.ts` +1 | yes |
| `customerPurchaseOrders` | `0047_commercial_core_portals` | `commercialRouter.ts` | `commercialRouter.ts`, `commercialSetupRouter.ts` +1 | **no** |

## Assets (3 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `capitalAssets` | `0052_capital_assets_cca` | `assetRouter.ts` | `assetRouter.ts` | yes |
| `ccaSchedules` | `0052_capital_assets_cca` | `assetRouter.ts` | `assetRouter.ts`, `auditRouter.ts` | **no** |
| `ccaClassBalances` | `0052_capital_assets_cca` | `assetRouter.ts` | `assetRouter.ts` | yes |

## Audit (4 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `scanAudits` | `0004_lazy_colonel_america` | `db.ts`, `enforcementRouter.ts` | `db.ts` | yes |
| `auditPackages` | `0057_audit_packages` | `auditRouter.ts` | `auditRouter.ts` | yes |
| `auditPackageItems` | `0057_audit_packages` | `auditRouter.ts` | `auditRouter.ts` | **no** |
| `auditPackageAccess` | `0057_audit_packages` | `auditRouter.ts` | **none** | yes |

## Automation policy (2 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `capabilityEntitlements` | `0153_automation_policy` | `_core/automationPolicyStore.ts` | `_core/automationPolicyStore.ts`, `automationPolicyRouter.ts` | **no** |
| `automationPolicies` | `0153_automation_policy` | `_core/automationPolicyStore.ts` | `_core/automationPolicyStore.ts`, `automationPolicyRouter.ts` | **no** |

## Billing / AR (31 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `complianceArtifacts` | `0005_closed_madripoor` | `db.ts` | `db.ts` | **no** |
| `billingRateCards` | `0006_clean_namor` | `db.ts` | `db.ts` | yes |
| `billingBooks` | `0010_billing_records_chain` | `invoicingRouter.ts` | `invoicingRouter.ts`, `surfacesService.ts` | yes |
| `invoices` | `0010_billing_records_chain` | `cashRouter.ts`, `commercialRouter.ts` +3 | `_core/accountsReceivable.ts`, `_core/attachmentAuthorizers.ts` +18 | yes |
| `customerBillingConfigs` | `0011_taxonomy_billing_snapshots` | **none** | `invoicingRouter.ts` | yes |
| `billingBookEntries` | `0011_taxonomy_billing_snapshots` | `invoicingRouter.ts` | `invoicingRouter.ts` | yes |
| `billingSnapshots` | `0011_taxonomy_billing_snapshots` | `invoicingRouter.ts` | `invoicingRouter.ts` | yes |
| `billingAdjustments` | `0018_billing_adjustments` | **none** | **none** | **no** |
| `billingAuthorityBands` | `0018_billing_adjustments` | **none** | `_core/billingAdjustment.ts` | yes |
| `nearMissReports` | `0019_records_evidence_vault` | `recordsService.ts` | **none** | yes |
| `payRates` | `0022_payroll_finance_tax` | `payrollService.ts` | `payrollRouter.ts`, `payrollService.ts` | yes |
| `payrollEarningEvents` | `0022_payroll_finance_tax` | `payrollService.ts` | `payrollService.ts` | yes |
| `payrollEarningEvidence` | `0022_payroll_finance_tax` | **none** | **none** | **no** |
| `fleetFuelCards` | `0033_fuel_energy_ledger` | **none** | `_core/assistantCommitService.ts`, `fuelOpsRouter.ts` | yes |
| `carrierProfileReviews` | `0036_compliance_master_registry` | `complianceRouter.ts` | `_core/exceptionCentre.ts`, `surfacesService.ts` | yes |
| `iftaReturns` | `0040_ifta` | `iftaRouter.ts` | `auditRouter.ts`, `iftaRouter.ts` +1 | yes |
| `customerRateCards` | `0047_commercial_core_portals` | `commercialRouter.ts` | `commercialRouter.ts`, `projectRouter.ts` | **no** |
| `customerRateCardLines` | `0047_commercial_core_portals` | `commercialRouter.ts` | `commercialRouter.ts`, `projectRouter.ts` | **no** |
| `roadHazardObservations` | `0049_portal_hardening_adjustments` | `closeoutRouter.ts` | `portalRouter.ts` | **no** |
| `parts` | `0051_fleet_shop` | `_core/enforcementCommit.ts`, `shopRouter.ts` | `_core/aiProposal.ts`, `_core/compliancePassport.ts` +25 | yes |
| `partMovements` | `0051_fleet_shop` | `shopRouter.ts` | `assetRouter.ts`, `shopRouter.ts` | yes |
| `warrantyPolicies` | `0051_fleet_shop` | `shopRouter.ts` | `shopRouter.ts` | **no** |
| `warrantyClaims` | `0051_fleet_shop` | `shopRouter.ts` | `shopRouter.ts` | **no** |
| `onboardingPlans` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `workforceRouter.ts` | **no** |
| `onboardingTasks` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `workforceRouter.ts` | **no** |
| `offboardings` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `workforceRouter.ts` | **no** |
| `chargeDefinitions` | `0065_commercial_setup` | `commercialSetupRouter.ts` | `_core/linePricing.ts`, `commercialSetupRouter.ts` | yes |
| `invoiceLines` | `0067_invoice_lines` | `invoicingRouter.ts` | `commercialOfficeRouter.ts`, `invoicingRouter.ts` +1 | yes |
| `boardMessages` | `0096_message_board` | `messageBoardRouter.ts` | `messageBoardRouter.ts` | yes |
| `privateRateSchedules` | `0115_contractor_owner_operator_operations` | `contractorOperationsRouter.ts` | `contractorOperationsRouter.ts` | yes |
| `wasteStreamVocabulary` | `0139_facility_directory` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts` | **no** |

## Calibration (4 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `calibrationEvents` | `0037_requirement_engine_packs_calibration` | `requirementRouter.ts` | `integrationRouter.ts`, `readinessComposer.ts` +2 | **no** |
| `retrievalMeasurements` | `0103_probe_origin` | `assistantAskRouter.ts` | `assistantAskRouter.ts` | yes |
| `calibrationSweeps` | `0163_calibration_sweep` | `requirementRouter.ts` | `surfacesService.ts` | **no** |
| `calibrationSweepFindings` | `0163_calibration_sweep` | `requirementRouter.ts` | **none** | **no** |

## Commercial office (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `commercialSetupProfiles` | `0065_commercial_setup` | `commercialSetupRouter.ts` | `commercialSetupRouter.ts` | **no** |
| `commercialNumberingPolicies` | `0133_commercial_office_configuration` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | **no** |
| `commercialSettings` | `0133_commercial_office_configuration` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | **no** |
| `commercialApprovalPolicies` | `0133_commercial_office_configuration` | `commercialOfficeRouter.ts` | `_core/commercialApprovalService.ts`, `commercialOfficeRouter.ts` | yes |
| `commercialCategoryTypes` | `0133_commercial_office_configuration` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | yes |
| `commercialApprovals` | `0136_commercial_approval_ledger` | `_core/commercialApprovalService.ts` | `_core/commercialApprovalService.ts`, `auditRouter.ts` +1 | yes |

## Communications (7 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `radioChannels` | `0074_communications` | `commsRouter.ts` | `commsRouter.ts`, `geoRouter.ts` +1 | yes |
| `companyRadioAuthorizations` | `0074_communications` | `commsRouter.ts` | `commsRouter.ts`, `geoRouter.ts` +1 | yes |
| `radioSignObservations` | `0074_communications` | `commsRouter.ts` | `commsRouter.ts` | **no** |
| `communicationCoverage` | `0074_communications` | `commsRouter.ts` | `commsRouter.ts`, `geoRouter.ts` +1 | **no** |
| `communicationPlans` | `0074_communications` | `commsRouter.ts` | `commsRouter.ts` | **no** |
| `communicationPolicies` | `0075_communications_reach_dispatch` | `commsRouter.ts` | `commsRouter.ts`, `readinessComposer.ts` | yes |
| `communicationPackages` | `0076_offline_communication_package` | `commsRouter.ts` | `commsRouter.ts` | **no** |

## Compliance documents (5 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `complianceDocuments` | `0003_rich_multiple_man` | `complianceRouter.ts`, `db.ts` +2 | `_core/complianceDocumentValidity.ts`, `auditRouter.ts` +7 | yes |
| `complianceRequirements` | `0036_compliance_master_registry` | `complianceRouter.ts` | `complianceRouter.ts` | **no** |
| `complianceConsents` | `0036_compliance_master_registry` | `complianceRouter.ts` | **none** | **no** |
| `compliancePacks` | `0037_requirement_engine_packs_calibration` | **none** | **none** | **no** |
| `complianceKnowledgeItems` | `0108_training_academy_hardening` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |

## Contractors (5 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `subcontractors` | `0018_billing_adjustments` | **none** | **none** | **no** |
| `subcontractedLines` | `0018_billing_adjustments` | **none** | **none** | **no** |
| `contractorSettlements` | `0022_payroll_finance_tax` | `payrollService.ts` | `_core/entityScope.ts`, `payrollService.ts` | yes |
| `contractorSettlementLines` | `0022_payroll_finance_tax` | `payrollService.ts` | **none** | yes |
| `contractorBusinessProfiles` | `0115_contractor_owner_operator_operations` | `contractorOperationsRouter.ts` | **none** | **no** |

## Customers (4 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `customerRecoveryProposals` | `0034_roadside_purchasing_ap` | `purchasingRouter.ts` | **none** | yes |
| `customerCredits` | `0045_bank_and_receivables` | `cashRouter.ts`, `invoicingRouter.ts` | `cashRouter.ts`, `commercialOfficeRouter.ts` +3 | yes |
| `customerAccounts` | `0046_customer_accounts` | `cashRouter.ts`, `commercialOfficeRouter.ts` +1 | `cashRouter.ts`, `closeoutRouter.ts` +6 | yes |
| `customerContractTerms` | `0059_contract_terms` | `closeoutRouter.ts` | `closeoutRouter.ts`, `commercialSetupRouter.ts` | **no** |

## Devices (5 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `fieldDevices` | `0035_secure_field_runtime` | `deviceRouter.ts`, `workforceRouter.ts` | `closeoutRouter.ts`, `deviceRouter.ts` +3 | yes |
| `deviceKeyEvents` | `0035_secure_field_runtime` | `deviceRouter.ts` | `deviceRouter.ts` | **no** |
| `deviceSyncNonces` | `0110_device_cryptographic_binding` | `deviceRouter.ts` | **none** | **no** |
| `measurementDevices` | `0037_requirement_engine_packs_calibration` | `requirementRouter.ts` | `_core/exceptionCentre.ts`, `integrationRouter.ts` +3 | yes |
| `measurementDeviceAssignments` | `0037_requirement_engine_packs_calibration` | **none** | `readinessComposer.ts` | **no** |

## Dispatch (9 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `dispatchPostings` | `0013_dispatch_operations` | `_core/dispatchTransaction.ts` | `_core/dispatchTransaction.ts`, `dispatchRouter.ts` +1 | yes |
| `dispatchRoles` | `0013_dispatch_operations` | `_core/dispatchTransaction.ts` | `_core/dispatchTransaction.ts` | **no** |
| `dispatchInvitations` | `0013_dispatch_operations` | `_core/dispatchTransaction.ts` | **none** | **no** |
| `dispatchBids` | `0013_dispatch_operations` | `_core/dispatchTransaction.ts` | `_core/dispatchTransaction.ts` | **no** |
| `dispatchEligibilityChecks` | `0013_dispatch_operations` | `_core/dispatchTransaction.ts`, `dispatchEnforcementService.ts` +1 | `_core/automationPolicy.ts`, `_core/dispatchTransaction.ts` +4 | yes |
| `dispatchOverrides` | `0013_dispatch_operations` | `dispatchRouter.ts` | `dispatchEnforcementService.ts`, `dispatchRouter.ts` | yes |
| `dispatchAuditEvents` | `0013_dispatch_operations` | `_core/dispatchTransaction.ts` | `_core/dispatchTransaction.ts` | **no** |
| `dispatchTemplates` | `0013_dispatch_operations` | **none** | **none** | **no** |
| `dispatchEnforcementSettings` | `0039_dispatch_enforcement` | `dispatchRouter.ts` | `dispatchEnforcementService.ts` | yes |

## Disposal (2 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `disposalTickets` | `0010_billing_records_chain` | `_core/assistantCommitService.ts`, `commercialRouter.ts` | `_core/assistantCommitService.ts`, `_core/fieldTicket.ts` +7 | yes |
| `disposalBatches` | `0010_billing_records_chain` | **none** | **none** | **no** |

## Documents (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `documentExtractions` | `0027_document_extraction_questions` | **none** | `_core/assistantCommitService.ts` | yes |
| `documentFingerprints` | `0029_fingerprints_merchant_memory` | `_core/assistantCommitService.ts` | `_core/assistantCommitService.ts` | yes |
| `knowledgeDocuments` | `0118_knowledge_source_registry` | `_core/knowledge/repository.ts` | `_core/knowledge/repository.ts` | yes |
| `commercialDocuments` | `0144_commercial_document_registry` | `commercialOfficeRouter.ts` | `auditRouter.ts`, `commercialOfficeRouter.ts` | **no** |
| `commercialDocumentLinks` | `0144_commercial_document_registry` | `commercialOfficeRouter.ts` | `auditRouter.ts`, `commercialOfficeRouter.ts` | **no** |
| `commercialDocumentDeliveries` | `0144_commercial_document_registry` | `commercialOfficeRouter.ts` | `auditRouter.ts`, `commercialOfficeRouter.ts` | **no** |

## Enforcement (9 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `roadsideServiceEvents` | `0034_roadside_purchasing_ap` | `purchasingRouter.ts` | `purchasingRouter.ts`, `readinessComposer.ts` +1 | yes |
| `enforcementDocumentExtractions` | `0082_enforcement_persistence` | `_core/enforcementCommit.ts`, `enforcementRouter.ts` | **none** | yes |
| `enforcementEvents` | `0082_enforcement_persistence` | `_core/enforcementCommit.ts` | `_core/enforcementCommit.ts`, `enforcementRouter.ts` | yes |
| `enforcementViolations` | `0082_enforcement_persistence` | `_core/enforcementCommit.ts` | `_core/enforcementCommit.ts`, `enforcementRouter.ts` | yes |
| `enforcementCitations` | `0082_enforcement_persistence` | `_core/enforcementCommit.ts` | `_core/enforcementCommit.ts` | yes |
| `outOfServiceOrders` | `0082_enforcement_persistence` | `_core/enforcementCommit.ts` | `_core/enforcementCommit.ts`, `enforcementRouter.ts` | yes |
| `oosReleaseFindings` | `0082_enforcement_persistence` | `enforcementRouter.ts` | `_core/enforcementCommit.ts`, `enforcementRouter.ts` | yes |
| `oosReleasePolicies` | `0084_oos_release_policies` | `commsRouter.ts` | `_core/enforcementCommit.ts`, `commsRouter.ts` +1 | yes |
| `roadsidePanelGrants` | `0088_roadside_panel_grants` | `enforcementRouter.ts` | `enforcementRouter.ts` | yes |

## Evidence (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `evidenceRecords` | `0001_parallel_bastion` | `db.ts`, `recordsService.ts` | `commercialOfficeRouter.ts`, `db.ts` +3 | yes |
| `evidenceRelationships` | `0019_records_evidence_vault` | `_core/assistantCommitService.ts`, `insuranceRouter.ts` +1 | `recordsService.ts` | yes |
| `evidenceVersions` | `0019_records_evidence_vault` | `recordsService.ts` | **none** | **no** |
| `evidenceSeals` | `0019_records_evidence_vault` | `deviceRouter.ts`, `recordsService.ts` | `_core/evidenceSeal.ts`, `deviceRouter.ts` +1 | yes |
| `evidenceAccessEvents` | `0019_records_evidence_vault` | `recordsService.ts` | **none** | **no** |
| `remoteWorkEvidence` | `0032_integrity_closure` | **none** | **none** | yes |

## External feeds (3 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `importBatches` | `0012_road_graph_ingestion` | **none** | **none** | **no** |
| `datasetConfirmations` | `0012_road_graph_ingestion` | **none** | **none** | **no** |
| `resourceBookings` | `0013_dispatch_operations` | `_core/dispatchTransaction.ts` | `_core/dispatchTransaction.ts` | yes |

## Facility directory (10 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `facilityStatements` | `0135_facility_statements` | `commercialOfficeRouter.ts` | `auditRouter.ts`, `commercialOfficeRouter.ts` | yes |
| `facilityStatementLines` | `0135_facility_statements` | `commercialOfficeRouter.ts` | `_core/recordsAuthorization.ts`, `auditRouter.ts` +1 | **no** |
| `facilitySourceLicences` | `0139_facility_directory` | **none** | `facilityDirectoryRouter.ts`, `surfacesService.ts` | yes |
| `facilityCapabilities` | `0139_facility_directory` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts` | **no** |
| `facilityEvidence` | `0139_facility_directory` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts`, `surfacesService.ts` | yes |
| `facilityAliases` | `0139_facility_directory` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts` | **no** |
| `facilityOperatingHours` | `0140_facility_driver_coordination` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts` | **no** |
| `facilityCallAheads` | `0140_facility_driver_coordination` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts` | yes |
| `facilityWaitReports` | `0140_facility_driver_coordination` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts` | yes |
| `facilityImportRuns` | `0143_facility_imports` | `facilityDirectoryRouter.ts` | `facilityDirectoryRouter.ts` | **no** |

## Field tickets (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `fieldTickets` | `0010_billing_records_chain` | `closeoutRouter.ts` | `_core/fieldTicket.ts`, `auditRouter.ts` +6 | yes |
| `fieldTicketLines` | `0010_billing_records_chain` | `closeoutRouter.ts` | `_core/measurementQuality.ts`, `closeoutRouter.ts` +2 | yes |
| `fieldTicketSignatures` | `0010_billing_records_chain` | `closeoutRouter.ts` | `auditRouter.ts`, `closeoutRouter.ts` +1 | yes |
| `fieldTicketEvents` | `0010_billing_records_chain` | `closeoutRouter.ts` | `auditRouter.ts`, `closeoutRouter.ts` +1 | yes |
| `fieldTicketRevisions` | `0048_site_signoff_chain` | `closeoutRouter.ts` | `auditRouter.ts`, `closeoutRouter.ts` +1 | yes |
| `fieldTicketDocuments` | `0049_portal_hardening_adjustments` | `closeoutRouter.ts`, `invoicingRouter.ts` | `auditRouter.ts`, `closeoutRouter.ts` +3 | yes |

## Finance (7 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `spendingLimits` | `0034_roadside_purchasing_ap` | **none** | `purchasingRouter.ts` | yes |
| `periodCloses` | `0042_period_close` | `periodRouter.ts` | `periodCloseService.ts` | yes |
| `bankAccounts` | `0045_bank_and_receivables` | `cashRouter.ts` | `cashRouter.ts`, `periodCloseService.ts` | **no** |
| `bankStatements` | `0045_bank_and_receivables` | `cashRouter.ts` | `cashRouter.ts`, `periodCloseService.ts` | yes |
| `bankStatementLines` | `0045_bank_and_receivables` | `cashRouter.ts` | `cashRouter.ts`, `periodCloseService.ts` | **no** |
| `commercialGlAccounts` | `0138_gl_mapping` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | **no** |
| `commercialGlMappings` | `0138_gl_mapping` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | **no** |

## Fleet (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `units` | `0003_rich_multiple_man` | `db.ts` | `_core/assistantCommitService.ts`, `_core/attachmentAuthorizers.ts` +26 | yes |
| `unitSafetyPlans` | `0006_clean_namor` | `db.ts` | `db.ts` | **no** |
| `fundingOpportunities` | `0026_funding_intelligence` | `fundingService.ts` | `fundingService.ts` | yes |
| `recallUnitStatus` | `0051_fleet_shop` | `shopRouter.ts` | `auditRouter.ts`, `shopRouter.ts` | **no** |
| `vehicleProfiles` | `0058_spatial_foundation` | `spatialRouter.ts` | `spatialRouter.ts` | **no** |
| `unitRadioCapabilities` | `0074_communications` | `commsRouter.ts` | `commsRouter.ts`, `geoRouter.ts` +1 | **no** |

## Fuel (7 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `fuelAccounts` | `0033_fuel_energy_ledger` | **none** | **none** | yes |
| `fuelTransactions` | `0033_fuel_energy_ledger` | `_core/assistantCommitService.ts`, `fuelOpsRouter.ts` +2 | `assetRouter.ts`, `fuelOpsRouter.ts` +4 | yes |
| `bulkFuelTanks` | `0041_bulk_fuel_statements` | `fuelOpsRouter.ts` | `fuelOpsRouter.ts`, `periodCloseService.ts` | **no** |
| `bulkFuelDispenses` | `0041_bulk_fuel_statements` | `fuelOpsRouter.ts` | `fuelOpsRouter.ts`, `periodCloseService.ts` | **no** |
| `bulkFuelReadings` | `0041_bulk_fuel_statements` | `fuelOpsRouter.ts` | `fuelOpsRouter.ts`, `periodCloseService.ts` | **no** |
| `fuelStatements` | `0041_bulk_fuel_statements` | `fuelOpsRouter.ts` | `cashRouter.ts`, `fuelOpsRouter.ts` +1 | **no** |
| `fuelStatementLines` | `0041_bulk_fuel_statements` | `fuelOpsRouter.ts` | `cashRouter.ts`, `fuelOpsRouter.ts` +1 | yes |

## Funding (2 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `fundingProgramSources` | `0026_funding_intelligence` | **none** | **none** | **no** |
| `fundingPrograms` | `0026_funding_intelligence` | `fundingService.ts` | `fundingService.ts` | yes |

## HOS (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `dutyRecords` | `0008_trip_operations` | `db.ts`, `integrationRouter.ts` | `_core/recordsAuthorization.ts`, `auditRouter.ts` +3 | yes |
| `drivingEvents` | `0055_telematics_video_safety` | `integrationRouter.ts`, `telematicsRouter.ts` | `auditRouter.ts`, `integrationRouter.ts` +1 | **no** |
| `hosRuleProfiles` | `0077_hos_rule_registry` | `hosRouter.ts` | `_core/knowledge/scopeGuard.ts`, `hosRouter.ts` | yes |
| `hosRuleLimits` | `0077_hos_rule_registry` | `_core/knowledge/promotionLedger.ts`, `_core/knowledge/rulePromotion.ts` +1 | `_core/hosClockPresentation.ts`, `_core/knowledge/promotionLedger.ts` +2 | yes |
| `hosRuleLimitHistory` | `0120_hos_rule_limit_history` | `_core/knowledge/promotionLedger.ts` | `_core/knowledge/promotionLedger.ts` | yes |
| `hosAttestations` | `0155_hos_attestation` | `hosRouter.ts` | `hosRouter.ts`, `readinessComposer.ts` | yes |

## Identity / RBAC (4 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `users` | `0000_productive_thundra` | `db.ts` | `_core/driverTraining.ts`, `_core/externalSourceSeeds.ts` +4 | yes |
| `userRoleAssignments` | `0020_domain_role_assignments` | `db.ts` | `_core/actingScope.ts`, `_core/assistantCommitService.ts` +4 | yes |
| `roleBootstrapEvents` | `0021_active_role_uniqueness` | `db.ts` | **none** | yes |
| `commercialRoleTypes` | `0133_commercial_office_configuration` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | **no** |

## Incidents / safety (10 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `safetyEvents` | `0001_parallel_bastion` | `db.ts` | `auditRouter.ts`, `db.ts` +1 | yes |
| `incidentReports` | `0019_records_evidence_vault` | `recordsService.ts` | `db.ts`, `insuranceRouter.ts` +2 | yes |
| `incidentPeople` | `0019_records_evidence_vault` | **none** | **none** | **no** |
| `incidentActions` | `0019_records_evidence_vault` | **none** | **none** | **no** |
| `deviceSafetyLatches` | `0087_device_safety_latches` | `enforcementRouter.ts` | `enforcementRouter.ts` | yes |
| `securityIncidents` | `0131_security_incidents_privacy_breaches` | `securityIncidentsRouter.ts` | `_core/exceptionCentre.ts`, `_core/recordsAuthorization.ts` +3 | yes |
| `securityIncidentEvents` | `0131_security_incidents_privacy_breaches` | `securityIncidentsRouter.ts` | `securityIncidentsRouter.ts` | **no** |
| `securityIncidentOrganizations` | `0131_security_incidents_privacy_breaches` | `securityIncidentsRouter.ts` | `securityIncidentsRouter.ts` | **no** |
| `incidentNotificationObligations` | `0131_security_incidents_privacy_breaches` | `securityIncidentsRouter.ts` | `securityIncidentsRouter.ts`, `surfacesService.ts` | **no** |
| `incidentMatters` | `0156_restricted_records_vault` | `restrictedVaultRouter.ts` | `restrictedVaultRouter.ts` | yes |

## Inspections (1 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `inspections` | `0003_rich_multiple_man` | `db.ts` | `_core/complianceRequirementSeeds.ts`, `_core/monitoringNotice.ts` +7 | yes |

## Insurance (9 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `fundingClaims` | `0026_funding_intelligence` | `fundingService.ts` | `fundingService.ts` | yes |
| `insuranceProviders` | `0038_insurance_risk` | `insuranceRouter.ts` | `insuranceRouter.ts` | yes |
| `insurancePolicies` | `0038_insurance_risk` | `insuranceRouter.ts` | `_core/exceptionCentre.ts`, `auditRouter.ts` +3 | yes |
| `insurancePolicyCoverages` | `0038_insurance_risk` | `insuranceRouter.ts` | `insuranceRouter.ts`, `readinessComposer.ts` | yes |
| `insuranceCoveredEntities` | `0038_insurance_risk` | `insuranceRouter.ts` | `insuranceRouter.ts`, `readinessComposer.ts` | yes |
| `insuranceRequirements` | `0038_insurance_risk` | `insuranceRouter.ts` | `insuranceRouter.ts` | **no** |
| `insuranceClaims` | `0038_insurance_risk` | `insuranceRouter.ts` | `auditRouter.ts`, `insuranceRouter.ts` | yes |
| `insuranceClaimCosts` | `0038_insurance_risk` | `insuranceRouter.ts` | `insuranceRouter.ts` | yes |
| `insuranceClaimRecoveries` | `0038_insurance_risk` | `insuranceRouter.ts` | `insuranceRouter.ts` | yes |

## Integrations (1 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `integrationClients` | `0054_integration_gateway` | `db.ts`, `integrationRouter.ts` | `db.ts`, `integrationRouter.ts` +1 | yes |

## Jobs (5 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `jobs` | `0001_parallel_bastion` | `commercialOfficeRouter.ts`, `db.ts` | `_core/attachmentAuthorizers.ts`, `_core/exceptionCentre.ts` +23 | yes |
| `jobUnits` | `0003_rich_multiple_man` | `db.ts`, `dispatchEnforcementService.ts` | `_core/recordsAuthorization.ts`, `db.ts` +3 | yes |
| `jobChargeLines` | `0006_clean_namor` | `db.ts` | `db.ts` | **no** |
| `commercialJobChains` | `0115_contractor_owner_operator_operations` | `contractorOperationsRouter.ts` | `commercialOfficeRouter.ts`, `contractorOperationsRouter.ts` | **no** |
| `jobCrewAssignments` | `0115_contractor_owner_operator_operations` | `contractorOperationsRouter.ts` | **none** | **no** |

## Loads (11 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `loadProfiles` | `0003_rich_multiple_man` | `db.ts` | `db.ts`, `hosRouter.ts` | yes |
| `loads` | `0010_billing_records_chain` | **none** | `_core/assistantCommitService.ts`, `_core/calibrationEvidence.ts` +31 | yes |
| `communicationPackageDownloads` | `0076_offline_communication_package` | `commsRouter.ts` | `commsRouter.ts` | **no** |
| `loadSenseCalibrationModels` | `0109_loadsense_material_movement` | `integrationRouter.ts` | `integrationRouter.ts` | yes |
| `loadSenseGatewayBindings` | `0114_loadsense_gateway_binding` | `integrationRouter.ts` | `integrationRouter.ts` | yes |
| `loadSenseGatewayFrames` | `0109_loadsense_material_movement` | `integrationRouter.ts` | `integrationRouter.ts` | **no** |
| `loadSenseWeightSnapshots` | `0109_loadsense_material_movement` | `integrationRouter.ts` | `requirementRouter.ts` | **no** |
| `loadSenseAxleWeights` | `0109_loadsense_material_movement` | `integrationRouter.ts` | **none** | **no** |
| `loadSenseScaleReconciliations` | `0109_loadsense_material_movement` | **none** | **none** | **no** |
| `commercialLoadChainRefs` | `0117_commercial_chain_numbers` | `contractorOperationsRouter.ts` | `contractorOperationsRouter.ts` | **no** |
| `loadFacilityAssessments` | `0139_facility_directory` | `facilityDirectoryRouter.ts` | `_core/destinationAcceptance.ts`, `_core/dispatchReadiness.ts` +1 | **no** |

## Maintenance (1 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `maintenanceDefects` | `0003_rich_multiple_man` | `_core/assistantCommitService.ts`, `_core/enforcementCommit.ts` +3 | `_core/attachmentAuthorizers.ts`, `_core/dbTypes.ts` +7 | yes |

## Manifests / custody (7 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `manifests` | `0004_lazy_colonel_america` | `db.ts`, `manifestCustodyRouter.ts` | `_core/evidenceSeal.ts`, `_core/fieldTicket.ts` +7 | yes |
| `manifestPartySnapshots` | `0129_manifest_chain_of_custody` | `manifestCustodyRouter.ts` | `manifestCustodyRouter.ts` | yes |
| `manifestCustodyEvents` | `0129_manifest_chain_of_custody` | `manifestCustodyRouter.ts` | `manifestCustodyRouter.ts` | **no** |
| `manifestAmendments` | `0129_manifest_chain_of_custody` | `manifestCustodyRouter.ts` | `manifestCustodyRouter.ts` | **no** |
| `manifestEvidenceLinks` | `0129_manifest_chain_of_custody` | `manifestCustodyRouter.ts` | `manifestCustodyRouter.ts` | **no** |
| `manifestEvidenceProfiles` | `0129_manifest_chain_of_custody` | `manifestCustodyRouter.ts` | `manifestCustodyRouter.ts` | **no** |
| `manifestReconciliationOverrides` | `0162_manifest_reconciliation_override` | `manifestCustodyRouter.ts` | `manifestCustodyRouter.ts` | yes |

## Mapping / routing (17 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `routeContexts` | `0002_orange_rockslide` | `db.ts` | `db.ts` | yes |
| `routeDecisions` | `0007_brainy_black_tarantula` | `db.ts` | `_core/recordsAuthorization.ts`, `db.ts` +1 | yes |
| `roadSegments` | `0012_road_graph_ingestion` | **none** | `geoRouter.ts` | yes |
| `segmentAttributes` | `0012_road_graph_ingestion` | **none** | **none** | **no** |
| `bridges` | `0012_road_graph_ingestion` | **none** | `_core/legalLand.ts`, `_core/osmImport.ts` +2 | yes |
| `routeEvidenceEntries` | `0012_road_graph_ingestion` | `spatialRouter.ts` | `spatialRouter.ts` | yes |
| `changeOrders` | `0053_commercial_projects` | `portalRouter.ts`, `projectRouter.ts` | `portalRouter.ts`, `projectRouter.ts` | **no** |
| `roadRestrictions` | `0058_spatial_foundation` | `spatialRouter.ts` | `spatialRouter.ts` | **no** |
| `routeRequests` | `0058_spatial_foundation` | `spatialRouter.ts` | **none** | yes |
| `accessRoadSegments` | `0070_ats_grid_and_access_roads` | `geoRouter.ts` | `geoRouter.ts`, `routeCommunicationGeography.ts` +1 | yes |
| `geoImportRuns` | `0070_ats_grid_and_access_roads` | `geoRouter.ts` | `geoRouter.ts` | yes |
| `routeApprovals` | `0072_structures_and_route_staleness` | `spatialRouter.ts` | `readinessComposer.ts`, `spatialRouter.ts` | yes |
| `roadGraphBuilds` | `0073_road_graph` | `geoRouter.ts` | `geoRouter.ts`, `spatialRouter.ts` | yes |
| `roadGraphNodes` | `0073_road_graph` | `geoRouter.ts` | `geoRouter.ts`, `routeCommunicationGeography.ts` | yes |
| `roadGraphEdges` | `0073_road_graph` | `geoRouter.ts` | `geoRouter.ts`, `readinessComposer.ts` +2 | yes |
| `roadRadioAssignments` | `0074_communications` | `commsRouter.ts` | `commsRouter.ts`, `geoRouter.ts` +2 | **no** |
| `roadAdvisories` | `0081_feed_runs_and_road_advisories` | **none** | **none** | **no** |

## Offline / sync (4 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `syncPackages` | `0019_records_evidence_vault` | `deviceRouter.ts`, `recordsService.ts` | `deviceRouter.ts`, `recordsService.ts` +1 | yes |
| `syncPackageItems` | `0019_records_evidence_vault` | `deviceRouter.ts`, `recordsService.ts` | **none** | yes |
| `syncReceipts` | `0019_records_evidence_vault` | `deviceRouter.ts` | **none** | yes |
| `syncConflicts` | `0035_secure_field_runtime` | `deviceRouter.ts` | `_core/exceptionCentre.ts`, `deviceRouter.ts` +1 | yes |

## Organizations (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `organizations` | `0086_organizations_and_memberships` | `commercialOfficeRouter.ts` | `_core/actingScope.ts`, `_core/contextAdmission.ts` +5 | yes |
| `organizationMemberships` | `0086_organizations_and_memberships` | **none** | `_core/actingScope.ts`, `db.ts` | yes |
| `organizationRelationships` | `0115_contractor_owner_operator_operations` | `contractorOperationsRouter.ts` | `contractorOperationsRouter.ts` | yes |
| `organizationWorkers` | `0115_contractor_owner_operator_operations` | `contractorOperationsRouter.ts` | `contractorOperationsRouter.ts` | **no** |
| `organizationCommercialRoles` | `0133_commercial_office_configuration` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | **no** |
| `organizationRecordLinks` | `0134_organization_record_links` | `commercialOfficeRouter.ts` | `commercialOfficeRouter.ts` | **no** |

## Other (71 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `checklistItems` | `0001_parallel_bastion` | **none** | **none** | **no** |
| `operators` | `0003_rich_multiple_man` | `db.ts`, `workforceRouter.ts` | `_core/dispatchLifecycle.ts`, `_core/dispatchMatching.ts` +19 | yes |
| `facilities` | `0003_rich_multiple_man` | `commercialOfficeRouter.ts`, `db.ts` +1 | `_core/arcgisImport.ts`, `_core/assistantCommitService.ts` +20 | yes |
| `deliveries` | `0003_rich_multiple_man` | `db.ts` | `_core/recordsAuthorization.ts`, `_core/workflowRuntime.ts` +5 | yes |
| `locationIdentities` | `0004_lazy_colonel_america` | `db.ts`, `geoRouter.ts` +1 | `db.ts`, `geoRouter.ts` +1 | yes |
| `trips` | `0008_trip_operations` | `db.ts` | `_core/billing.ts`, `_core/capitalAssets.ts` +21 | yes |
| `tripStops` | `0008_trip_operations` | `_core/assistantCommitService.ts`, `db.ts` | `_core/aiProposal.ts`, `_core/assistantCommitAdapters.ts` +7 | yes |
| `operatingZones` | `0008_trip_operations` | `db.ts` | `_core/recordsAuthorization.ts`, `db.ts` +1 | yes |
| `tripBreadcrumbs` | `0009_gps_zone_events` | `db.ts` | `_core/geofence.ts`, `db.ts` | yes |
| `zoneEvents` | `0009_gps_zone_events` | `db.ts` | `_core/recordsAuthorization.ts`, `_core/tripGps.ts` +2 | yes |
| `recordAmendments` | `0010_billing_records_chain` | **none** | **none** | **no** |
| `regulatoryThresholds` | `0011_taxonomy_billing_snapshots` | **none** | **none** | **no** |
| `specialtyPools` | `0013_dispatch_operations` | **none** | `_core/dispatchMatching.ts` | yes |
| `operatorCapabilities` | `0013_dispatch_operations` | **none** | **none** | **no** |
| `onCallRotations` | `0013_dispatch_operations` | **none** | **none** | **no** |
| `formDefinitions` | `0014_assistant_proposals` | **none** | **none** | **no** |
| `proposalFields` | `0014_assistant_proposals` | `db.ts` | `_core/assistantCommitService.ts`, `_core/siteBaseline.ts` +1 | yes |
| `disputeCases` | `0018_billing_adjustments` | `commercialRouter.ts`, `invoicingRouter.ts` | `invoicingRouter.ts`, `portalRouter.ts` | yes |
| `calloutRecords` | `0018_billing_adjustments` | **none** | **none** | **no** |
| `retentionPolicies` | `0019_records_evidence_vault` | **none** | `commercialOfficeRouter.ts` | yes |
| `recordRetentionState` | `0019_records_evidence_vault` | `recordsService.ts` | `recordsService.ts` | **no** |
| `legalHolds` | `0019_records_evidence_vault` | `recordsService.ts` | `recordsService.ts` | yes |
| `legalHoldRecords` | `0019_records_evidence_vault` | `recordsService.ts` | `recordsService.ts` | **no** |
| `authorizationDecisions` | `0020_domain_role_assignments` | `_core/assistantCommitService.ts`, `db.ts` | **none** | yes |
| `financialEntities` | `0022_payroll_finance_tax` | `payrollService.ts` | `_core/assistantCommitService.ts`, `_core/entityScope.ts` +3 | yes |
| `expenseCategories` | `0022_payroll_finance_tax` | **none** | **none** | **no** |
| `expenseRecords` | `0022_payroll_finance_tax` | `_core/assistantCommitService.ts`, `payrollService.ts` | `gstRouter.ts`, `payrollService.ts` +1 | yes |
| `expenseAllocations` | `0022_payroll_finance_tax` | `payrollService.ts` | **none** | yes |
| `merchantMemory` | `0029_fingerprints_merchant_memory` | `merchantMemoryService.ts` | `_core/documentExtraction.ts`, `merchantMemoryService.ts` | yes |
| `writtenProgramVersions` | `0036_compliance_master_registry` | `complianceRouter.ts` | `auditRouter.ts`, `complianceRouter.ts` | yes |
| `companyPackActivations` | `0037_requirement_engine_packs_calibration` | `requirementRouter.ts` | `requirementRouter.ts` | **no** |
| `operatorEquipmentAuthorizations` | `0037_requirement_engine_packs_calibration` | `requirementRouter.ts` | **none** | yes |
| `jurisdictionDistanceRecords` | `0040_ifta` | `iftaRouter.ts` | `iftaRouter.ts`, `periodCloseService.ts` | **no** |
| `collectionEvents` | `0045_bank_and_receivables` | `cashRouter.ts` | **none** | yes |
| `writeOffRequests` | `0045_bank_and_receivables` | `cashRouter.ts` | `cashRouter.ts` | yes |
| `signatoryAuthorities` | `0048_site_signoff_chain` | `closeoutRouter.ts` | `closeoutRouter.ts`, `portalRouter.ts` | **no** |
| `delayEvents` | `0048_site_signoff_chain` | `closeoutRouter.ts` | `_core/tripBillingProjection.ts` | **no** |
| `clientAdjustments` | `0049_portal_hardening_adjustments` | `closeoutRouter.ts`, `portalRouter.ts` | `auditRouter.ts`, `closeoutRouter.ts` +1 | yes |
| `weatherObservations` | `0049_portal_hardening_adjustments` | `closeoutRouter.ts` | `portalRouter.ts` | **no** |
| `quotes` | `0053_commercial_projects` | `portalRouter.ts`, `projectRouter.ts` | `_core/commercialProjects.ts`, `_core/insuranceRisk.ts` +5 | yes |
| `quoteLines` | `0053_commercial_projects` | `projectRouter.ts` | `portalRouter.ts`, `projectRouter.ts` | **no** |
| `rfis` | `0053_commercial_projects` | `portalRouter.ts`, `projectRouter.ts` | `portalRouter.ts`, `projectRouter.ts` | yes |
| `budgetLines` | `0053_commercial_projects` | `projectRouter.ts` | **none** | **no** |
| `inboundEvents` | `0054_integration_gateway` | `integrationRouter.ts` | `integrationRouter.ts`, `spatialRouter.ts` | **no** |
| `webhookSubscriptions` | `0054_integration_gateway` | `integrationRouter.ts` | `integrationRouter.ts`, `webhookDispatchService.ts` | yes |
| `webhookDeliveries` | `0054_integration_gateway` | `webhookDispatchService.ts` | `integrationRouter.ts`, `webhookDispatchService.ts` | yes |
| `telemetrySnapshots` | `0055_telematics_video_safety` | `integrationRouter.ts` | `telematicsRouter.ts` | **no** |
| `videoAccessLog` | `0055_telematics_video_safety` | `telematicsRouter.ts` | `telematicsRouter.ts` | yes |
| `competencySignoffs` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `auditRouter.ts`, `workforceRouter.ts` | **no** |
| `probationReviews` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `workforceRouter.ts` | **no** |
| `pricingDecisions` | `0065_commercial_setup` | `_core/linePricing.ts`, `commercialSetupRouter.ts` | `commercialSetupRouter.ts`, `invoicingRouter.ts` | **no** |
| `atsLegalSubdivisions` | `0070_ats_grid_and_access_roads` | `geoRouter.ts` | `facilityDirectoryRouter.ts`, `geoRouter.ts` | yes |
| `siteAccessPoints` | `0071_site_access_points` | `geoRouter.ts` | `geoRouter.ts` | **no** |
| `siteAccessConfirmations` | `0071_site_access_points` | `geoRouter.ts` | `geoRouter.ts` | **no** |
| `structures` | `0072_structures_and_route_staleness` | `spatialRouter.ts` | `_core/commRoute.ts`, `_core/complianceSecretary.ts` +3 | yes |
| `leaveRequests` | `0090_leave_requests` | `timeOffRouter.ts` | `calendarRouter.ts`, `crewRouter.ts` +3 | yes |
| `messageChannels` | `0096_message_board` | `messageBoardRouter.ts` | `messageBoardRouter.ts` | yes |
| `messageReceipts` | `0096_message_board` | `messageBoardRouter.ts` | `messageBoardRouter.ts` | yes |
| `messageRevisions` | `0097_message_revisions` | `messageBoardRouter.ts` | `messageBoardRouter.ts` | yes |
| `messageAttachments` | `0099_message_attachments` | `messageBoardRouter.ts` | `messageBoardRouter.ts` | yes |
| `agentRuns` | `0100_agent_runs` | `agentRouter.ts` | `agentRouter.ts` | yes |
| `agentSteps` | `0100_agent_runs` | `agentRouter.ts` | `agentRouter.ts` | **no** |
| `agentActions` | `0100_agent_runs` | `agentRouter.ts` | `agentRouter.ts` | yes |
| `agentApprovals` | `0100_agent_runs` | `agentRouter.ts` | `agentRouter.ts` | **no** |
| `retrievalProbes` | `0102_retrieval_probes` | `assistantAskRouter.ts` | `assistantAskRouter.ts` | yes |
| `materialDensityProfiles` | `0109_loadsense_material_movement` | **none** | **none** | **no** |
| `privacyBreachAssessments` | `0131_security_incidents_privacy_breaches` | `securityIncidentsRouter.ts` | `securityIncidentsRouter.ts`, `surfacesService.ts` | **no** |
| `sheetSerialSequences` | `0125_academy_sheet_serial_registry` | **none** | `_core/sheetSerialAllocator.ts` | **no** |
| `sheetSerialAllocations` | `0125_academy_sheet_serial_registry` | **none** | `_core/sheetSerialAllocator.ts` | **no** |
| `investigationProposals` | `0156_restricted_records_vault` | `restrictedVaultRouter.ts` | `restrictedVaultRouter.ts` | yes |
| `monitoringNotices` | `0160_monitoring_notices` | **none** | **none** | **no** |

## Payroll (14 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `payableAdjustments` | `0018_billing_adjustments` | **none** | **none** | **no** |
| `payGroups` | `0022_payroll_finance_tax` | **none** | **none** | **no** |
| `employeePayrollProfiles` | `0022_payroll_finance_tax` | `payrollService.ts` | `_core/entityScope.ts`, `payrollRouter.ts` +1 | yes |
| `payPeriods` | `0022_payroll_finance_tax` | `payrollService.ts` | `_core/entityScope.ts`, `payrollService.ts` | **no** |
| `payrollTimeEntries` | `0022_payroll_finance_tax` | `payrollService.ts` | `payrollService.ts` | **no** |
| `payrollTimeReconciliations` | `0022_payroll_finance_tax` | `payrollService.ts` | **none** | **no** |
| `payRuns` | `0022_payroll_finance_tax` | `payrollService.ts` | `_core/entityScope.ts`, `payrollService.ts` | **no** |
| `payRunLines` | `0022_payroll_finance_tax` | `payrollService.ts` | **none** | yes |
| `payrollAdjustments` | `0022_payroll_finance_tax` | `closeoutRouter.ts`, `payrollService.ts` | `_core/entityScope.ts` | yes |
| `payrollDisputes` | `0022_payroll_finance_tax` | `payrollService.ts` | `_core/entityScope.ts`, `payrollService.ts` | **no** |
| `customerPayments` | `0045_bank_and_receivables` | `cashRouter.ts` | `cashRouter.ts`, `commercialOfficeRouter.ts` +1 | yes |
| `paymentAllocations` | `0045_bank_and_receivables` | `cashRouter.ts` | `cashRouter.ts`, `commercialOfficeRouter.ts` +4 | yes |
| `contractorPayables` | `0116_contractor_commercial_payables` | `contractorOperationsRouter.ts` | `auditRouter.ts`, `commercialOfficeRouter.ts` +1 | yes |
| `contractorPayableEvents` | `0116_contractor_commercial_payables` | `contractorOperationsRouter.ts` | **none** | **no** |

## Platform (3 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `trackingSequences` | `0010_billing_records_chain` | **none** | `_core/trackingNumbers.ts`, `closeoutRouter.ts` +1 | yes |
| `trackingReferences` | `0010_billing_records_chain` | **none** | **none** | yes |
| `coreRecordOwnership` | `0113_core_record_ownership` | `_core/coreRecordOwnership.ts`, `db.ts` | `_core/coreRecordOwnership.ts`, `contractorOperationsRouter.ts` +4 | yes |

## Portals (1 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `portalSubmissions` | `0047_commercial_core_portals` | `commercialRouter.ts`, `portalRouter.ts` | `commercialRouter.ts`, `portalRouter.ts` | **no** |

## Portals / external (7 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `externalDataSources` | `0024_external_data_sources` | `db.ts`, `geoRouter.ts` | `db.ts`, `geoRouter.ts` +1 | yes |
| `externalDatasetImports` | `0024_external_data_sources` | **none** | **none** | **no** |
| `externalFeedFetches` | `0024_external_data_sources` | **none** | **none** | **no** |
| `externalIdentities` | `0047_commercial_core_portals` | `commercialRouter.ts`, `db.ts` +1 | `closeoutRouter.ts`, `commercialRouter.ts` +3 | yes |
| `externalAccessLog` | `0049_portal_hardening_adjustments` | `portalRouter.ts` | **none** | yes |
| `externalAlertPreferences` | `0050_customer_alert_preferences` | `portalRouter.ts` | `customerAlertService.ts`, `portalRouter.ts` | **no** |
| `externalFeedRuns` | `0081_feed_runs_and_road_advisories` | **none** | `_core/feedHttp.ts` | yes |

## Projects (1 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `projectBudgets` | `0053_commercial_projects` | `projectRouter.ts` | `projectRouter.ts` | **no** |

## Restricted vault (2 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `restrictedAccessGrants` | `0156_restricted_records_vault` | `restrictedVaultRouter.ts` | `restrictedVaultRouter.ts` | **no** |
| `restrictedAccessEvents` | `0156_restricted_records_vault` | `restrictedVaultRouter.ts` | `restrictedVaultRouter.ts` | yes |

## Shop (8 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `workOrders` | `0008_trip_operations` | `_core/enforcementCommit.ts`, `db.ts` +1 | `_core/recordsAuthorization.ts`, `assetRouter.ts` +7 | yes |
| `workOrderReleases` | `0019_records_evidence_vault` | `recordsService.ts` | `auditRouter.ts`, `enforcementRouter.ts` +3 | yes |
| `tires` | `0051_fleet_shop` | `shopRouter.ts` | `_core/capitalAssets.ts`, `_core/enforcement.ts` +6 | yes |
| `tireInstallations` | `0051_fleet_shop` | `shopRouter.ts` | `assetRouter.ts`, `auditRouter.ts` +1 | **no** |
| `tireMeasurements` | `0051_fleet_shop` | `shopRouter.ts` | `shopRouter.ts` | **no** |
| `serializedTools` | `0051_fleet_shop` | `shopRouter.ts` | `shopRouter.ts`, `workforceRouter.ts` | **no** |
| `toolCheckouts` | `0051_fleet_shop` | `shopRouter.ts` | `shopRouter.ts`, `workforceRouter.ts` | **no** |
| `recallNotices` | `0051_fleet_shop` | `shopRouter.ts` | `shopRouter.ts` | **no** |

## Signatures (2 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `signatureAudits` | `0003_rich_multiple_man` | `db.ts` | **none** | yes |
| `commercialApprovalSignatures` | `0136_commercial_approval_ledger` | `_core/commercialApprovalService.ts` | `_core/commercialApprovalService.ts`, `auditRouter.ts` +1 | **no** |

## Tax (7 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `taxonomyEntries` | `0011_taxonomy_billing_snapshots` | **none** | `_core/taxonomy.ts` | **no** |
| `taxRegistrations` | `0022_payroll_finance_tax` | **none** | `gstRouter.ts`, `payrollService.ts` | yes |
| `taxRuleSources` | `0022_payroll_finance_tax` | `payrollService.ts` | `payrollService.ts` | **no** |
| `taxRules` | `0022_payroll_finance_tax` | `payrollService.ts` | `payrollService.ts` | yes |
| `personalTaxDocuments` | `0022_payroll_finance_tax` | `payrollService.ts` | `payrollService.ts` | **no** |
| `gstReturns` | `0044_gst_hst` | `gstRouter.ts` | `auditRouter.ts`, `gstRouter.ts` +1 | yes |
| `gstAdjustments` | `0044_gst_hst` | `gstRouter.ts` | `gstRouter.ts` | **no** |

## Telematics (1 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `faultCodes` | `0055_telematics_video_safety` | `integrationRouter.ts`, `telematicsRouter.ts` | `auditRouter.ts`, `integrationRouter.ts` +2 | **no** |

## Training (27 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `insuranceCertificates` | `0038_insurance_risk` | `insuranceRouter.ts` | `insuranceRouter.ts` | **no** |
| `trainingRecords` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `auditRouter.ts`, `workforceRouter.ts` | **no** |
| `qualificationTypes` | `0092_worker_qualifications` | **none** | **none** | **no** |
| `workerQualifications` | `0092_worker_qualifications` | **none** | `_core/qualificationValidity.ts`, `calendarRouter.ts` +3 | yes |
| `academyCourses` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academyCourseVersions` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academyModules` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academyContentBlocks` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academyAssignments` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academyModuleCompletions` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyQuestions` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyAssessments` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyAssessmentAttempts` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academyAssessmentItems` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyPracticalEvaluations` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyQualifications` | `0107_training_academy` | `trainingAcademyRouter.ts` | `readinessComposer.ts`, `trainingAcademyRouter.ts` | **no** |
| `academyCertificates` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academySourceRecords` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyRegulatoryProfiles` | `0108_training_academy_hardening` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyCertificateSignatures` | `0108_training_academy_hardening` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyStatementsOfExperience` | `0108_training_academy_hardening` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyDirectSupervisionRecords` | `0107_training_academy` | `trainingAcademyRouter.ts` | `readinessComposer.ts`, `trainingAcademyRouter.ts` | **no** |
| `academyRequirements` | `0107_training_academy` | `trainingAcademyRouter.ts` | `readinessComposer.ts`, `trainingAcademyRouter.ts` | **no** |
| `academyRequirementBindings` | `0107_training_academy` | `trainingAcademyRouter.ts` | `readinessComposer.ts` | **no** |
| `academyAuditEvents` | `0107_training_academy` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | **no** |
| `academyAssessmentSheets` | `0125_academy_sheet_serial_registry` | `trainingAcademyRouter.ts` | `trainingAcademyRouter.ts` | yes |
| `academyInspectorRequests` | `0122_academy_inspector_requests` | `trainingAcademyRouter.ts` | `surfacesService.ts`, `trainingAcademyRouter.ts` | **no** |

## Widgets (2 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `widgetLayouts` | `0127_widget_dashboards` | `widgetLayouts.ts` | `routers.ts`, `widgetLayouts.ts` | yes |
| `widgetLayoutItems` | `0127_widget_dashboards` | `widgetLayouts.ts` | `widgetLayouts.ts` | yes |

## Workflow (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `domainEventOutbox` | `0015_workflow_orchestration` | `_core/enforcementOutbox.ts` | `_core/enforcementOutbox.ts`, `_core/eventEmitter.ts` +2 | yes |
| `workflowRules` | `0015_workflow_orchestration` | **none** | `_core/workflowRuntime.ts` | yes |
| `operationalTasks` | `0015_workflow_orchestration` | **none** | `_core/workflowRuntime.ts`, `surfacesService.ts` | yes |
| `workflowInstances` | `0015_workflow_orchestration` | **none** | **none** | yes |
| `workflowTransitions` | `0015_workflow_orchestration` | **none** | **none** | yes |
| `workflowNotifications` | `0015_workflow_orchestration` | `_core/enforcementOutbox.ts`, `customerAlertService.ts` +1 | `_core/enforcementOutbox.ts`, `_core/escalation.ts` +4 | yes |

## Workforce (6 tables)

| Table | Migration | Principal writer | Principal readers | Tests |
|---|---|---|---|---|
| `applicants` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `_core/driverTraining.ts`, `workforceRouter.ts` | yes |
| `applicantScreenings` | `0056_workforce_lifecycle` | `workforceRouter.ts` | `workforceRouter.ts` | **no** |
| `shiftPosts` | `0091_shift_posts` | `openShiftsRouter.ts` | `calendarRouter.ts`, `openShiftsRouter.ts` +1 | yes |
| `shiftInterests` | `0091_shift_posts` | `openShiftsRouter.ts` | `calendarRouter.ts`, `openShiftsRouter.ts` | yes |
| `crews` | `0093_crews` | `crewRouter.ts` | `_core/recordsAuthorization.ts`, `calendarRouter.ts` +4 | yes |
| `crewMembers` | `0093_crews` | `crewRouter.ts` | `calendarRouter.ts`, `crewRouter.ts` +2 | yes |


---

# Tables flagged by usage

Nothing here was deleted or changed. These are observations.

## Orphaned — no production reference at all (38)

No production file writes or reads these. Several are the residue of superseded designs; two (`workflowInstances`, `workflowTransitions`) were replaced by the live workflow runtime, which uses `workflowRules`, `operationalTasks`, `workflowNotifications` and `domainEventOutbox` instead (`server/_core/workflowRuntime.ts`).

| Table | Introduced by | Referenced by tests |
|---|---|---|
| `billingAdjustments` | `0018_billing_adjustments` | no |
| `calloutRecords` | `0018_billing_adjustments` | no |
| `checklistItems` | `0001_parallel_bastion` | no |
| `compliancePacks` | `0037_requirement_engine_packs_calibration` | no |
| `dailyLogs` | `0010_billing_records_chain` | yes |
| `datasetConfirmations` | `0012_road_graph_ingestion` | no |
| `dispatchTemplates` | `0013_dispatch_operations` | no |
| `disposalBatches` | `0010_billing_records_chain` | no |
| `expenseCategories` | `0022_payroll_finance_tax` | no |
| `externalDatasetImports` | `0024_external_data_sources` | no |
| `externalFeedFetches` | `0024_external_data_sources` | no |
| `formDefinitions` | `0014_assistant_proposals` | no |
| `fuelAccounts` | `0033_fuel_energy_ledger` | yes |
| `fundingProgramSources` | `0026_funding_intelligence` | no |
| `importBatches` | `0012_road_graph_ingestion` | no |
| `incidentActions` | `0019_records_evidence_vault` | no |
| `incidentPeople` | `0019_records_evidence_vault` | no |
| `knowledgeVersions` | `0118_knowledge_source_registry` | yes |
| `loadSenseScaleReconciliations` | `0109_loadsense_material_movement` | no |
| `materialDensityProfiles` | `0109_loadsense_material_movement` | no |
| `monitoringNotices` | `0160_monitoring_notices` | no |
| `onCallRotations` | `0013_dispatch_operations` | no |
| `operatorAvailability` | `0013_dispatch_operations` | no |
| `operatorCapabilities` | `0013_dispatch_operations` | no |
| `payGroups` | `0022_payroll_finance_tax` | no |
| `payableAdjustments` | `0018_billing_adjustments` | no |
| `payrollEarningEvidence` | `0022_payroll_finance_tax` | no |
| `qualificationTypes` | `0092_worker_qualifications` | no |
| `recordAmendments` | `0010_billing_records_chain` | no |
| `regulatoryThresholds` | `0011_taxonomy_billing_snapshots` | no |
| `remoteWorkEvidence` | `0032_integrity_closure` | yes |
| `roadAdvisories` | `0081_feed_runs_and_road_advisories` | no |
| `segmentAttributes` | `0012_road_graph_ingestion` | no |
| `subcontractedLines` | `0018_billing_adjustments` | no |
| `subcontractors` | `0018_billing_adjustments` | no |
| `trackingReferences` | `0010_billing_records_chain` | yes |
| `workflowInstances` | `0015_workflow_orchestration` | yes |
| `workflowTransitions` | `0015_workflow_orchestration` | yes |

## Write-only — written but never read in production (29)

Data accumulates and nothing consumes it. This is the category that hides a broken feature: a value can be recorded faithfully and never influence any decision.

| Table | Introduced by |
|---|---|
| `auditPackageAccess` | `0057_audit_packages` |
| `authorizationDecisions` | `0020_domain_role_assignments` |
| `budgetLines` | `0053_commercial_projects` |
| `calibrationSweepFindings` | `0163_calibration_sweep` |
| `collectionEvents` | `0045_bank_and_receivables` |
| `complianceConsents` | `0036_compliance_master_registry` |
| `contractorBusinessProfiles` | `0115_contractor_owner_operator_operations` |
| `contractorPayableEvents` | `0116_contractor_commercial_payables` |
| `contractorSettlementLines` | `0022_payroll_finance_tax` |
| `customerRecoveryProposals` | `0034_roadside_purchasing_ap` |
| `deviceSyncNonces` | `0110_device_cryptographic_binding` |
| `dispatchInvitations` | `0013_dispatch_operations` |
| `enforcementDocumentExtractions` | `0082_enforcement_persistence` |
| `evidenceAccessEvents` | `0019_records_evidence_vault` |
| `evidenceVersions` | `0019_records_evidence_vault` |
| `expenseAllocations` | `0022_payroll_finance_tax` |
| `externalAccessLog` | `0049_portal_hardening_adjustments` |
| `jobCrewAssignments` | `0115_contractor_owner_operator_operations` |
| `knowledgeSources` | `0118_knowledge_source_registry` |
| `loadSenseAxleWeights` | `0109_loadsense_material_movement` |
| `nearMissReports` | `0019_records_evidence_vault` |
| `operatorEquipmentAuthorizations` | `0037_requirement_engine_packs_calibration` |
| `payRunLines` | `0022_payroll_finance_tax` |
| `payrollTimeReconciliations` | `0022_payroll_finance_tax` |
| `roleBootstrapEvents` | `0021_active_role_uniqueness` |
| `routeRequests` | `0058_spatial_foundation` |
| `signatureAudits` | `0003_rich_multiple_man` |
| `syncPackageItems` | `0019_records_evidence_vault` |
| `syncReceipts` | `0019_records_evidence_vault` |

## Read-only — read but never written in production (23)

These are read by production code but nothing in production ever populates them, so in a fresh deployment they are permanently empty unless seeded by a migration or loaded out of band.

| Table | Introduced by |
|---|---|
| `billingAuthorityBands` | `0018_billing_adjustments` |
| `bridges` | `0012_road_graph_ingestion` |
| `customerBillingConfigs` | `0011_taxonomy_billing_snapshots` |
| `documentExtractions` | `0027_document_extraction_questions` |
| `externalFeedRuns` | `0081_feed_runs_and_road_advisories` |
| `facilitySourceLicences` | `0139_facility_directory` |
| `fleetFuelCards` | `0033_fuel_energy_ledger` |
| `loads` | `0010_billing_records_chain` |
| `measurementDeviceAssignments` | `0037_requirement_engine_packs_calibration` |
| `operationalTasks` | `0015_workflow_orchestration` |
| `organizationMemberships` | `0086_organizations_and_memberships` |
| `programAcknowledgements` | `0036_compliance_master_registry` |
| `retentionPolicies` | `0019_records_evidence_vault` |
| `roadSegments` | `0012_road_graph_ingestion` |
| `sheetSerialAllocations` | `0125_academy_sheet_serial_registry` |
| `sheetSerialSequences` | `0125_academy_sheet_serial_registry` |
| `specialtyPools` | `0013_dispatch_operations` |
| `spendingLimits` | `0034_roadside_purchasing_ap` |
| `taxRegistrations` | `0022_payroll_finance_tax` |
| `taxonomyEntries` | `0011_taxonomy_billing_snapshots` |
| `trackingSequences` | `0010_billing_records_chain` |
| `workerQualifications` | `0092_worker_qualifications` |
| `workflowRules` | `0015_workflow_orchestration` |

## Duplicated / parallel

- `workflowInstances` + `workflowTransitions` (0015) versus the live `workflowRules` / `operationalTasks` / `workflowNotifications` path.
- `subcontractors` + `subcontractedLines` (0018) exist as commercial records; no production path reads or writes them.
- Two migrations share the prefix `0157`, which the repository's own roadmap already records as an open defect.

## Test-only

No table is referenced *only* by tests and never by the schema — every table is declared in `drizzle/schema.ts`. The orphan list above is the closest equivalent: 9 of those 38 are named in tests but in no production file.

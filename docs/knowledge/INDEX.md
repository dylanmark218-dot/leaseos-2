# LeaseOS knowledge index

Every document in the Claude project, catalogued against the code that implements it.

**`source/` holds 15 documents — the only ones that were mounted as files.** The remaining ~175 are
reachable by search inside the Claude project and exist nowhere on disk. They are listed here by
name so that anything working from this repository knows what exists, what it covers, and that its
body has to be fetched rather than assumed.

Status column:
`BUILT` implemented and tested · `PARTIAL` some of it exists · `SPEC` specified, no code ·
`HIST` historical (superseded by the repo itself)

---

## In `source/` — full text present

| Document | Status | Where it lives in code |
|---|---|---|
| `LEASEOS_CLIENT_ARCHITECTURE_AND_BUILD_SEQUENCE.md` | BUILT | `portalComposition`, `entityScope`, `actingScope` |
| `LEASEOS_RESTRICTED_RECORDS_VAULT.md` | BUILT | `restrictedVault`, `restrictedAccessGrants/Events` |
| `LEASEOS_DRIVER_MEDICAL_QUALIFICATION_VAULT.md` | **SPEC** | qualifications exist; nothing medical |
| `LeaseOS_Commercial_Office_Administration_Hub` | PARTIAL | `commercialOfficeRouter`, `commercialApprovals` — see P6.7 |
| `LeaseOS_Contact_..._Emergency_Directory_Build_Plan.pdf` | **SPEC** | `crews`/`crewMembers` only; no contacts, no muster points |
| `LeaseOS_Canada_HOS_Compliance_Logbook.pdf` + `_v2` | PARTIAL | `hos`, `hosRuleSeeds`, `hosClockPresentation` |
| `LeaseOS_Live_Assist_Unified_AI_Build_Plan_v1_0/v2_0.pdf` | PARTIAL | `assistantExtraction` → `aiProposal` → `assistantCommitService` |
| `LeaseOS_Specialized_Freight_Compliance_Build_Plan_v1.pdf` | **SPEC** | no permit table; TDG reference set absent |
| `Mapping_and_routing_engine_`, `_2`, `_truck_routing_3` | BUILT | `osmImport`/`osmTopology`/`osmLoad`, `roadGraph`, `routeEvaluation` |
| `Leaseos_contact_list` | **SPEC** | no contacts table |
| `_work_order_que_for_project_projection_` | PARTIAL | `projections`, `workflowEngine` |

Each `.pdf` has a `.txt` beside it so the specifications are greppable from the repository.

---

## Not on disk — body available only in the Claude project

### Policy portfolio (Books)

| Book | Subject | Status |
|---|---|---|
| 02 | Commercial transportation / road & enforcement | PARTIAL |
| 03 | Fleet maintenance, CVIP, asset integrity | PARTIAL — `fleetShop`, `mechanicRelease` |
| 04 | Heavy equipment & powered mobile equipment | SPEC |
| 05 | Oilfield & energy services | PARTIAL |
| 06 | Hydrovac, vacuum, fluid hauling, disposal | BUILT — 20 tables |
| 07 | Construction operations | SPEC |
| **08** | **Forestry & logging** | **SPEC — no code, absent from build register** |
| 09 | TDG, WHMIS, hazardous materials | PARTIAL — training only; no UN reference set |
| **10** | **Environmental protection, spill response, emergency mgmt** | **SPEC — zero tables** |
| 11 | Training, competency, certification | BUILT — `trainingAcademy` |
| 12 | Audit, records, compliance assurance, document control | BUILT — 21 tables |
| 14 | Occupational health & industrial hygiene | SPEC |
| 15 | Shop, tools, welding, mechanical work | PARTIAL — `fleetShop` |
| 16 | Employment, HR, workforce administration | BUILT — `workerLifecycle`, `payrollEngine` |
| 17 | Privacy, cybersecurity, AI, information governance | PARTIAL — `securityIncidents`, `cookies`, `oauth` |
| 18 | Contractor, subcontractor, vendor management | PARTIAL — `contractorOperations` |
| 19 | Quality management & operational excellence | SPEC |
| 20 | Financial, billing, anti-fraud controls | BUILT — 20 tables |
| 21 | Physical security, access, asset protection | SPEC |
| 22 | Client, contract, service-level management | PARTIAL — `contractTerms` |
| **23** | **Business continuity & disaster recovery** | **SPEC** |
| **24** | **Ethics, whistleblower, corporate conduct** | **SPEC** |
| **25** | **Landowner, community, Indigenous, stakeholder relations** | **SPEC** |
| **26** | **Journey management & remote travel** | **SPEC — trip-attached, worth prioritising** |
| **27** | **Camp, travel, workforce-lifestyle standards** | **SPEC** |
| 29 | Communications, message board, social media governance | PARTIAL — `messageBoard` |
| 30 | Insurance, claims, loss management | PARTIAL — 11 tables, `insuranceRisk` |
| **31** | **Wildlife, animal encounters, wildlife-vehicle safety** | **SPEC — trip-attached** |
| 42 | Sales, estimating, tendering, business development | SPEC |
| 44 | Asset lifecycle, capital planning, equipment replacement | PARTIAL — `capitalAssets` |
| 45 | Facilities, yards, shops, offices, property | PARTIAL — `facilitySeed` |
| 46 | Fuel, cardlock, bulk storage, energy | BUILT — `fuelLedger`, `bulkFuel` |
| 47 | Weather, environmental conditions, seasonal ops | SPEC |
| 48 | Fatigue, shift scheduling, workforce availability | PARTIAL — `openShifts`, `shiftReadiness` |
| 49 | Incident command, crisis management | PARTIAL — `incidentReport`, `escalation` |
| 50 | Critical field safety programs, every-shift meetings | PARTIAL |

Also: `LeaseOS_Master_Company_Policy_Portfolio_v1`, `LeaseOS_Policy_Engine`,
`LeaseOS_Policy___Standards_Engine___PSCM`, `Checkpoint_PSCM-01`, `controlled-policy_package`,
`LeaseOS_Compliance_Master_Register`, `Company_Core___Transportation___Industry___Equipment...`

### Mapping, routing, GPS — BUILT
`GPS_lsd_maps_for_coding_into_leaseos` · `Lsd_GPS_and_mapping_routing_build_guidelines_` ·
`Mapping_knowledge_` · `Mapping_build_knowledge_` · `GPS_routing_mapping_engine_` ·
`Heavy_truck_rule_engine_` · `Map-data_acquisition_service_itself_` · `NRN_OpenStreetMap___ISED...` ·
`Alberta_operator-document_ingestion_` · `LEASEOS_511_ALBERTA_LICENSE_ASSESSMENT.md` ·
`leaseos_511_alberta_license_gate.json` · `RoadUseProcedures.pdf`

### Radio & communications — BUILT (29 tables)
`Radio_frequency_` · `radio_communication` · `Radio_and_mapping`

### AI secretary & agents — PARTIAL
`Ai_secretary_and_agent_command_terminal_` · `Ai_secretary_and_agent_` · `Ai_secretary_agent` ·
`Ai_agent` · `Agent_loops` · `_AI_features` · `Ai_secretary_and_screen_sharing_` ·
`LeaseOS_Hybrid_Agent_Mesh` · `LeaseOS_AI_Secretary__Open-Source__Self-Hostable...` ·
`constrain_the_LeaseOS_AI_around_a_commercial-operations_knowledge_perimeter` ·
`Inbox__Ask__Assign__Watch__Approvals__Active_Work__Cases__Automations__Agent_Activity...`

### Remote Operations Rules (ROR) — PARTIAL
`actual_Remote_Operations_rules_specification_` · `ROR_actually_executes_inside_LeaseOS.` ·
`ROR-A_implementation-ready_` · `ROR-B___Vehicle_Identity__Driver_Handoff___Movement_Attribution` ·
`Ror_c` · `ROR-D___HOS_Bridge___Compliance_Decision_Engine` · `LeaseOS_Remote_Workforce_Mode_` ·
`actual_state_machine_and_event_reducer` · `SQL_migration___TypeScript_domain_package___reducers_and_tests`

### Portals, shells, tenancy — BUILT
`LEASEOS_PORTAL_ACCESS_ARCHITECTURE.md` · `Login_portals_and_shells` ·
`LeaseOS_Multi-Portal_Product_Architecture` · `Clients_and_vendors_portal` ·
`Clients_and_vendors_portal_for_billing_and_disposal_tickets` · `tenant_RBAC_foundation_first` ·
`implementable_LeaseOS_governance_architecture.`

### Billing & pricing — BUILT
`LEASEOS_BILLING_RECORDS_CHAIN.md` + `-1`/`-2`/`-3` · `Billing_and_pricing_with_ai_secretary_assistance_` ·
`Clients_billing_extra_hours_or_bonuses_` ·
`field_ticket__driver_day_log__Job_log_and_evidence_package...`

### HOS & logbooks — PARTIAL
`Log_book_Compliance_Cycle_and_engine_build_data_` · `Log_books_well_on-site_` ·
`Electronic_Logging_book_`

### Legal & commercial suite — SPEC (register only)
15 documents covering DPA, GPS monitoring notice, AI policy, AUP, e-signature policy, retention
schedule, SLA, pilot/beta agreement, contractor IP assignment & NDA, API terms, open-source
SBOM policy, subprocessor register, client portal terms, order form & pricing schedule, SOW
template, change order, PSA, security addendum, vulnerability disclosure, trademark & IP register,
website terms, cookie notice, accessibility statement, insurance schedule, corporate formation
checklist, regulatory change management, employee handbook, and
`Draft_34___Master_LeaseOS_Legal___Compliance_Manual`.

Repo holds only `docs/legal/LEGAL_DOCUMENT_REGISTER.md` — the register, not the documents.

### Layers with no counterpart in code — SPEC
`Scenario_Engine___What_happens_if___` · `LeaseOS_Language___Communication_Mediation_Layer` ·
`Emergency_Health___Worker_Welfare_Layer` · `LeaseOS_Operational_Graph` ·
`company-wide_Case_system` · `company_task_delegation_system_` ·
`Knowledge_panel_for_rebates_and_grants_` (partially — `fundingIntelligence`)

### Tax & finance reference
`Grok-tax_Brackets_And_Information_` · `Grok-taxes_And_Information_` — BUILT
(`taxRuleEngine`, `gstReturn`, `iftaEngine`, `capitalAssets`)

### Historical — superseded by the repository
`LEASEOS_MASTER_PROGRAMMING_MANIFEST_V7/V8.md` · `LEASEOS_BUILD_PLAN.md` + `-1`/`-2`/`-3` ·
`LEASEOS_BUILD_SPEC.md` + `-1`/`-2` · `LEASEOS_TAXONOMY_ROUTING.md` + `-1`/`-2` ·
`LEASEOS_B12_ROUTING_EVIDENCE.md` · `leaseos-prototype.html` + `-1`…`-4` ·
`leaseos-integrated-ops.diff` · `leaseos-v6-to-v7-sync-foundation.diff` ·
`v22_16-to-0088-worktree.diff` · `leaseos-transfer-checksums.txt` ·
`Leaseos_audit_and_work_check_sep_10_26` · `would_not_build_route-view_yet__UI03...` ·
`RBAC_seeds___0014_privacy...` · `0016_security_incidents__0017_ai_governance__0018_regulatory_sources` ·
`index.html` · `index.css` · `ThemeContext` · `Map` · `Home` · `LocationWorkspace` ·
`ComplianceEngine` · `OfflineVault` · `BillingSafetyWorkspace` · `Dispatcher_` ·
`Dispatch_page_information_` · `SKILL__2_/3_/4_.md` · `Pasted_content_13`–`18.txt`

### Context & background
`Competitors_and_company_goals` · `Benchmark_abd_expansions_` · `Open_source_resources_` ·
`Gemini_meta_data_terms_` · `Meta_terms_and_development_protocols_` · `Read_me_01` ·
`README.md` · `Todo_list` · `Building_on_operating_system_for_fleet_trucking_important_read_me` ·
`commercial_SaaS_platform_for_trucking_oilfield_construction_operations` ·
`Chat_gpt_*` knowledge-transfer notes (5 files) · `Gpt` · `1000005015.png`

---

## How to complete this export

The ~175 bodies cannot be copied from here — they are reachable only by search, which returns
fragments. Reconstructing a policy book from fragments would produce a document that reads like the
original and is not it, which is the one thing that must not happen to a regulatory specification.

To finish: download them from the Claude project and drop them in `/mnt/user-data/uploads/`. They
will be filed into `source/` and this index updated to match.

Priority if the set is large — the documents whose absence blocks work:

1. `LeaseOS_Specialized_Freight_Compliance_Build_Plan_v1.pdf` — already present; permits and TDG
2. Book 09 (TDG) and Book 10 (environmental / spill)
3. `LeaseOS_Compliance_Master_Register` and `LeaseOS_Policy___Standards_Engine___PSCM`
4. ROR-A through ROR-D
5. Books 26 and 31 — trip-attached and operational

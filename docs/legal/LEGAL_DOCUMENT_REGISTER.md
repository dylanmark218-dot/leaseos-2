# LeaseOS — Legal Document Register (v22.23)

`package.json` has declared **MIT** since the first commit; the `LICENSE` file that
declaration implies did not exist until this version. It now does, with the
copyright holder written as the project name — **the legal entity that holds the
copyright must replace that line before any public release.** That is an owner's
decision, not a build step.

Every other legal instrument LeaseOS needs was drafted in the project knowledge
base during the ChatGPT chats and is not yet a tracked, owned, dated document.
This register turns that pile into a checklist. Status meanings: DRAFT-PK = a
draft exists in project knowledge only; TRACKED = a reviewed version lives under
`docs/legal/`; SIGNED-OFF = counsel has approved it for use.

| # | Instrument | Where the draft lives (project knowledge) | Status | Owner | Needed before |
|---|---|---|---|---|---|
| L1 | Repository licence (MIT) + third-party notices / SBOM | `Open-Source_Software___SBOM_Policy…`, `…open-source_API_licence_register` | **TRACKED** (`LICENSE`); notices/SBOM DRAFT-PK | — | public release |
| L2 | Terms of Service / website terms / cookie notice / accessibility statement | `Professional_Services_Agreement__Website_Terms_of_Use__Cookie…`, `Accessibility_Policy___Statement…` | DRAFT-PK | — | public website |
| L3 | Client Portal Terms | `Client_Portal_Terms__commercial_Order_Form…` | DRAFT-PK | — | first customer portal login |
| L4 | Order Form, subscription / fleet-pricing schedule, renewal & cancellation | `…pricing_licensing_schedule__renewal_cancellation_language…` | DRAFT-PK | — | first paid customer |
| L5 | Implementation SOW template, Change Order template, Professional Services Agreement | `Change_Order_template__Professional_Services_Agreement…` | DRAFT-PK | — | first implementation |
| L6 | Data Processing Agreement, subprocessor register | `the_DPA__GPS_employee_monitoring_notice…`, `…Subprocessor_Register…` | DRAFT-PK | — | first customer data |
| L7 | GPS / employee-monitoring notice and consent | same as L6 | DRAFT-PK | — | first tracked driver |
| L8 | AI / OCR / voice policy and AI impact assessment | `…AI_policy…`, `…AI_impact_assessment` | DRAFT-PK | — | AI Secretary in production |
| L9 | Electronic-signature evidence policy | `Data_Retention___Destruction__Electronic_Signature_Evidence_Policy…` | DRAFT-PK | — | first signed field ticket |
| L10 | Data retention & destruction schedule, legal-hold procedure | same as L9; tables 0015 exist | DRAFT-PK | — | first retention disposition |
| L11 | SLA / support policy, support tiers | `…SLA_Support_Policy…`, `…support_tiers…` | DRAFT-PK | — | first paid customer |
| L12 | Beta / pilot agreement | `Pilot___Beta_Agreement__NDA…` | DRAFT-PK | — | first pilot |
| L13 | Developer / contractor IP assignment and NDA | same as L12 | DRAFT-PK | — | first outside contributor |
| L14 | API developer terms | `…API_Developer_Agreement…` | DRAFT-PK | — | first integration client |
| L15 | Security addendum, vulnerability disclosure / authorized testing policy | `Change_Order_template…Security_Addendum___security_commitments__Vulnerability_Disclosure…` | DRAFT-PK | — | first customer security review |
| L16 | Insurance & risk-transfer schedule | `Accessibility_Policy___Statement__Trademark_Copyright_IP_Register__Insurance___Risk_Transfer_Schedule…` | DRAFT-PK | — | first paid customer |
| L17 | Trademark / copyright / IP register | same as L16 | DRAFT-PK | — | public release |
| L18 | Corporate formation & governance checklist, regulatory-change procedure, employee/contractor legal handbook | `Corporate_Formation___Governance_Checklist…` | DRAFT-PK | — | incorporation |
| L19 | Privacy impact assessment template; legal-document index / version register | `legal-document_index_version_register__corporate_formation…` | DRAFT-PK | — | first customer data |
| L20 | Master Legal & Compliance Manual (Draft 34); Legal Launch Gate | `Draft_34___Master_LeaseOS_Legal___Compliance_Manual`, `…master_LeaseOS_Legal_Launch_Gate` | DRAFT-PK | — | launch |

None of these is code, and none of them is finished by this register. What the
register does is make "the legal side is done" a checkable claim: it is done
when every row reads SIGNED-OFF with an owner and a date.

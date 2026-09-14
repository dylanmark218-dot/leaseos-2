-- v22.4 — Integer shadows on every remaining double money column.
--
-- Amounts get `…Cents` (ROUND(x * 100)); per-unit rates — a fuel unit price, a
-- pay rate, a rate applied — get `…Millis` (ROUND(x * 1000)), because a rate
-- carries three decimals and is not an amount. Forward migration only: the
-- doubles stay for older readers; each shadow is backfilled from its double;
-- BEFORE INSERT fills a missing shadow and BEFORE UPDATE re-derives it when the
-- double changes alone, as v22.3 established. Every pair reconciles by test.

ALTER TABLE `contractorSettlementLines`
  ADD COLUMN `amountCents` int AFTER `amount`,
  ADD COLUMN `rateAppliedMillis` int AFTER `rateApplied`;
--> statement-breakpoint
UPDATE `contractorSettlementLines` SET `amountCents` = ROUND(`amount` * 100), `rateAppliedMillis` = ROUND(`rateApplied` * 1000);
--> statement-breakpoint
CREATE TRIGGER `contractorSettlementLines_money_bi` BEFORE INSERT ON `contractorSettlementLines` FOR EACH ROW SET NEW.`amountCents` = COALESCE(NEW.`amountCents`, ROUND(NEW.`amount` * 100)), NEW.`rateAppliedMillis` = COALESCE(NEW.`rateAppliedMillis`, ROUND(NEW.`rateApplied` * 1000));
--> statement-breakpoint
CREATE TRIGGER `contractorSettlementLines_money_bu` BEFORE UPDATE ON `contractorSettlementLines` FOR EACH ROW SET NEW.`amountCents` = IF(NEW.`amount` <=> OLD.`amount`, NEW.`amountCents`, ROUND(NEW.`amount` * 100)), NEW.`rateAppliedMillis` = IF(NEW.`rateApplied` <=> OLD.`rateApplied`, NEW.`rateAppliedMillis`, ROUND(NEW.`rateApplied` * 1000));
--> statement-breakpoint
ALTER TABLE `contractorSettlements`
  ADD COLUMN `deductionTotalCents` int AFTER `deductionTotal`,
  ADD COLUMN `grossAmountCents` int AFTER `grossAmount`,
  ADD COLUMN `netAmountCents` int AFTER `netAmount`;
--> statement-breakpoint
UPDATE `contractorSettlements` SET `deductionTotalCents` = ROUND(`deductionTotal` * 100), `grossAmountCents` = ROUND(`grossAmount` * 100), `netAmountCents` = ROUND(`netAmount` * 100);
--> statement-breakpoint
CREATE TRIGGER `contractorSettlements_money_bi` BEFORE INSERT ON `contractorSettlements` FOR EACH ROW SET NEW.`deductionTotalCents` = COALESCE(NEW.`deductionTotalCents`, ROUND(NEW.`deductionTotal` * 100)), NEW.`grossAmountCents` = COALESCE(NEW.`grossAmountCents`, ROUND(NEW.`grossAmount` * 100)), NEW.`netAmountCents` = COALESCE(NEW.`netAmountCents`, ROUND(NEW.`netAmount` * 100));
--> statement-breakpoint
CREATE TRIGGER `contractorSettlements_money_bu` BEFORE UPDATE ON `contractorSettlements` FOR EACH ROW SET NEW.`deductionTotalCents` = IF(NEW.`deductionTotal` <=> OLD.`deductionTotal`, NEW.`deductionTotalCents`, ROUND(NEW.`deductionTotal` * 100)), NEW.`grossAmountCents` = IF(NEW.`grossAmount` <=> OLD.`grossAmount`, NEW.`grossAmountCents`, ROUND(NEW.`grossAmount` * 100)), NEW.`netAmountCents` = IF(NEW.`netAmount` <=> OLD.`netAmount`, NEW.`netAmountCents`, ROUND(NEW.`netAmount` * 100));
--> statement-breakpoint
ALTER TABLE `customerRecoveryProposals`
  ADD COLUMN `companyCostCents` int AFTER `companyCost`;
--> statement-breakpoint
UPDATE `customerRecoveryProposals` SET `companyCostCents` = ROUND(`companyCost` * 100);
--> statement-breakpoint
CREATE TRIGGER `customerRecoveryProposals_money_bi` BEFORE INSERT ON `customerRecoveryProposals` FOR EACH ROW SET NEW.`companyCostCents` = COALESCE(NEW.`companyCostCents`, ROUND(NEW.`companyCost` * 100));
--> statement-breakpoint
CREATE TRIGGER `customerRecoveryProposals_money_bu` BEFORE UPDATE ON `customerRecoveryProposals` FOR EACH ROW SET NEW.`companyCostCents` = IF(NEW.`companyCost` <=> OLD.`companyCost`, NEW.`companyCostCents`, ROUND(NEW.`companyCost` * 100));
--> statement-breakpoint
ALTER TABLE `expenseAllocations`
  ADD COLUMN `amountCents` int AFTER `amount`;
--> statement-breakpoint
UPDATE `expenseAllocations` SET `amountCents` = ROUND(`amount` * 100);
--> statement-breakpoint
CREATE TRIGGER `expenseAllocations_money_bi` BEFORE INSERT ON `expenseAllocations` FOR EACH ROW SET NEW.`amountCents` = COALESCE(NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
CREATE TRIGGER `expenseAllocations_money_bu` BEFORE UPDATE ON `expenseAllocations` FOR EACH ROW SET NEW.`amountCents` = IF(NEW.`amount` <=> OLD.`amount`, NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
ALTER TABLE `expenseRecords`
  ADD COLUMN `salesTaxAmountCents` int AFTER `salesTaxAmount`,
  ADD COLUMN `subtotalCents` int AFTER `subtotal`,
  ADD COLUMN `totalCents` int AFTER `total`;
--> statement-breakpoint
UPDATE `expenseRecords` SET `salesTaxAmountCents` = ROUND(`salesTaxAmount` * 100), `subtotalCents` = ROUND(`subtotal` * 100), `totalCents` = ROUND(`total` * 100);
--> statement-breakpoint
CREATE TRIGGER `expenseRecords_money_bi` BEFORE INSERT ON `expenseRecords` FOR EACH ROW SET NEW.`salesTaxAmountCents` = COALESCE(NEW.`salesTaxAmountCents`, ROUND(NEW.`salesTaxAmount` * 100)), NEW.`subtotalCents` = COALESCE(NEW.`subtotalCents`, ROUND(NEW.`subtotal` * 100)), NEW.`totalCents` = COALESCE(NEW.`totalCents`, ROUND(NEW.`total` * 100));
--> statement-breakpoint
CREATE TRIGGER `expenseRecords_money_bu` BEFORE UPDATE ON `expenseRecords` FOR EACH ROW SET NEW.`salesTaxAmountCents` = IF(NEW.`salesTaxAmount` <=> OLD.`salesTaxAmount`, NEW.`salesTaxAmountCents`, ROUND(NEW.`salesTaxAmount` * 100)), NEW.`subtotalCents` = IF(NEW.`subtotal` <=> OLD.`subtotal`, NEW.`subtotalCents`, ROUND(NEW.`subtotal` * 100)), NEW.`totalCents` = IF(NEW.`total` <=> OLD.`total`, NEW.`totalCents`, ROUND(NEW.`total` * 100));
--> statement-breakpoint
ALTER TABLE `fuelStatementLines`
  ADD COLUMN `totalCents` int AFTER `total`;
--> statement-breakpoint
UPDATE `fuelStatementLines` SET `totalCents` = ROUND(`total` * 100);
--> statement-breakpoint
CREATE TRIGGER `fuelStatementLines_money_bi` BEFORE INSERT ON `fuelStatementLines` FOR EACH ROW SET NEW.`totalCents` = COALESCE(NEW.`totalCents`, ROUND(NEW.`total` * 100));
--> statement-breakpoint
CREATE TRIGGER `fuelStatementLines_money_bu` BEFORE UPDATE ON `fuelStatementLines` FOR EACH ROW SET NEW.`totalCents` = IF(NEW.`total` <=> OLD.`total`, NEW.`totalCents`, ROUND(NEW.`total` * 100));
--> statement-breakpoint
ALTER TABLE `fuelTransactions`
  ADD COLUMN `reimbursedAmountCents` int AFTER `reimbursedAmount`,
  ADD COLUMN `unitPriceMillis` int AFTER `unitPrice`;
--> statement-breakpoint
UPDATE `fuelTransactions` SET `reimbursedAmountCents` = ROUND(`reimbursedAmount` * 100), `unitPriceMillis` = ROUND(`unitPrice` * 1000);
--> statement-breakpoint
CREATE TRIGGER `fuelTransactions_money_bi` BEFORE INSERT ON `fuelTransactions` FOR EACH ROW SET NEW.`reimbursedAmountCents` = COALESCE(NEW.`reimbursedAmountCents`, ROUND(NEW.`reimbursedAmount` * 100)), NEW.`unitPriceMillis` = COALESCE(NEW.`unitPriceMillis`, ROUND(NEW.`unitPrice` * 1000));
--> statement-breakpoint
CREATE TRIGGER `fuelTransactions_money_bu` BEFORE UPDATE ON `fuelTransactions` FOR EACH ROW SET NEW.`reimbursedAmountCents` = IF(NEW.`reimbursedAmount` <=> OLD.`reimbursedAmount`, NEW.`reimbursedAmountCents`, ROUND(NEW.`reimbursedAmount` * 100)), NEW.`unitPriceMillis` = IF(NEW.`unitPrice` <=> OLD.`unitPrice`, NEW.`unitPriceMillis`, ROUND(NEW.`unitPrice` * 1000));
--> statement-breakpoint
ALTER TABLE `fundingClaims`
  ADD COLUMN `claimedAmountCents` int AFTER `claimedAmount`,
  ADD COLUMN `eligibleCostCents` int AFTER `eligibleCost`;
--> statement-breakpoint
UPDATE `fundingClaims` SET `claimedAmountCents` = ROUND(`claimedAmount` * 100), `eligibleCostCents` = ROUND(`eligibleCost` * 100);
--> statement-breakpoint
CREATE TRIGGER `fundingClaims_money_bi` BEFORE INSERT ON `fundingClaims` FOR EACH ROW SET NEW.`claimedAmountCents` = COALESCE(NEW.`claimedAmountCents`, ROUND(NEW.`claimedAmount` * 100)), NEW.`eligibleCostCents` = COALESCE(NEW.`eligibleCostCents`, ROUND(NEW.`eligibleCost` * 100));
--> statement-breakpoint
CREATE TRIGGER `fundingClaims_money_bu` BEFORE UPDATE ON `fundingClaims` FOR EACH ROW SET NEW.`claimedAmountCents` = IF(NEW.`claimedAmount` <=> OLD.`claimedAmount`, NEW.`claimedAmountCents`, ROUND(NEW.`claimedAmount` * 100)), NEW.`eligibleCostCents` = IF(NEW.`eligibleCost` <=> OLD.`eligibleCost`, NEW.`eligibleCostCents`, ROUND(NEW.`eligibleCost` * 100));
--> statement-breakpoint
ALTER TABLE `fundingOpportunities`
  ADD COLUMN `estimatedAmountCents` int AFTER `estimatedAmount`;
--> statement-breakpoint
UPDATE `fundingOpportunities` SET `estimatedAmountCents` = ROUND(`estimatedAmount` * 100);
--> statement-breakpoint
CREATE TRIGGER `fundingOpportunities_money_bi` BEFORE INSERT ON `fundingOpportunities` FOR EACH ROW SET NEW.`estimatedAmountCents` = COALESCE(NEW.`estimatedAmountCents`, ROUND(NEW.`estimatedAmount` * 100));
--> statement-breakpoint
CREATE TRIGGER `fundingOpportunities_money_bu` BEFORE UPDATE ON `fundingOpportunities` FOR EACH ROW SET NEW.`estimatedAmountCents` = IF(NEW.`estimatedAmount` <=> OLD.`estimatedAmount`, NEW.`estimatedAmountCents`, ROUND(NEW.`estimatedAmount` * 100));
--> statement-breakpoint
ALTER TABLE `insuranceClaimCosts`
  ADD COLUMN `amountCents` int AFTER `amount`;
--> statement-breakpoint
UPDATE `insuranceClaimCosts` SET `amountCents` = ROUND(`amount` * 100);
--> statement-breakpoint
CREATE TRIGGER `insuranceClaimCosts_money_bi` BEFORE INSERT ON `insuranceClaimCosts` FOR EACH ROW SET NEW.`amountCents` = COALESCE(NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
CREATE TRIGGER `insuranceClaimCosts_money_bu` BEFORE UPDATE ON `insuranceClaimCosts` FOR EACH ROW SET NEW.`amountCents` = IF(NEW.`amount` <=> OLD.`amount`, NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
ALTER TABLE `insuranceClaimRecoveries`
  ADD COLUMN `amountCents` int AFTER `amount`;
--> statement-breakpoint
UPDATE `insuranceClaimRecoveries` SET `amountCents` = ROUND(`amount` * 100);
--> statement-breakpoint
CREATE TRIGGER `insuranceClaimRecoveries_money_bi` BEFORE INSERT ON `insuranceClaimRecoveries` FOR EACH ROW SET NEW.`amountCents` = COALESCE(NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
CREATE TRIGGER `insuranceClaimRecoveries_money_bu` BEFORE UPDATE ON `insuranceClaimRecoveries` FOR EACH ROW SET NEW.`amountCents` = IF(NEW.`amount` <=> OLD.`amount`, NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
ALTER TABLE `insuranceClaims`
  ADD COLUMN `approvedAmountCents` int AFTER `approvedAmount`,
  ADD COLUMN `deductibleCents` int AFTER `deductible`,
  ADD COLUMN `estimatedLossCents` int AFTER `estimatedLoss`;
--> statement-breakpoint
UPDATE `insuranceClaims` SET `approvedAmountCents` = ROUND(`approvedAmount` * 100), `deductibleCents` = ROUND(`deductible` * 100), `estimatedLossCents` = ROUND(`estimatedLoss` * 100);
--> statement-breakpoint
CREATE TRIGGER `insuranceClaims_money_bi` BEFORE INSERT ON `insuranceClaims` FOR EACH ROW SET NEW.`approvedAmountCents` = COALESCE(NEW.`approvedAmountCents`, ROUND(NEW.`approvedAmount` * 100)), NEW.`deductibleCents` = COALESCE(NEW.`deductibleCents`, ROUND(NEW.`deductible` * 100)), NEW.`estimatedLossCents` = COALESCE(NEW.`estimatedLossCents`, ROUND(NEW.`estimatedLoss` * 100));
--> statement-breakpoint
CREATE TRIGGER `insuranceClaims_money_bu` BEFORE UPDATE ON `insuranceClaims` FOR EACH ROW SET NEW.`approvedAmountCents` = IF(NEW.`approvedAmount` <=> OLD.`approvedAmount`, NEW.`approvedAmountCents`, ROUND(NEW.`approvedAmount` * 100)), NEW.`deductibleCents` = IF(NEW.`deductible` <=> OLD.`deductible`, NEW.`deductibleCents`, ROUND(NEW.`deductible` * 100)), NEW.`estimatedLossCents` = IF(NEW.`estimatedLoss` <=> OLD.`estimatedLoss`, NEW.`estimatedLossCents`, ROUND(NEW.`estimatedLoss` * 100));
--> statement-breakpoint
ALTER TABLE `insurancePolicies`
  ADD COLUMN `annualPremiumCents` int AFTER `annualPremium`,
  ADD COLUMN `deductibleCents` int AFTER `deductible`;
--> statement-breakpoint
UPDATE `insurancePolicies` SET `annualPremiumCents` = ROUND(`annualPremium` * 100), `deductibleCents` = ROUND(`deductible` * 100);
--> statement-breakpoint
CREATE TRIGGER `insurancePolicies_money_bi` BEFORE INSERT ON `insurancePolicies` FOR EACH ROW SET NEW.`annualPremiumCents` = COALESCE(NEW.`annualPremiumCents`, ROUND(NEW.`annualPremium` * 100)), NEW.`deductibleCents` = COALESCE(NEW.`deductibleCents`, ROUND(NEW.`deductible` * 100));
--> statement-breakpoint
CREATE TRIGGER `insurancePolicies_money_bu` BEFORE UPDATE ON `insurancePolicies` FOR EACH ROW SET NEW.`annualPremiumCents` = IF(NEW.`annualPremium` <=> OLD.`annualPremium`, NEW.`annualPremiumCents`, ROUND(NEW.`annualPremium` * 100)), NEW.`deductibleCents` = IF(NEW.`deductible` <=> OLD.`deductible`, NEW.`deductibleCents`, ROUND(NEW.`deductible` * 100));
--> statement-breakpoint
ALTER TABLE `insurancePolicyCoverages`
  ADD COLUMN `deductibleCents` int AFTER `deductible`,
  ADD COLUMN `limitAmountCents` int AFTER `limitAmount`;
--> statement-breakpoint
UPDATE `insurancePolicyCoverages` SET `deductibleCents` = ROUND(`deductible` * 100), `limitAmountCents` = ROUND(`limitAmount` * 100);
--> statement-breakpoint
CREATE TRIGGER `insurancePolicyCoverages_money_bi` BEFORE INSERT ON `insurancePolicyCoverages` FOR EACH ROW SET NEW.`deductibleCents` = COALESCE(NEW.`deductibleCents`, ROUND(NEW.`deductible` * 100)), NEW.`limitAmountCents` = COALESCE(NEW.`limitAmountCents`, ROUND(NEW.`limitAmount` * 100));
--> statement-breakpoint
CREATE TRIGGER `insurancePolicyCoverages_money_bu` BEFORE UPDATE ON `insurancePolicyCoverages` FOR EACH ROW SET NEW.`deductibleCents` = IF(NEW.`deductible` <=> OLD.`deductible`, NEW.`deductibleCents`, ROUND(NEW.`deductible` * 100)), NEW.`limitAmountCents` = IF(NEW.`limitAmount` <=> OLD.`limitAmount`, NEW.`limitAmountCents`, ROUND(NEW.`limitAmount` * 100));
--> statement-breakpoint
ALTER TABLE `payRates`
  ADD COLUMN `rateMillis` int AFTER `rate`;
--> statement-breakpoint
UPDATE `payRates` SET `rateMillis` = ROUND(`rate` * 1000);
--> statement-breakpoint
CREATE TRIGGER `payRates_money_bi` BEFORE INSERT ON `payRates` FOR EACH ROW SET NEW.`rateMillis` = COALESCE(NEW.`rateMillis`, ROUND(NEW.`rate` * 1000));
--> statement-breakpoint
CREATE TRIGGER `payRates_money_bu` BEFORE UPDATE ON `payRates` FOR EACH ROW SET NEW.`rateMillis` = IF(NEW.`rate` <=> OLD.`rate`, NEW.`rateMillis`, ROUND(NEW.`rate` * 1000));
--> statement-breakpoint
ALTER TABLE `payRunLines`
  ADD COLUMN `amountCents` int AFTER `amount`,
  ADD COLUMN `rateAppliedMillis` int AFTER `rateApplied`;
--> statement-breakpoint
UPDATE `payRunLines` SET `amountCents` = ROUND(`amount` * 100), `rateAppliedMillis` = ROUND(`rateApplied` * 1000);
--> statement-breakpoint
CREATE TRIGGER `payRunLines_money_bi` BEFORE INSERT ON `payRunLines` FOR EACH ROW SET NEW.`amountCents` = COALESCE(NEW.`amountCents`, ROUND(NEW.`amount` * 100)), NEW.`rateAppliedMillis` = COALESCE(NEW.`rateAppliedMillis`, ROUND(NEW.`rateApplied` * 1000));
--> statement-breakpoint
CREATE TRIGGER `payRunLines_money_bu` BEFORE UPDATE ON `payRunLines` FOR EACH ROW SET NEW.`amountCents` = IF(NEW.`amount` <=> OLD.`amount`, NEW.`amountCents`, ROUND(NEW.`amount` * 100)), NEW.`rateAppliedMillis` = IF(NEW.`rateApplied` <=> OLD.`rateApplied`, NEW.`rateAppliedMillis`, ROUND(NEW.`rateApplied` * 1000));
--> statement-breakpoint
ALTER TABLE `payrollAdjustments`
  ADD COLUMN `amountCents` int AFTER `amount`;
--> statement-breakpoint
UPDATE `payrollAdjustments` SET `amountCents` = ROUND(`amount` * 100);
--> statement-breakpoint
CREATE TRIGGER `payrollAdjustments_money_bi` BEFORE INSERT ON `payrollAdjustments` FOR EACH ROW SET NEW.`amountCents` = COALESCE(NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
CREATE TRIGGER `payrollAdjustments_money_bu` BEFORE UPDATE ON `payrollAdjustments` FOR EACH ROW SET NEW.`amountCents` = IF(NEW.`amount` <=> OLD.`amount`, NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
ALTER TABLE `payrollEarningEvents`
  ADD COLUMN `calculatedAmountCents` int AFTER `calculatedAmount`,
  ADD COLUMN `rateAppliedMillis` int AFTER `rateApplied`;
--> statement-breakpoint
UPDATE `payrollEarningEvents` SET `calculatedAmountCents` = ROUND(`calculatedAmount` * 100), `rateAppliedMillis` = ROUND(`rateApplied` * 1000);
--> statement-breakpoint
CREATE TRIGGER `payrollEarningEvents_money_bi` BEFORE INSERT ON `payrollEarningEvents` FOR EACH ROW SET NEW.`calculatedAmountCents` = COALESCE(NEW.`calculatedAmountCents`, ROUND(NEW.`calculatedAmount` * 100)), NEW.`rateAppliedMillis` = COALESCE(NEW.`rateAppliedMillis`, ROUND(NEW.`rateApplied` * 1000));
--> statement-breakpoint
CREATE TRIGGER `payrollEarningEvents_money_bu` BEFORE UPDATE ON `payrollEarningEvents` FOR EACH ROW SET NEW.`calculatedAmountCents` = IF(NEW.`calculatedAmount` <=> OLD.`calculatedAmount`, NEW.`calculatedAmountCents`, ROUND(NEW.`calculatedAmount` * 100)), NEW.`rateAppliedMillis` = IF(NEW.`rateApplied` <=> OLD.`rateApplied`, NEW.`rateAppliedMillis`, ROUND(NEW.`rateApplied` * 1000));
--> statement-breakpoint
ALTER TABLE `purchaseAuthorizations`
  ADD COLUMN `estimatedAmountCents` int AFTER `estimatedAmount`;
--> statement-breakpoint
UPDATE `purchaseAuthorizations` SET `estimatedAmountCents` = ROUND(`estimatedAmount` * 100);
--> statement-breakpoint
CREATE TRIGGER `purchaseAuthorizations_money_bi` BEFORE INSERT ON `purchaseAuthorizations` FOR EACH ROW SET NEW.`estimatedAmountCents` = COALESCE(NEW.`estimatedAmountCents`, ROUND(NEW.`estimatedAmount` * 100));
--> statement-breakpoint
CREATE TRIGGER `purchaseAuthorizations_money_bu` BEFORE UPDATE ON `purchaseAuthorizations` FOR EACH ROW SET NEW.`estimatedAmountCents` = IF(NEW.`estimatedAmount` <=> OLD.`estimatedAmount`, NEW.`estimatedAmountCents`, ROUND(NEW.`estimatedAmount` * 100));

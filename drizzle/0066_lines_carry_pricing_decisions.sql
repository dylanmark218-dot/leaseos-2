-- v22.8 — The paths that bill write the decision they reference.
--
-- A field-ticket line and a vendor-bill line may name the service they are
-- for; when they do, the resolver runs as the line is recorded, the pricing
-- decision is written once, and the line carries its reference. A line
-- still records a fact, not a price: an unknown rate is a decision that
-- says so and never stops the field. A vendor line also carries the
-- variance between what the vendor billed per unit and what was agreed.

ALTER TABLE `fieldTicketLines`
  ADD COLUMN `serviceCode` varchar(60) AFTER `lineKind`,
  ADD COLUMN `pricingDecisionRef` varchar(64) AFTER `sourceTrackingNumber`;
--> statement-breakpoint
ALTER TABLE `vendorBillLines`
  ADD COLUMN `serviceCode` varchar(60) AFTER `lineType`,
  ADD COLUMN `pricingDecisionRef` varchar(64) AFTER `amountCents`,
  ADD COLUMN `rateVarianceCents` int AFTER `pricingDecisionRef`;
--> statement-breakpoint
CREATE INDEX `fieldTicketLines_decision` ON `fieldTicketLines` (`pricingDecisionRef`);
--> statement-breakpoint
CREATE INDEX `vendorBillLines_variance` ON `vendorBillLines` (`rateVarianceCents`);

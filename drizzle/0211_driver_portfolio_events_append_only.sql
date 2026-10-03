-- 0211: a driver's credential history is appended to, never edited.
-- Compound bodies: this file contains trigger DDL and nothing else.
--
-- "Verified by Safety Admin at 18:49" is only evidence if nobody can change it
-- at 19:00. The router never updates or deletes these rows; the database
-- refuses it when a write arrives around the router.

CREATE TRIGGER `driverPortfolioEvents_no_update`
BEFORE UPDATE ON `driverPortfolioEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'driverPortfolioEvents is append-only';
END;
--> statement-breakpoint
CREATE TRIGGER `driverPortfolioEvents_no_delete`
BEFORE DELETE ON `driverPortfolioEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'driverPortfolioEvents is append-only';
END;

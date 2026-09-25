-- 0203 — LA-1a: the Live Assist lifecycle record is append-only.
--
-- Separate from 0202 on the precedent of the driver-portfolio pair (tables, then their guard). The
-- application never updates or deletes an event; the database now refuses it too, so a later caller
-- cannot quietly rewrite who started, ended or purged a session. The purge removes transient rows
-- (turns, frames, observations) and never events.
CREATE TRIGGER `liveAssistEvents_append_only`
BEFORE UPDATE ON `liveAssistEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Live Assist events are append-only';
--> statement-breakpoint
CREATE TRIGGER `liveAssistEvents_no_delete`
BEFORE DELETE ON `liveAssistEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Live Assist events are never deleted';

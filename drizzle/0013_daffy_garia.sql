ALTER TABLE `keyAuditLogs` MODIFY COLUMN `keyCode` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `licenses` MODIFY COLUMN `keyCode` varchar(64) NOT NULL;
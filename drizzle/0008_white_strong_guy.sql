CREATE TABLE `keyAuditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerId` int NOT NULL,
	`actorDiscordId` varchar(32) NOT NULL,
	`action` enum('generate','delete') NOT NULL,
	`keyCode` varchar(10) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `keyAuditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `keyAuditLogs` ADD CONSTRAINT `keyAuditLogs_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
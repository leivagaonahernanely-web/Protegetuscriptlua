CREATE TABLE `warnings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerId` int NOT NULL,
	`hostedScriptId` int,
	`discordUserId` varchar(32) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `warnings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `discordNickname` varchar(128);--> statement-breakpoint
ALTER TABLE `users` ADD `discordAvatarUrl` varchar(500);--> statement-breakpoint
ALTER TABLE `warnings` ADD CONSTRAINT `warnings_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `warnings` ADD CONSTRAINT `warnings_hostedScriptId_hostedScripts_id_fk` FOREIGN KEY (`hostedScriptId`) REFERENCES `hostedScripts`(`id`) ON DELETE no action ON UPDATE no action;
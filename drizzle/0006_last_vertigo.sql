CREATE TABLE `accessRules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerId` int NOT NULL,
	`kind` enum('user','role') NOT NULL,
	`discordId` varchar(32) NOT NULL,
	`label` varchar(128),
	`active` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accessRules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `blacklists` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerId` int NOT NULL,
	`discordUserId` varchar(32) NOT NULL,
	`reason` varchar(500),
	`active` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `blacklists_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `licenses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerId` int NOT NULL,
	`hostedScriptId` int,
	`keyCode` varchar(10) NOT NULL,
	`type` enum('trial','license') NOT NULL DEFAULT 'license',
	`status` enum('active','revoked','expired') NOT NULL DEFAULT 'active',
	`discordUserId` varchar(32),
	`hwid` varchar(128),
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `licenses_id` PRIMARY KEY(`id`),
	CONSTRAINT `licenses_keyCode_unique` UNIQUE(`keyCode`)
);
--> statement-breakpoint
ALTER TABLE `accessRules` ADD CONSTRAINT `accessRules_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `blacklists` ADD CONSTRAINT `blacklists_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `licenses` ADD CONSTRAINT `licenses_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `licenses` ADD CONSTRAINT `licenses_hostedScriptId_hostedScripts_id_fk` FOREIGN KEY (`hostedScriptId`) REFERENCES `hostedScripts`(`id`) ON DELETE no action ON UPDATE no action;
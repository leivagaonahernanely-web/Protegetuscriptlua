CREATE TABLE `discordPanels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` varchar(1000),
	`channelId` varchar(32) NOT NULL,
	`targetScript` varchar(255) NOT NULL,
	`hwidHours` int NOT NULL DEFAULT 24,
	`messageId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `discordPanels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `discordPanels` ADD CONSTRAINT `discordPanels_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
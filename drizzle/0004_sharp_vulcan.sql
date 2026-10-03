CREATE TABLE `hostedScripts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`slug` varchar(32) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` varchar(500),
	`ffaMode` int NOT NULL DEFAULT 0,
	`code` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `hostedScripts_id` PRIMARY KEY(`id`),
	CONSTRAINT `hostedScripts_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `hostedScripts` ADD CONSTRAINT `hostedScripts_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
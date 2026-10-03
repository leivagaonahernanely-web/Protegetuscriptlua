CREATE TABLE `protections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`sourceSize` int NOT NULL,
	`status` enum('protected','review','failed') NOT NULL DEFAULT 'protected',
	`mode` enum('fast','balanced','fortified') NOT NULL DEFAULT 'balanced',
	`obfuscateStrings` int NOT NULL DEFAULT 1,
	`addLoaderGuard` int NOT NULL DEFAULT 1,
	`checksum` varchar(16) NOT NULL,
	`resultCode` text,
	`message` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `protections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `protections` ADD CONSTRAINT `protections_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
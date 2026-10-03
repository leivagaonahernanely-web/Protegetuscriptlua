ALTER TABLE `users` ADD `apiKey` varchar(80);--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_apiKey_unique` UNIQUE(`apiKey`);
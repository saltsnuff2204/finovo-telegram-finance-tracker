ALTER TABLE `transactions` ADD `telegram_update_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_telegram_update_idx` ON `transactions` (`telegram_update_id`);
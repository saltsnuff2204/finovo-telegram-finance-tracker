CREATE TABLE `telegram_update_receipts` (
	`update_id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`processed_at` integer NOT NULL
);

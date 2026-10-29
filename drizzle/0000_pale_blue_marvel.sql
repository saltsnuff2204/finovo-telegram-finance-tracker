CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text DEFAULT 'circle' NOT NULL,
	`color` text DEFAULT '#8b5cf6' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_user_idx` ON `categories` (`user_id`);--> statement-breakpoint
CREATE TABLE `obligations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`amount` real NOT NULL,
	`current_amount` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'KZT' NOT NULL,
	`due_date` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `obligations_user_kind_idx` ON `obligations` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'KZT' NOT NULL,
	`category` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`happened_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transactions_user_date_idx` ON `transactions` (`user_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `transactions_user_type_idx` ON `transactions` (`user_id`,`type`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`username` text,
	`base_currency` text DEFAULT 'KZT' NOT NULL,
	`created_at` integer NOT NULL
);

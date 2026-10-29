CREATE TABLE `credit_installments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`obligation_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`installment_number` integer NOT NULL,
	`amount` real NOT NULL,
	`currency` text NOT NULL,
	`due_at` integer NOT NULL,
	`posted_at` integer,
	`reminder_7_at` integer,
	`reminder_3_at` integer,
	`reminder_1_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_installments_obligation_number_idx` ON `credit_installments` (`obligation_id`,`installment_number`);--> statement-breakpoint
CREATE INDEX `credit_installments_due_idx` ON `credit_installments` (`due_at`,`posted_at`);--> statement-breakpoint
CREATE INDEX `credit_installments_user_idx` ON `credit_installments` (`user_id`);--> statement-breakpoint
ALTER TABLE `categories` ADD `type` text DEFAULT 'expense' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_type_name_idx` ON `categories` (`user_id`,`type`,`name`);--> statement-breakpoint
ALTER TABLE `obligations` ADD `monthly_payment` real;--> statement-breakpoint
ALTER TABLE `obligations` ADD `total_months` integer;--> statement-breakpoint
ALTER TABLE `obligations` ADD `paid_months` integer;--> statement-breakpoint
ALTER TABLE `obligations` ADD `payment_day` integer;--> statement-breakpoint
ALTER TABLE `obligations` ADD `next_payment_date` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `credit_installment_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_credit_installment_idx` ON `transactions` (`credit_installment_id`);
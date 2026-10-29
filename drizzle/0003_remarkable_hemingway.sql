ALTER TABLE `transactions` ADD `import_fingerprint` text;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_user_import_fingerprint_idx` ON `transactions` (`user_id`,`import_fingerprint`);
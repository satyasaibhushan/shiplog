ALTER TABLE `commits` ADD `is_merge` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `additions` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `deletions` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `changed_files` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `opened_by_other` integer DEFAULT 0 NOT NULL;
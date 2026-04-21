CREATE TABLE `commits` (
	`sha` text PRIMARY KEY NOT NULL,
	`patch_id` text,
	`repo` text NOT NULL,
	`message` text NOT NULL,
	`author` text NOT NULL,
	`date` text NOT NULL,
	`diff` text,
	`files` text,
	`stats_json` text,
	`is_merge` integer DEFAULT 0 NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `dedup_index` (
	`patch_id` text PRIMARY KEY NOT NULL,
	`commit_sha` text NOT NULL,
	FOREIGN KEY (`commit_sha`) REFERENCES `commits`(`sha`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`author_email` text NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`title` text,
	`active_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`merged_at` text,
	`created_at` text NOT NULL,
	`commit_shas` text,
	`additions` integer,
	`deletions` integer,
	`changed_files` integer
);
--> statement-breakpoint
CREATE TABLE `rollups` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`author_email` text NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`log_ids_json` text NOT NULL,
	`active_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stale_markers` (
	`parent_kind` text NOT NULL,
	`parent_id` text NOT NULL,
	`reason` text NOT NULL,
	`detected_at` integer NOT NULL,
	PRIMARY KEY(`parent_kind`, `parent_id`)
);
--> statement-breakpoint
CREATE TABLE `summaries` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`summary_type` text NOT NULL,
	`summary` text NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `summary_deps` (
	`parent_kind` text NOT NULL,
	`parent_id` text NOT NULL,
	`child_kind` text NOT NULL,
	`child_id` text NOT NULL,
	PRIMARY KEY(`parent_kind`, `parent_id`, `child_kind`, `child_id`)
);
--> statement-breakpoint
CREATE TABLE `summary_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_kind` text NOT NULL,
	`parent_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`summary_markdown` text NOT NULL,
	`timeline_json` text,
	`stats_json` text,
	`source` text NOT NULL,
	`chat_prompt_json` text,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);

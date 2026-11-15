CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`prompt` text,
	`model_id` text,
	`params` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `assets_user_kind_created` ON `assets` (`user_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `assets_job` ON `assets` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`position` integer NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`params` text NOT NULL,
	`status` text NOT NULL,
	`handle` text,
	`error` text,
	`cost_usd` real,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_turn` ON `jobs` (`turn_id`);--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_updated` ON `sessions` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`prompt` text NOT NULL,
	`reference_asset_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turns_session_created` ON `turns` (`session_id`,`created_at`);
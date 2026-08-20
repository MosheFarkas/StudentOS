ALTER TABLE "site_refresh_requests" ADD COLUMN "kind" text DEFAULT 'refresh' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_refresh_requests" ADD COLUMN "target_url" text;--> statement-breakpoint
ALTER TABLE "site_refresh_requests" ADD COLUMN "result" jsonb;
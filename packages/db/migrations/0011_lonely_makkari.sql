ALTER TABLE "agents" ADD COLUMN "profile" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "profile_updated_at" timestamp with time zone;
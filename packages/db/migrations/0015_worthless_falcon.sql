CREATE TABLE "vault_sync" (
	"user_id" text PRIMARY KEY NOT NULL,
	"drive_page_token" text,
	"drive_channel_id" text,
	"drive_resource_id" text,
	"drive_channel_secret" text,
	"drive_channel_expires_at" timestamp with time zone,
	"gmail_watch_expires_at" timestamp with time zone,
	"school_domains" jsonb,
	"last_live_sync_at" timestamp with time zone,
	"last_refresh_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vault_sync" ADD CONSTRAINT "vault_sync_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_sync_drive_channel_id_idx" ON "vault_sync" USING btree ("drive_channel_id");
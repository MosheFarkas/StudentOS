CREATE TABLE "site_refresh_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"portal_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "site_refresh_requests" ADD CONSTRAINT "site_refresh_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_refresh_user_idx" ON "site_refresh_requests" USING btree ("user_id","portal_id","requested_at");
CREATE TABLE "disabled_sites" (
	"user_id" text NOT NULL,
	"portal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disabled_sites_user_id_portal_id_pk" PRIMARY KEY("user_id","portal_id")
);
--> statement-breakpoint
ALTER TABLE "disabled_sites" ADD CONSTRAINT "disabled_sites_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
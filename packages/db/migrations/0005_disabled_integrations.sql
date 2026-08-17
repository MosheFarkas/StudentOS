CREATE TABLE "disabled_integrations" (
	"user_id" text NOT NULL,
	"integration" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "disabled_integrations_user_id_integration_pk" PRIMARY KEY("user_id","integration")
);
--> statement-breakpoint
ALTER TABLE "disabled_integrations" ADD CONSTRAINT "disabled_integrations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
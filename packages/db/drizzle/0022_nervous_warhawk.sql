CREATE TABLE "orchestrator_crew_bindings" (
	"key" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"role_id" text NOT NULL,
	"account" text NOT NULL,
	"label" text,
	"blueprint_id" text,
	"crew_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crew_bindings_account_idx" ON "orchestrator_crew_bindings" USING btree ("account");
CREATE TABLE "orchestrator_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"org_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "orchestrator_audit_events" USING btree ("at");
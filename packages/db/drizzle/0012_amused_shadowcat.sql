CREATE TABLE "orchestrator_connector_asks" (
	"id" text PRIMARY KEY NOT NULL,
	"connector" text NOT NULL,
	"route" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"fingerprint" text NOT NULL,
	"args" jsonb NOT NULL,
	"principal" text DEFAULT '' NOT NULL,
	"thread_id" text NOT NULL,
	"question_id" text NOT NULL,
	"flow_id" text,
	"run_id" text,
	"status" text NOT NULL,
	"outcome" text,
	"resume" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orchestrator_connector_modes" (
	"scope_key" text NOT NULL,
	"scope" jsonb NOT NULL,
	"route" text NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_modes_scope_route" UNIQUE("scope_key","route")
);
--> statement-breakpoint
CREATE INDEX "connector_asks_question_idx" ON "orchestrator_connector_asks" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "connector_asks_status_idx" ON "orchestrator_connector_asks" USING btree ("status");
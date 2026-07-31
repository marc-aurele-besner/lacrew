CREATE TABLE "orchestrator_dual_control_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"effect" text NOT NULL,
	"fingerprint" text NOT NULL,
	"args" jsonb NOT NULL,
	"value" text,
	"actor" text NOT NULL,
	"reviewer" text NOT NULL,
	"reviewers" jsonb NOT NULL,
	"human" boolean DEFAULT false NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"human_override" boolean DEFAULT true NOT NULL,
	"thread_id" text NOT NULL,
	"question_id" text NOT NULL,
	"flow_id" text,
	"run_id" text,
	"status" text NOT NULL,
	"outcome" text,
	"decided_by" text,
	"decided_by_kind" text,
	"resume" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orchestrator_dual_control_rules" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"mode" text NOT NULL,
	"reviewer" text NOT NULL,
	"min_spend" text DEFAULT '0' NOT NULL,
	"connector_writes" boolean DEFAULT true NOT NULL,
	"org_mutators" boolean DEFAULT true NOT NULL,
	"timeout_ms" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dual_control_question_idx" ON "orchestrator_dual_control_reviews" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "dual_control_status_idx" ON "orchestrator_dual_control_reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dual_control_run_idx" ON "orchestrator_dual_control_reviews" USING btree ("run_id");
CREATE TABLE "orchestrator_human_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text,
	"run_id" text,
	"step_id" text NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"assignee" text,
	"principal" text DEFAULT '' NOT NULL,
	"thread_id" text NOT NULL,
	"question_id" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"option_id" text,
	"answered_by" text,
	"resume" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "human_gates_question_idx" ON "orchestrator_human_gates" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "human_gates_status_idx" ON "orchestrator_human_gates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "human_gates_run_idx" ON "orchestrator_human_gates" USING btree ("run_id");
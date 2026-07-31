CREATE TABLE "orchestrator_flow_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"flow_id" text NOT NULL,
	"step_id" text NOT NULL,
	"next_step_id" text,
	"status" text NOT NULL,
	"pause" jsonb,
	"state" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_checkpoints_run_seq_uq" UNIQUE("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "orchestrator_flow_run_state" (
	"run_id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"status" text NOT NULL,
	"request" text,
	"principal" text,
	"trigger" text,
	"cursor" text,
	"state" jsonb,
	"pause" jsonb,
	"attempt" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "flow_checkpoints_run_idx" ON "orchestrator_flow_checkpoints" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "flow_run_state_status_idx" ON "orchestrator_flow_run_state" USING btree ("status");--> statement-breakpoint
CREATE INDEX "flow_run_state_updated_idx" ON "orchestrator_flow_run_state" USING btree ("updated_at");
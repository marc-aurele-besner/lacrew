CREATE TABLE "orchestrator_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_flow_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "orchestrator_flow_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE INDEX "flow_runs_flow_idx" ON "orchestrator_flow_runs" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "flow_runs_started_idx" ON "orchestrator_flow_runs" USING btree ("started_at");
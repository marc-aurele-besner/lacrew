ALTER TABLE "orchestrator_flows" ADD COLUMN "scope_level" text;--> statement-breakpoint
ALTER TABLE "orchestrator_flows" ADD COLUMN "scope_ref" text;--> statement-breakpoint
ALTER TABLE "orchestrator_flow_runs" ADD COLUMN "principal" text;--> statement-breakpoint
CREATE INDEX "flows_scope_idx" ON "orchestrator_flows" USING btree ("scope_level","scope_ref");
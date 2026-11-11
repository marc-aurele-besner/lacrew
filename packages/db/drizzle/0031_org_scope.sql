ALTER TABLE "orchestrator_connector_asks" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_connector_modes" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_crew_bindings" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_crew_heartbeat_ticks" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_crew_heartbeats" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_reviews" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_rules" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_secrets" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_servers" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_tools" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_flow_checkpoints" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_flows" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_flow_run_state" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_flow_runs" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_human_gates" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_inference_budgets" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_inference_usage" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_inference_usage_events" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_meta" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_plan_requirements" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_agent_controls" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_intents" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_messages" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_sessions" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_tx_gas" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_webhook_deliveries" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_webhook_triggers" ADD COLUMN "org_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_connector_modes" DROP CONSTRAINT "connector_modes_scope_route";--> statement-breakpoint
ALTER TABLE "orchestrator_crew_heartbeat_ticks" DROP CONSTRAINT "crew_heartbeat_ticks_window_uq";--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_secrets" DROP CONSTRAINT "external_mcp_secrets_owner_ref";--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_tools" DROP CONSTRAINT "external_mcp_tools_scope_server_tool";--> statement-breakpoint
ALTER TABLE "orchestrator_flow_checkpoints" DROP CONSTRAINT "flow_checkpoints_run_seq_uq";--> statement-breakpoint
ALTER TABLE "orchestrator_flow_run_state" DROP CONSTRAINT "flow_run_state_parent_step_uq";--> statement-breakpoint
ALTER TABLE "orchestrator_flow_runs" DROP CONSTRAINT "orchestrator_flow_runs_run_id_unique";--> statement-breakpoint
ALTER TABLE "orchestrator_inference_usage" DROP CONSTRAINT "inference_usage_scope_period";--> statement-breakpoint
ALTER TABLE "orchestrator_webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_key_uq";--> statement-breakpoint
DROP INDEX "audit_events_at_idx";--> statement-breakpoint
DROP INDEX "audit_events_chain_at_idx";--> statement-breakpoint
DROP INDEX "audit_events_ledger_at_idx";--> statement-breakpoint
DROP INDEX "audit_events_chain_tx_log_idx";--> statement-breakpoint
DROP INDEX "connector_asks_question_idx";--> statement-breakpoint
DROP INDEX "connector_asks_status_idx";--> statement-breakpoint
DROP INDEX "crew_bindings_account_idx";--> statement-breakpoint
DROP INDEX "crew_heartbeat_ticks_started_idx";--> statement-breakpoint
DROP INDEX "dual_control_question_idx";--> statement-breakpoint
DROP INDEX "dual_control_status_idx";--> statement-breakpoint
DROP INDEX "dual_control_run_idx";--> statement-breakpoint
DROP INDEX "external_mcp_servers_owner_idx";--> statement-breakpoint
DROP INDEX "external_mcp_tools_server_idx";--> statement-breakpoint
DROP INDEX "flow_checkpoints_run_idx";--> statement-breakpoint
DROP INDEX "flows_scope_idx";--> statement-breakpoint
DROP INDEX "flow_run_state_status_idx";--> statement-breakpoint
DROP INDEX "flow_run_state_updated_idx";--> statement-breakpoint
DROP INDEX "flow_runs_flow_idx";--> statement-breakpoint
DROP INDEX "flow_runs_started_idx";--> statement-breakpoint
DROP INDEX "human_gates_question_idx";--> statement-breakpoint
DROP INDEX "human_gates_status_idx";--> statement-breakpoint
DROP INDEX "human_gates_run_idx";--> statement-breakpoint
DROP INDEX "inference_budgets_crew_idx";--> statement-breakpoint
DROP INDEX "inference_usage_events_scope_idx";--> statement-breakpoint
DROP INDEX "inference_usage_events_at_idx";--> statement-breakpoint
DROP INDEX "intents_intent_idx";--> statement-breakpoint
DROP INDEX "intents_proposed_idx";--> statement-breakpoint
DROP INDEX "intents_status_idx";--> statement-breakpoint
DROP INDEX "messages_thread_idx";--> statement-breakpoint
DROP INDEX "sessions_issued_idx";--> statement-breakpoint
DROP INDEX "tx_gas_chain_tx_op_idx";--> statement-breakpoint
DROP INDEX "tx_gas_chain_at_idx";--> statement-breakpoint
DROP INDEX "webhook_deliveries_at_idx";--> statement-breakpoint
DROP INDEX "webhook_triggers_flow_idx";--> statement-breakpoint
ALTER TABLE "orchestrator_sessions" DROP CONSTRAINT "orchestrator_sessions_key_id_ledger_pk";--> statement-breakpoint
ALTER TABLE "orchestrator_audit_events" ALTER COLUMN "org_id" SET DEFAULT 'default';--> statement-breakpoint
UPDATE "orchestrator_audit_events" SET "org_id" = 'default' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_audit_events" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_connector_asks" DROP CONSTRAINT "orchestrator_connector_asks_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_crew_bindings" DROP CONSTRAINT "orchestrator_crew_bindings_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_crew_heartbeats" DROP CONSTRAINT "orchestrator_crew_heartbeats_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_reviews" DROP CONSTRAINT "orchestrator_dual_control_reviews_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_rules" DROP CONSTRAINT "orchestrator_dual_control_rules_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_servers" DROP CONSTRAINT "orchestrator_external_mcp_servers_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_flows" DROP CONSTRAINT "orchestrator_flows_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_flow_run_state" DROP CONSTRAINT "orchestrator_flow_run_state_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_human_gates" DROP CONSTRAINT "orchestrator_human_gates_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_inference_budgets" DROP CONSTRAINT "orchestrator_inference_budgets_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_meta" DROP CONSTRAINT "orchestrator_meta_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_plan_requirements" DROP CONSTRAINT "orchestrator_plan_requirements_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_agent_controls" DROP CONSTRAINT "orchestrator_agent_controls_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_messages" DROP CONSTRAINT "orchestrator_messages_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_webhook_triggers" DROP CONSTRAINT "orchestrator_webhook_triggers_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_connector_asks" ADD CONSTRAINT "orchestrator_connector_asks_org_id_id_pk" PRIMARY KEY("org_id","id");--> statement-breakpoint
ALTER TABLE "orchestrator_crew_bindings" ADD CONSTRAINT "orchestrator_crew_bindings_org_id_key_pk" PRIMARY KEY("org_id","key");--> statement-breakpoint
ALTER TABLE "orchestrator_crew_heartbeats" ADD CONSTRAINT "orchestrator_crew_heartbeats_org_id_crew_id_pk" PRIMARY KEY("org_id","crew_id");--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_reviews" ADD CONSTRAINT "orchestrator_dual_control_reviews_org_id_id_pk" PRIMARY KEY("org_id","id");--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_rules" ADD CONSTRAINT "orchestrator_dual_control_rules_org_id_scope_key_pk" PRIMARY KEY("org_id","scope_key");--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_servers" ADD CONSTRAINT "orchestrator_external_mcp_servers_org_id_id_pk" PRIMARY KEY("org_id","id");--> statement-breakpoint
ALTER TABLE "orchestrator_flows" ADD CONSTRAINT "orchestrator_flows_org_id_id_pk" PRIMARY KEY("org_id","id");--> statement-breakpoint
ALTER TABLE "orchestrator_flow_run_state" ADD CONSTRAINT "orchestrator_flow_run_state_org_id_run_id_pk" PRIMARY KEY("org_id","run_id");--> statement-breakpoint
ALTER TABLE "orchestrator_human_gates" ADD CONSTRAINT "orchestrator_human_gates_org_id_id_pk" PRIMARY KEY("org_id","id");--> statement-breakpoint
ALTER TABLE "orchestrator_inference_budgets" ADD CONSTRAINT "orchestrator_inference_budgets_org_id_scope_key_pk" PRIMARY KEY("org_id","scope_key");--> statement-breakpoint
ALTER TABLE "orchestrator_meta" ADD CONSTRAINT "orchestrator_meta_org_id_key_pk" PRIMARY KEY("org_id","key");--> statement-breakpoint
ALTER TABLE "orchestrator_plan_requirements" ADD CONSTRAINT "orchestrator_plan_requirements_org_id_scope_key_pk" PRIMARY KEY("org_id","scope_key");--> statement-breakpoint
ALTER TABLE "orchestrator_agent_controls" ADD CONSTRAINT "orchestrator_agent_controls_org_id_agent_pk" PRIMARY KEY("org_id","agent");--> statement-breakpoint
ALTER TABLE "orchestrator_messages" ADD CONSTRAINT "orchestrator_messages_org_id_id_pk" PRIMARY KEY("org_id","id");--> statement-breakpoint
ALTER TABLE "orchestrator_sessions" ADD CONSTRAINT "orchestrator_sessions_org_id_key_id_ledger_pk" PRIMARY KEY("org_id","key_id","ledger");--> statement-breakpoint
ALTER TABLE "orchestrator_webhook_triggers" ADD CONSTRAINT "orchestrator_webhook_triggers_org_id_id_pk" PRIMARY KEY("org_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "orchestrator_audit_events" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_chain_at_idx" ON "orchestrator_audit_events" USING btree ("org_id","chain_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_ledger_at_idx" ON "orchestrator_audit_events" USING btree ("org_id","ledger","at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_chain_tx_log_idx" ON "orchestrator_audit_events" USING btree ("org_id","chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "connector_asks_question_idx" ON "orchestrator_connector_asks" USING btree ("org_id","question_id");--> statement-breakpoint
CREATE INDEX "connector_asks_status_idx" ON "orchestrator_connector_asks" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "crew_bindings_account_idx" ON "orchestrator_crew_bindings" USING btree ("org_id","account");--> statement-breakpoint
CREATE INDEX "crew_heartbeat_ticks_started_idx" ON "orchestrator_crew_heartbeat_ticks" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "dual_control_question_idx" ON "orchestrator_dual_control_reviews" USING btree ("org_id","question_id");--> statement-breakpoint
CREATE INDEX "dual_control_status_idx" ON "orchestrator_dual_control_reviews" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "dual_control_run_idx" ON "orchestrator_dual_control_reviews" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "external_mcp_servers_owner_idx" ON "orchestrator_external_mcp_servers" USING btree ("org_id","owner_key");--> statement-breakpoint
CREATE INDEX "external_mcp_tools_server_idx" ON "orchestrator_external_mcp_tools" USING btree ("org_id","server");--> statement-breakpoint
CREATE INDEX "flow_checkpoints_run_idx" ON "orchestrator_flow_checkpoints" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "flows_scope_idx" ON "orchestrator_flows" USING btree ("org_id","scope_level","scope_ref");--> statement-breakpoint
CREATE INDEX "flow_run_state_status_idx" ON "orchestrator_flow_run_state" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "flow_run_state_updated_idx" ON "orchestrator_flow_run_state" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "flow_runs_flow_idx" ON "orchestrator_flow_runs" USING btree ("org_id","flow_id");--> statement-breakpoint
CREATE INDEX "flow_runs_started_idx" ON "orchestrator_flow_runs" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "human_gates_question_idx" ON "orchestrator_human_gates" USING btree ("org_id","question_id");--> statement-breakpoint
CREATE INDEX "human_gates_status_idx" ON "orchestrator_human_gates" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "human_gates_run_idx" ON "orchestrator_human_gates" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "inference_budgets_crew_idx" ON "orchestrator_inference_budgets" USING btree ("org_id","crew_id");--> statement-breakpoint
CREATE INDEX "inference_usage_events_scope_idx" ON "orchestrator_inference_usage_events" USING btree ("org_id","scope_key","period_key");--> statement-breakpoint
CREATE INDEX "inference_usage_events_at_idx" ON "orchestrator_inference_usage_events" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "intents_intent_idx" ON "orchestrator_intents" USING btree ("org_id","intent_id");--> statement-breakpoint
CREATE INDEX "intents_proposed_idx" ON "orchestrator_intents" USING btree ("org_id","proposed_at");--> statement-breakpoint
CREATE INDEX "intents_status_idx" ON "orchestrator_intents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "orchestrator_messages" USING btree ("org_id","thread_id","at");--> statement-breakpoint
CREATE INDEX "sessions_issued_idx" ON "orchestrator_sessions" USING btree ("org_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tx_gas_chain_tx_op_idx" ON "orchestrator_tx_gas" USING btree ("org_id","chain_id","tx_hash","user_op_hash");--> statement-breakpoint
CREATE INDEX "tx_gas_chain_at_idx" ON "orchestrator_tx_gas" USING btree ("org_id","chain_id","at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_at_idx" ON "orchestrator_webhook_deliveries" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "webhook_triggers_flow_idx" ON "orchestrator_webhook_triggers" USING btree ("org_id","flow_id");--> statement-breakpoint
ALTER TABLE "orchestrator_connector_modes" ADD CONSTRAINT "connector_modes_scope_route" UNIQUE("org_id","scope_key","route");--> statement-breakpoint
ALTER TABLE "orchestrator_crew_heartbeat_ticks" ADD CONSTRAINT "crew_heartbeat_ticks_window_uq" UNIQUE("org_id","crew_id","window_key");--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_secrets" ADD CONSTRAINT "external_mcp_secrets_owner_ref" UNIQUE("org_id","owner_key","ref");--> statement-breakpoint
ALTER TABLE "orchestrator_external_mcp_tools" ADD CONSTRAINT "external_mcp_tools_scope_server_tool" UNIQUE("org_id","scope_key","server","tool");--> statement-breakpoint
ALTER TABLE "orchestrator_flow_checkpoints" ADD CONSTRAINT "flow_checkpoints_run_seq_uq" UNIQUE("org_id","run_id","seq");--> statement-breakpoint
ALTER TABLE "orchestrator_flow_run_state" ADD CONSTRAINT "flow_run_state_parent_step_uq" UNIQUE("org_id","parent_run_id","parent_step_id");--> statement-breakpoint
ALTER TABLE "orchestrator_flow_runs" ADD CONSTRAINT "flow_runs_org_run_uq" UNIQUE("org_id","run_id");--> statement-breakpoint
ALTER TABLE "orchestrator_inference_usage" ADD CONSTRAINT "inference_usage_scope_period" UNIQUE("org_id","scope_key","period_key");--> statement-breakpoint
ALTER TABLE "orchestrator_webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_key_uq" UNIQUE("org_id","trigger_id","delivery_key");
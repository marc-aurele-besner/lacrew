ALTER TABLE "orchestrator_audit_events" ADD COLUMN "tx_hash" text;--> statement-breakpoint
ALTER TABLE "orchestrator_audit_events" ADD COLUMN "log_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_tx_log_idx" ON "orchestrator_audit_events" USING btree ("tx_hash","log_index");
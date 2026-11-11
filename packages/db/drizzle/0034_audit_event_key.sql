ALTER TABLE "orchestrator_audit_events" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "orchestrator_audit_events" ADD COLUMN "event_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_key_idx" ON "orchestrator_audit_events" USING btree ("org_id","ledger","event_key","event_index");
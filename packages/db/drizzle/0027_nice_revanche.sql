DROP INDEX "audit_events_tx_log_idx";--> statement-breakpoint
ALTER TABLE "orchestrator_audit_events" ADD COLUMN "chain_id" integer;--> statement-breakpoint
-- Every row written before this column existed came from the Anvil-era
-- single-chain stack (indexer and orchestrator both defaulted CHAIN_ID to
-- 31337), so the history is attributed to that chain rather than left as an
-- unqueryable pre-chain remainder. New rows carry their own chain id (or
-- NULL only for runtime rows with no chain at all, e.g. mock mode).
UPDATE "orchestrator_audit_events" SET "chain_id" = 31337 WHERE "chain_id" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_events_chain_at_idx" ON "orchestrator_audit_events" USING btree ("chain_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_chain_tx_log_idx" ON "orchestrator_audit_events" USING btree ("chain_id","tx_hash","log_index");
DROP INDEX "tx_gas_chain_tx_idx";--> statement-breakpoint
ALTER TABLE "orchestrator_tx_gas" ADD COLUMN "user_op_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_tx_gas" ADD COLUMN "payer" text DEFAULT 'orchestrator' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_tx_gas" ADD COLUMN "paymaster" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tx_gas_chain_tx_op_idx" ON "orchestrator_tx_gas" USING btree ("chain_id","tx_hash","user_op_hash");
CREATE TABLE "orchestrator_tx_gas" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"sender" text,
	"agent" text,
	"status" text NOT NULL,
	"gas_used" numeric(78, 0) NOT NULL,
	"effective_gas_price" numeric(78, 0),
	"l1_fee_wei" numeric(78, 0),
	"fee_wei" numeric(78, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tx_gas_chain_tx_idx" ON "orchestrator_tx_gas" USING btree ("chain_id","tx_hash");--> statement-breakpoint
CREATE INDEX "tx_gas_chain_at_idx" ON "orchestrator_tx_gas" USING btree ("chain_id","at");
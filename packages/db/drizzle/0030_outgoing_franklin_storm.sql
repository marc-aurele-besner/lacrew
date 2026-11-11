CREATE TABLE "orchestrator_sandbox_state" (
	"org_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"state" jsonb NOT NULL,
	"clock_offset" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestrator_audit_events" ADD COLUMN "ledger" text DEFAULT 'chain' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_intents" ADD COLUMN "sim_tx_id" text;--> statement-breakpoint
ALTER TABLE "orchestrator_intents" ADD COLUMN "resolve_sim_tx_id" text;--> statement-breakpoint
ALTER TABLE "orchestrator_intents" ADD COLUMN "ledger" text DEFAULT 'chain' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_sessions" ADD COLUMN "ledger" text DEFAULT 'chain' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_sessions" DROP CONSTRAINT "orchestrator_sessions_pkey";--> statement-breakpoint
ALTER TABLE "orchestrator_sessions" ADD CONSTRAINT "orchestrator_sessions_key_id_ledger_pk" PRIMARY KEY("key_id","ledger");--> statement-breakpoint
CREATE INDEX "audit_events_ledger_at_idx" ON "orchestrator_audit_events" USING btree ("ledger","at");

CREATE TABLE "orchestrator_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"agent" text NOT NULL,
	"target" text NOT NULL,
	"value" text NOT NULL,
	"verdict" text NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"resolve_tx_hash" text,
	"session_key_id" text,
	"chain_id" integer,
	"proposed_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orchestrator_sessions" (
	"key_id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"key_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" jsonb NOT NULL,
	"max_value" text,
	"allowed_target" text,
	"mode" text NOT NULL,
	"chain_id" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "intents_intent_idx" ON "orchestrator_intents" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "intents_proposed_idx" ON "orchestrator_intents" USING btree ("proposed_at");--> statement-breakpoint
CREATE INDEX "intents_status_idx" ON "orchestrator_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_issued_idx" ON "orchestrator_sessions" USING btree ("issued_at");
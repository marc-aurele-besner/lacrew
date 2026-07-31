CREATE TABLE "orchestrator_inference_budgets" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"crew_id" text NOT NULL,
	"agent_id" text,
	"period" text NOT NULL,
	"window_days" integer,
	"epoch_seconds" integer,
	"anchor_at" timestamp with time zone,
	"limits" jsonb NOT NULL,
	"policy" text NOT NULL,
	"cheap_model" text,
	"pause_heartbeat_on_breach" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_inference_usage" (
	"scope_key" text NOT NULL,
	"period_key" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"usd_micros" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"unpriced_calls" integer DEFAULT 0 NOT NULL,
	"alerted_state" text DEFAULT 'ok' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_usage_scope_period" UNIQUE("scope_key","period_key")
);
--> statement-breakpoint
CREATE TABLE "orchestrator_inference_usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"period_key" text NOT NULL,
	"model" text NOT NULL,
	"provider" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"usd_micros" bigint,
	"price_source" text NOT NULL,
	"tokens_estimated" boolean DEFAULT false NOT NULL,
	"run_id" text,
	"flow_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "inference_budgets_crew_idx" ON "orchestrator_inference_budgets" USING btree ("crew_id");--> statement-breakpoint
CREATE INDEX "inference_usage_events_scope_idx" ON "orchestrator_inference_usage_events" USING btree ("scope_key","period_key");--> statement-breakpoint
CREATE INDEX "inference_usage_events_at_idx" ON "orchestrator_inference_usage_events" USING btree ("at");
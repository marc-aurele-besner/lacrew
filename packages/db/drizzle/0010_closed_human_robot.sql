CREATE TABLE "orchestrator_webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"delivery_key" text NOT NULL,
	"result" text NOT NULL,
	"reason" text,
	"run_id" text,
	"bytes" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_key_uq" UNIQUE("trigger_id","delivery_key")
);
--> statement-breakpoint
CREATE TABLE "orchestrator_webhook_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"principal" text,
	"scheme" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"input_map" jsonb,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_at_idx" ON "orchestrator_webhook_deliveries" USING btree ("at");--> statement-breakpoint
CREATE INDEX "webhook_triggers_flow_idx" ON "orchestrator_webhook_triggers" USING btree ("flow_id");
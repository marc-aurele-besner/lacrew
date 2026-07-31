CREATE TABLE "orchestrator_crew_heartbeat_ticks" (
	"crew_id" text NOT NULL,
	"window_key" text NOT NULL,
	"status" text NOT NULL,
	"items" jsonb,
	"message_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "crew_heartbeat_ticks_window_uq" UNIQUE("crew_id","window_key")
);
--> statement-breakpoint
CREATE TABLE "orchestrator_crew_heartbeats" (
	"crew_id" text PRIMARY KEY NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text,
	"quiet_hours" jsonb,
	"checklist" jsonb NOT NULL,
	"principal" text,
	"model" text,
	"notify_on_ok" boolean DEFAULT true NOT NULL,
	"stop_on_error" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crew_heartbeat_ticks_started_idx" ON "orchestrator_crew_heartbeat_ticks" USING btree ("started_at");
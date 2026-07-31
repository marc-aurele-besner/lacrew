CREATE TABLE "orchestrator_plan_requirements" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"mode" text NOT NULL,
	"window_ms" integer NOT NULL,
	"min_plan_chars" integer NOT NULL,
	"accept_upstream_plan" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "orchestrator_orgs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"chain_id" integer,
	"addresses" jsonb,
	"seats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

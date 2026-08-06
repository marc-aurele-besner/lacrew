CREATE TABLE "orchestrator_external_mcp_secrets" (
	"owner_key" text NOT NULL,
	"ref" text NOT NULL,
	"sealed" text NOT NULL,
	"hint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_mcp_secrets_owner_ref" UNIQUE("owner_key","ref")
);

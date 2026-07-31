CREATE TABLE "orchestrator_external_mcp_tools" (
	"scope_key" text NOT NULL,
	"scope" jsonb NOT NULL,
	"server" text NOT NULL,
	"tool" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"effect" text,
	"mode" text,
	"description" text,
	"discovered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_mcp_tools_scope_server_tool" UNIQUE("scope_key","server","tool")
);
--> statement-breakpoint
CREATE INDEX "external_mcp_tools_server_idx" ON "orchestrator_external_mcp_tools" USING btree ("server");
CREATE TABLE "orchestrator_external_mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"owner_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "external_mcp_servers_owner_idx" ON "orchestrator_external_mcp_servers" USING btree ("owner_key");
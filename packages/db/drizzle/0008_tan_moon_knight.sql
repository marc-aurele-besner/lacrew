CREATE TABLE "orchestrator_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"author" text NOT NULL,
	"author_kind" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"options" jsonb,
	"reply_to" text,
	"recipient" text,
	"refs" jsonb
);
--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "orchestrator_messages" USING btree ("thread_id","at");
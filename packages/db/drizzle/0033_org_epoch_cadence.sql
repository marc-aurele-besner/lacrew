ALTER TABLE "orchestrator_orgs" ADD COLUMN "epoch_cron" text;--> statement-breakpoint
ALTER TABLE "orchestrator_orgs" ADD COLUMN "epoch_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orchestrator_orgs" ADD COLUMN "epoch_due_at" timestamp with time zone;
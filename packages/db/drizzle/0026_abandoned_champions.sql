ALTER TABLE "orchestrator_dual_control_reviews" ADD COLUMN "review_scope" text DEFAULT 'per_effect' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_reviews" ADD COLUMN "released" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrator_dual_control_rules" ADD COLUMN "review_scope" text DEFAULT 'per_effect' NOT NULL;
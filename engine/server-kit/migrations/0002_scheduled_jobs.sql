CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"singleton_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"due_at_ms" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"promoted_at" timestamp with time zone,
	CONSTRAINT "scheduled_jobs_name_key_unique" UNIQUE("name","singleton_key"),
	CONSTRAINT "scheduled_jobs_name" CHECK (length("scheduled_jobs"."name") > 0),
	CONSTRAINT "scheduled_jobs_singleton_key" CHECK (length("scheduled_jobs"."singleton_key") > 0),
	CONSTRAINT "scheduled_jobs_due_at_ms" CHECK ("scheduled_jobs"."due_at_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("due_at_ms") WHERE "scheduled_jobs"."promoted_at" IS NULL;
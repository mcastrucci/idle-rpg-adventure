CREATE TABLE IF NOT EXISTS "live_instances" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"game_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"participants" jsonb NOT NULL,
	"status" text NOT NULL,
	"node_id" text NOT NULL,
	"lease_generation" integer NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"checkpoint_seq" integer NOT NULL,
	"outcome" text,
	"result" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "live_instances_status" CHECK ("live_instances"."status" IN ('active', 'closed')),
	CONSTRAINT "live_instances_closed" CHECK (("live_instances"."status" = 'closed') = ("live_instances"."closed_at" IS NOT NULL)),
	CONSTRAINT "live_instances_participants" CHECK (jsonb_typeof("live_instances"."participants") = 'array' AND jsonb_array_length("live_instances"."participants") > 0),
	CONSTRAINT "live_instances_generation" CHECK ("live_instances"."lease_generation" >= 1),
	CONSTRAINT "live_instances_checkpoint_seq" CHECK ("live_instances"."checkpoint_seq" >= 0),
	CONSTRAINT "live_instances_ids" CHECK (length("live_instances"."game_id") > 0 AND length("live_instances"."node_id") > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_instances_lease_idx" ON "live_instances" USING btree ("lease_expires_at") WHERE "live_instances"."status" = 'active';
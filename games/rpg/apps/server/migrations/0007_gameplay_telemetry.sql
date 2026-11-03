CREATE TABLE "rpg_live_entries" (
  "instance_id" uuid NOT NULL REFERENCES "live_instances"("instance_id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "rpg_characters"("actor_id") ON DELETE CASCADE,
  "area_id" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  CONSTRAINT "rpg_live_entries_pkey" PRIMARY KEY ("instance_id", "actor_id"),
  CONSTRAINT "rpg_live_entries_area" CHECK (length("area_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "rpg_live_xp_events" (
  "instance_id" uuid NOT NULL REFERENCES "live_instances"("instance_id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "rpg_characters"("actor_id") ON DELETE CASCADE,
  "source_id" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "granted_xp" bigint NOT NULL,
  CONSTRAINT "rpg_live_xp_events_semantic_key" PRIMARY KEY ("instance_id", "actor_id", "source_id"),
  CONSTRAINT "rpg_live_xp_events_source" CHECK (length("source_id") > 0),
  CONSTRAINT "rpg_live_xp_events_granted_xp" CHECK ("granted_xp" > 0 AND "granted_xp" <= 9007199254740991)
);

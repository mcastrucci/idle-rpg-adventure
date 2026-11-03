CREATE TABLE "rpg_live_deaths" (
  "death_id" uuid PRIMARY KEY NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "rpg_characters"("actor_id") ON DELETE CASCADE,
  "instance_id" uuid NOT NULL,
  "area_id" text NOT NULL,
  "location_id" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL,
  "xp_before_level" integer NOT NULL,
  "xp_before_into_level" integer NOT NULL,
  "xp_before_total" integer NOT NULL,
  "xp_lost" integer NOT NULL,
  "xp_after_level" integer NOT NULL,
  "xp_after_into_level" integer NOT NULL,
  "xp_after_total" integer NOT NULL,
  "causes" jsonb NOT NULL,
  "bag_snapshot" jsonb NOT NULL,
  CONSTRAINT "rpg_live_deaths_status" CHECK ("status" IN ('active','recovered','expired','invalidated')),
  CONSTRAINT "rpg_live_deaths_xp" CHECK ("xp_before_level" >= 1 AND "xp_before_into_level" >= 0 AND "xp_before_total" >= 0 AND "xp_lost" >= 0 AND "xp_after_level" >= 1 AND "xp_after_into_level" >= 0 AND "xp_after_total" >= 0),
  CONSTRAINT "rpg_live_deaths_instance_actor" UNIQUE ("instance_id", "actor_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rpg_live_deaths_one_active_actor" ON "rpg_live_deaths" ("actor_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "rpg_live_deaths_actor_recent" ON "rpg_live_deaths" ("actor_id", "occurred_at" DESC);

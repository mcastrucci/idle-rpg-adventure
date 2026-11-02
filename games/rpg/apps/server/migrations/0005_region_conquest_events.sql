CREATE TABLE "rpg_region_conquered_events" (
	"actor_id" uuid NOT NULL,
	"area_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rpg_region_conquered_events_pk" UNIQUE("actor_id","area_id")
);
--> statement-breakpoint
ALTER TABLE "rpg_region_conquered_events" ADD CONSTRAINT "rpg_region_conquered_events_actor_id_rpg_characters_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."rpg_characters"("actor_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "rpg_region_conquered_events" ("actor_id", "area_id", "occurred_at")
SELECT "actor_id", "area_id", "completed_at" FROM "rpg_completed_areas"
ON CONFLICT ("actor_id", "area_id") DO NOTHING;

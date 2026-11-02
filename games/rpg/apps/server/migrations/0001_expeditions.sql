CREATE TABLE "rpg_expeditions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"area_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"status" text NOT NULL,
	"starts_at_ms" bigint NOT NULL,
	"planned_ends_at_ms" bigint NOT NULL,
	"ends_at_ms" bigint NOT NULL,
	"duration_min" integer NOT NULL,
	"pace_bp" integer NOT NULL,
	"seed" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"kernel_version" text NOT NULL,
	"simulator_id" text NOT NULL,
	"simulator_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"budget" integer NOT NULL,
	"config" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"escrow" jsonb NOT NULL,
	"timeline_compressed" text NOT NULL,
	"timeline_hash" text NOT NULL,
	"settled_at" timestamp with time zone,
	"settled_reason" text,
	"settled_cutoff" integer,
	"outcome" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rpg_expeditions_status" CHECK ("rpg_expeditions"."status" IN ('running', 'completed', 'cancelled')),
	CONSTRAINT "rpg_expeditions_times" CHECK ("rpg_expeditions"."starts_at_ms" >= 0 AND "rpg_expeditions"."planned_ends_at_ms" >= "rpg_expeditions"."starts_at_ms" AND "rpg_expeditions"."ends_at_ms" >= "rpg_expeditions"."starts_at_ms" AND "rpg_expeditions"."ends_at_ms" <= "rpg_expeditions"."planned_ends_at_ms"),
	CONSTRAINT "rpg_expeditions_parameters" CHECK ("rpg_expeditions"."duration_min" > 0 AND "rpg_expeditions"."pace_bp" > 0 AND "rpg_expeditions"."budget" > 0 AND "rpg_expeditions"."revision" >= 0),
	CONSTRAINT "rpg_expeditions_snapshot" CHECK (jsonb_typeof("rpg_expeditions"."config") = 'object' AND jsonb_typeof("rpg_expeditions"."snapshot") = 'object' AND jsonb_typeof("rpg_expeditions"."escrow") = 'array')
);
--> statement-breakpoint
CREATE TABLE "rpg_actor_objectives" (
	"actor_id" uuid NOT NULL,
	"objective_key" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rpg_actor_objectives_pk" UNIQUE("actor_id","objective_key")
);
--> statement-breakpoint
CREATE TABLE "rpg_area_discoveries" (
	"actor_id" uuid NOT NULL,
	"area_id" text NOT NULL,
	"location_id" text NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rpg_area_discoveries_pk" UNIQUE("actor_id","area_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "rpg_completed_areas" (
	"actor_id" uuid NOT NULL,
	"area_id" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rpg_completed_areas_pk" UNIQUE("actor_id","area_id")
);
--> statement-breakpoint
ALTER TABLE "rpg_expeditions" ADD CONSTRAINT "rpg_expeditions_actor_id_rpg_characters_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."rpg_characters"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rpg_actor_objectives" ADD CONSTRAINT "rpg_actor_objectives_actor_id_rpg_characters_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."rpg_characters"("actor_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rpg_area_discoveries" ADD CONSTRAINT "rpg_area_discoveries_actor_id_rpg_characters_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."rpg_characters"("actor_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rpg_completed_areas" ADD CONSTRAINT "rpg_completed_areas_actor_id_rpg_characters_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."rpg_characters"("actor_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rpg_expeditions_actor_created" ON "rpg_expeditions" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "rpg_expeditions_running_end" ON "rpg_expeditions" USING btree ("ends_at_ms") WHERE "rpg_expeditions"."status" = 'running';
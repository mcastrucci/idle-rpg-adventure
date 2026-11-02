CREATE TABLE "rpg_debug_clock" (
	"id" text PRIMARY KEY NOT NULL,
	"offset_ms" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rpg_debug_clock_singleton" CHECK ("rpg_debug_clock"."id" = 'environment'),
	CONSTRAINT "rpg_debug_clock_offset" CHECK ("rpg_debug_clock"."offset_ms" >= 0)
);

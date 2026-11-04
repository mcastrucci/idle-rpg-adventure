-- #129 follow-up: the XP curve is open-ended (levels up to the last safe-integer level, 132), so in-level XP and total XP
-- can exceed 32 bits (the in-level requirement passes 2,147,483,647 at level 71). Widen every persisted XP quantity.
-- Levels stay `integer`. int4 -> int8 is lossless, so existing rows are unchanged; the application keeps the values JS
-- safe integers (bigint columns use `mode: 'number'`, and the CHECKs below cap them at Number.MAX_SAFE_INTEGER).
ALTER TABLE "rpg_characters" ALTER COLUMN "xp" TYPE bigint;--> statement-breakpoint
ALTER TABLE "rpg_live_deaths" ALTER COLUMN "xp_before_into_level" TYPE bigint;--> statement-breakpoint
ALTER TABLE "rpg_live_deaths" ALTER COLUMN "xp_before_total" TYPE bigint;--> statement-breakpoint
ALTER TABLE "rpg_live_deaths" ALTER COLUMN "xp_lost" TYPE bigint;--> statement-breakpoint
ALTER TABLE "rpg_live_deaths" ALTER COLUMN "xp_after_into_level" TYPE bigint;--> statement-breakpoint
ALTER TABLE "rpg_live_deaths" ALTER COLUMN "xp_after_total" TYPE bigint;--> statement-breakpoint
ALTER TABLE "rpg_characters" DROP CONSTRAINT "rpg_characters_progress";--> statement-breakpoint
ALTER TABLE "rpg_characters" ADD CONSTRAINT "rpg_characters_progress" CHECK ("level" >= 1 AND "xp" >= 0 AND "xp" <= 9007199254740991 AND "unspent_points" >= 0);--> statement-breakpoint
ALTER TABLE "rpg_live_deaths" DROP CONSTRAINT "rpg_live_deaths_xp";--> statement-breakpoint
ALTER TABLE "rpg_live_deaths" ADD CONSTRAINT "rpg_live_deaths_xp" CHECK ("xp_before_level" >= 1 AND "xp_before_into_level" >= 0 AND "xp_before_total" >= 0 AND "xp_lost" >= 0 AND "xp_after_level" >= 1 AND "xp_after_into_level" >= 0 AND "xp_after_total" >= 0 AND "xp_before_into_level" <= 9007199254740991 AND "xp_before_total" <= 9007199254740991 AND "xp_lost" <= 9007199254740991 AND "xp_after_into_level" <= 9007199254740991 AND "xp_after_total" <= 9007199254740991);

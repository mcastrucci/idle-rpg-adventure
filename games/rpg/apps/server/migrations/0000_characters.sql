CREATE TABLE "rpg_characters" (
	"actor_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"game_id" text DEFAULT 'rpg' NOT NULL,
	"name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"attributes" jsonb NOT NULL,
	"unspent_points" integer DEFAULT 0 NOT NULL,
	"skill_loadout" jsonb NOT NULL,
	"automation_rules" jsonb NOT NULL,
	CONSTRAINT "rpg_characters_one_per_account_game" UNIQUE("account_id","game_id"),
	CONSTRAINT "rpg_characters_game" CHECK ("rpg_characters"."game_id" = 'rpg'),
	CONSTRAINT "rpg_characters_name" CHECK (length(trim("rpg_characters"."name")) BETWEEN 1 AND 32),
	CONSTRAINT "rpg_characters_progress" CHECK ("rpg_characters"."level" >= 1 AND "rpg_characters"."xp" >= 0 AND "rpg_characters"."unspent_points" >= 0),
	CONSTRAINT "rpg_characters_loadout" CHECK (jsonb_typeof("rpg_characters"."skill_loadout") = 'array' AND jsonb_array_length("rpg_characters"."skill_loadout") <= 4),
	CONSTRAINT "rpg_characters_rules" CHECK (jsonb_typeof("rpg_characters"."automation_rules") = 'array' AND jsonb_array_length("rpg_characters"."automation_rules") <= 6)
);
--> statement-breakpoint
ALTER TABLE "rpg_characters" ADD CONSTRAINT "rpg_characters_actor_owner_game" FOREIGN KEY ("actor_id","account_id","game_id") REFERENCES "public"."actors"("actor_id","account_id","game_id") ON DELETE no action ON UPDATE no action;
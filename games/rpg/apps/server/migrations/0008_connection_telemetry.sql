CREATE TABLE "rpg_connection_sessions" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "rpg_connection_sessions_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE,
	CONSTRAINT "rpg_connection_sessions_time_order" CHECK ("started_at" <= "last_seen_at" AND ("ended_at" IS NULL OR "last_seen_at" <= "ended_at"))
);
--> statement-breakpoint
CREATE INDEX "rpg_connection_sessions_account_idx" ON "rpg_connection_sessions" USING btree ("account_id");

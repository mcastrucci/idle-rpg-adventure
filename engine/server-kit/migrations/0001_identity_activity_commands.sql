CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	CONSTRAINT "email_credentials_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "guest_credentials" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "guest_credentials_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"session_hash" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"actor_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"game_id" text NOT NULL,
	"activity_state" text DEFAULT 'none' NOT NULL,
	"activity_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "actors_identity_owner_game" UNIQUE("actor_id","account_id","game_id"),
	CONSTRAINT "actors_game_id" CHECK (length("actors"."game_id") > 0),
	CONSTRAINT "actors_activity_state" CHECK ("actors"."activity_state" IN ('none', 'live', 'expedition')),
	CONSTRAINT "actors_activity_identity" CHECK (("actors"."activity_state" = 'none') = ("actors"."activity_id" IS NULL)),
	CONSTRAINT "actors_version" CHECK ("actors"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "command_log" (
	"account_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"response_status" integer,
	"response_body" text,
	"tombstoned_at" timestamp with time zone,
	CONSTRAINT "command_log_account_id_command_id_pk" PRIMARY KEY("account_id","command_id"),
	CONSTRAINT "command_log_fingerprint" CHECK ("command_log"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "command_log_response" CHECK (("command_log"."response_status" IS NULL AND "command_log"."response_body" IS NULL) OR ("command_log"."response_status" IS NOT NULL AND "command_log"."response_status" BETWEEN 200 AND 599 AND "command_log"."response_body" IS NOT NULL)),
	CONSTRAINT "command_log_tombstone" CHECK ("command_log"."tombstoned_at" IS NULL OR ("command_log"."response_status" IS NULL AND "command_log"."response_body" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_credentials" ADD CONSTRAINT "email_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_credentials" ADD CONSTRAINT "guest_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_session_hash_auth_sessions_token_hash_fk" FOREIGN KEY ("session_hash") REFERENCES "public"."auth_sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_account_idx" ON "auth_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "command_log_expiry_idx" ON "command_log" USING btree ("expires_at") WHERE "command_log"."tombstoned_at" IS NULL;
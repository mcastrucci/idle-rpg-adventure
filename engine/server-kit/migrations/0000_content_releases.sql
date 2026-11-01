CREATE TABLE "content_releases" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"format" integer NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "content_releases_hash" CHECK ("content_releases"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_releases_format" CHECK ("content_releases"."format" > 0)
);

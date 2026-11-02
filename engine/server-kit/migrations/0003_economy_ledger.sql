CREATE TABLE "asset_balances" (
	"actor_id" uuid NOT NULL,
	"asset_kind" text NOT NULL,
	"asset_ref" text NOT NULL,
	"container" text NOT NULL,
	"qty" integer NOT NULL,
	CONSTRAINT "asset_balances_actor_id_asset_kind_asset_ref_container_pk" PRIMARY KEY("actor_id","asset_kind","asset_ref","container"),
	CONSTRAINT "asset_balances_qty" CHECK ("asset_balances"."qty" >= 0),
	CONSTRAINT "asset_balances_kind" CHECK ("asset_balances"."asset_kind" IN ('stack', 'currency'))
);
--> statement-breakpoint
CREATE TABLE "item_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"definition" text NOT NULL,
	"container" text NOT NULL,
	"slot" text,
	"rolls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"seq" integer NOT NULL,
	"unit" integer NOT NULL,
	CONSTRAINT "item_instances_mint_key" UNIQUE("source_type","source_id","seq","unit"),
	CONSTRAINT "item_instances_seq" CHECK ("item_instances"."seq" >= 0),
	CONSTRAINT "item_instances_unit" CHECK ("item_instances"."unit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_batches" (
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"entry_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_batches_source_type_source_id_pk" PRIMARY KEY("source_type","source_id"),
	CONSTRAINT "ledger_batches_fingerprint" CHECK ("ledger_batches"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ledger_batches_count" CHECK ("ledger_batches"."entry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"asset_kind" text NOT NULL,
	"asset_ref" text NOT NULL,
	"qty" integer NOT NULL,
	"from_container" text,
	"to_container" text,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_source_seq" UNIQUE("source_type","source_id","seq"),
	CONSTRAINT "ledger_entries_asset_kind" CHECK ("ledger_entries"."asset_kind" IN ('stack', 'currency', 'unique', 'unique_mint')),
	CONSTRAINT "ledger_entries_qty" CHECK ("ledger_entries"."qty" <> 0),
	CONSTRAINT "ledger_entries_seq" CHECK ("ledger_entries"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "asset_balances" ADD CONSTRAINT "asset_balances_actor_id_actors_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_actor_id_actors_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_actor_id_actors_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION reject_economy_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'economy ledger rows are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_economy_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_batches_append_only BEFORE UPDATE OR DELETE ON ledger_batches
  FOR EACH ROW EXECUTE FUNCTION reject_economy_ledger_mutation();

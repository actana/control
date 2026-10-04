CREATE TABLE "api_key_cores" (
	"key_id" text NOT NULL,
	"core_id" text NOT NULL,
	"owner_id" integer NOT NULL,
	CONSTRAINT "api_key_cores_key_id_core_id_pk" PRIMARY KEY("key_id","core_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"all_cores" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_key_cores" ADD CONSTRAINT "api_key_cores_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_cores" ADD CONSTRAINT "api_key_cores_core_id_cores_id_fk" FOREIGN KEY ("core_id") REFERENCES "public"."cores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_cores" ADD CONSTRAINT "api_key_cores_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_owner_prefix_idx" ON "api_keys" USING btree ("owner_id","prefix");
--> statement-breakpoint
CREATE FUNCTION "api_keys_revocation_is_final"() RETURNS trigger AS $$
BEGIN
	IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
		RAISE EXCEPTION 'api_keys_revocation_is_final: a revoked API key stays revoked';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "api_keys_revocation_is_final" BEFORE UPDATE ON "api_keys" FOR EACH ROW EXECUTE FUNCTION "api_keys_revocation_is_final"();

CREATE TABLE "instance_mcp_servers" (
	"name" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"command" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cwd" text,
	"orgs" jsonb,
	"env_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_ciphertext" text NOT NULL,
	"env_wrapped_data_key" text NOT NULL,
	"env_kek_id" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_mcp_servers" ADD CONSTRAINT "instance_mcp_servers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
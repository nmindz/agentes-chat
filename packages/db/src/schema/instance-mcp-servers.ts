import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * MCP servers this server runs itself (stdio) that its owner added in Settings (`MCP_STDIO_EDITABLE`), beside the
 * operator's file (`MCP_STDIO_SERVERS`). Not a tenant's, so no `org_id`: `orgs` names the workspaces it is offered
 * to. The variables are sealed like provider keys (ADR 0007), only their names kept in the clear.
 */
export const instanceMcpServers = pgTable("instance_mcp_servers", {
  /** The `stdio://<name>` a workspace connects. */
  name: text().primaryKey(),
  label: text().notNull(),
  description: text(),
  command: text().notNull(),
  args: jsonb().$type<string[]>().notNull().default([]),
  cwd: text(),
  /** Workspace ids; null: every workspace on this server. */
  orgs: jsonb().$type<string[]>(),
  /** The variables' names, in order: the only part ever shown. */
  envNames: jsonb().$type<string[]>().notNull().default([]),
  /** The variables as sealed JSON (`Record<string, string>`). */
  envCiphertext: text().notNull(),
  envWrappedDataKey: text().notNull(),
  envKekId: text().notNull(),
  updatedBy: text().references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

import { isAbsolute } from "node:path";
import type { KeyWrapper, PubSub } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { openSecret, sealSecret } from "../crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import {
  STDIO_NAME,
  type StdioPool,
  type StdioServer,
  type StdioTestResult,
  setStoredStdioServers,
  stdioFileServers,
  stdioPool,
  stdioServers,
  stdioUrl,
  testStdioServer,
} from "./stdio";

const { instanceMcpServers, organizations } = schema;

/**
 * The MCP servers this server runs (stdio) that its owner adds in Settings, beside the operator's file
 * (`MCP_STDIO_SERVERS`). Only with `MCP_STDIO_EDITABLE` on: the routes say who may (the pinned owner, ADR 0073, never
 * on agentes.chat Cloud). Every process keeps the list in memory and reads it again when one of them changes it.
 */

/** A server as its owner sees it: never a variable's value, only its name. */
export interface McpServerView {
  name: string;
  address: string;
  label: string;
  description: string | null;
  command: string;
  args: string[];
  cwd: string | null;
  /** Workspace ids; null: every workspace here. */
  orgs: string[] | null;
  env: string[];
  /** `env`: the operator's file, read-only here. `settings`: added in Settings. */
  source: "env" | "settings";
  /** `invalid`: its variables don't open on this server (another `AGENTES_SECRET`), so it isn't offered. */
  state: "ok" | "invalid";
  updatedAt: string | null;
}

export interface McpServersView {
  /** Whether servers may be added here (`MCP_STDIO_EDITABLE`). */
  editable: boolean;
  servers: McpServerView[];
}

export interface McpServerDraft {
  label?: string | null;
  description?: string | null;
  command: string;
  args: string[];
  cwd?: string | null;
  orgs: string[] | null;
  /** A variable without a value keeps the one already saved under its name. */
  env: { name: string; value?: string }[];
}

export interface StdioSettings {
  /** Reads the saved servers (none while not editable) and follows changes made by any process. */
  start(): Promise<() => void>;
  view(): Promise<McpServersView>;
  save(name: string, draft: McpServerDraft, userId: string): Promise<McpServerView>;
  remove(name: string, userId: string): Promise<void>;
  /** Starts the server once and lists its tools, whichever list it is on. */
  test(name: string): Promise<StdioTestResult>;
}

export const MCP_SERVERS_TOPIC = "system:mcp-stdio";
const AAD = (name: string) => `instance-mcp-server|${name}`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LIMITS = { label: 80, description: 300, command: 1000, args: 100, arg: 4000, env: 100, value: 10_000, orgs: 500 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message: string) => new ValidationError(message, "mcp_server_invalid");
const noControl = (s: string) => !/[\0\r\n]/.test(s);

/** The draft, checked and trimmed; variables still to merge with the saved ones. */
function checked(name: string, draft: McpServerDraft) {
  if (!STDIO_NAME.test(name)) throw invalid("A name has letters, digits, - and _ only, 64 at most.");
  const command = draft.command.trim();
  if (!command || command.length > LIMITS.command || !noControl(command)) throw invalid("Say the command to run.");
  if (draft.args.length > LIMITS.args || draft.args.some((a) => a.length > LIMITS.arg || a.includes("\0")))
    throw invalid(`At most ${LIMITS.args} arguments.`);
  const cwd = draft.cwd?.trim() || null;
  if (cwd && (!isAbsolute(cwd) || !noControl(cwd))) throw invalid("The folder is a full path, as /srv/mcp.");
  const label = draft.label?.trim().slice(0, LIMITS.label) || name;
  const description = draft.description?.trim().slice(0, LIMITS.description) || null;
  const orgs = draft.orgs === null ? null : [...new Set(draft.orgs)];
  if (orgs && (orgs.length === 0 || orgs.length > LIMITS.orgs || !orgs.every((o) => UUID.test(o))))
    throw invalid("Pick at least one workspace, or every workspace.");
  if (draft.env.length > LIMITS.env) throw invalid(`At most ${LIMITS.env} variables.`);
  const seen = new Set<string>();
  for (const v of draft.env) {
    if (!ENV_NAME.test(v.name)) throw invalid(`"${v.name}" isn't a variable name (letters, digits and _).`);
    if (seen.has(v.name)) throw invalid(`"${v.name}" is there twice.`);
    seen.add(v.name);
    if (v.value !== undefined && (v.value.length > LIMITS.value || v.value.includes("\0")))
      throw invalid(`"${v.name}" is too long.`);
  }
  return { command, args: draft.args, cwd, label, description, orgs };
}

const fileView = (s: StdioServer): McpServerView => ({
  name: s.name,
  address: stdioUrl(s.name),
  label: s.label,
  description: s.description ?? null,
  command: s.command,
  args: s.args,
  cwd: s.cwd ?? null,
  orgs: s.orgs ?? null,
  env: Object.keys(s.env),
  source: "env",
  state: "ok",
  updatedAt: null,
});

type Row = typeof instanceMcpServers.$inferSelect;

export function createStdioSettings(deps: {
  db: Database;
  keyWrapper: KeyWrapper;
  keyWrappers: KeyWrapper[];
  editable: boolean;
  pubsub?: Pick<PubSub, "publish" | "subscribe">;
  pool?: StdioPool;
  log?: (message: string) => void;
}): StdioSettings {
  const pool = deps.pool ?? stdioPool;
  /** What each saved row opened to: null when its variables don't open here. */
  let opened = new Map<string, Record<string, string> | null>();

  const openEnv = (row: Row) =>
    openSecret(
      deps.keyWrappers,
      { ciphertext: row.envCiphertext, wrappedDataKey: row.envWrappedDataKey, kekId: row.envKekId },
      AAD(row.name),
    )
      .then((text) => JSON.parse(text) as Record<string, string>)
      .catch(() => null);

  const asServer = (row: Row, env: Record<string, string>): StdioServer => ({
    name: row.name,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    command: row.command,
    args: row.args,
    env,
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.orgs ? { orgs: row.orgs } : {}),
  });

  async function reload() {
    if (!deps.editable) {
      setStoredStdioServers([]);
      return;
    }
    const rows = await deps.db.select().from(instanceMcpServers);
    const next = new Map<string, Record<string, string> | null>();
    const servers: StdioServer[] = [];
    for (const row of rows) {
      const env = await openEnv(row);
      next.set(row.name, env);
      if (env) servers.push(asServer(row, env));
      else
        deps.log?.(`MCP server "${row.name}": its variables don't open with this AGENTES_SECRET, so it isn't offered`);
    }
    opened = next;
    setStoredStdioServers(servers);
  }

  /** Every process reads the list again and lets go of the changed server's processes. */
  async function changed(name: string) {
    await reload();
    await pool.closeServer(name);
    await deps.pubsub?.publish(MCP_SERVERS_TOPIC, { type: "mcp-stdio.changed", name }).catch(() => {});
  }

  const auditAll = async (userId: string, action: string, name: string, details: Record<string, unknown>) => {
    const orgs = await deps.db.select({ id: organizations.id }).from(organizations);
    for (const org of orgs)
      await recordAudit(deps.db, {
        orgId: org.id,
        actor: { type: "person", id: userId },
        action,
        target: { type: "mcp_server", id: name },
        details,
      });
  };

  const rowView = (row: Row): McpServerView => ({
    name: row.name,
    address: stdioUrl(row.name),
    label: row.label,
    description: row.description,
    command: row.command,
    args: row.args,
    cwd: row.cwd,
    orgs: row.orgs,
    env: row.envNames,
    source: "settings",
    state: opened.get(row.name) ? "ok" : "invalid",
    updatedAt: row.updatedAt.toISOString(),
  });

  const fileHas = (name: string) => stdioFileServers().some((s) => s.name === name);
  const notEditable = () =>
    new ConflictError("Servers are added here only with MCP_STDIO_EDITABLE on.", "mcp_server_not_editable");

  return {
    async start() {
      await reload();
      if (!deps.editable || !deps.pubsub) return () => {};
      return deps.pubsub.subscribe(MCP_SERVERS_TOPIC, (event) => {
        const name = typeof event.name === "string" ? event.name : null;
        void reload()
          .then(() => (name ? pool.closeServer(name) : undefined))
          .catch((error) => deps.log?.(`MCP servers: ${error instanceof Error ? error.message : String(error)}`));
      });
    },

    async view() {
      const files = stdioFileServers().map(fileView);
      if (!deps.editable) return { editable: false, servers: files };
      const rows = await deps.db.select().from(instanceMcpServers).orderBy(instanceMcpServers.name);
      for (const row of rows) if (!opened.has(row.name)) opened.set(row.name, await openEnv(row));
      return { editable: true, servers: [...files, ...rows.filter((r) => !fileHas(r.name)).map(rowView)] };
    },

    async save(name, draft, userId) {
      if (!deps.editable) throw notEditable();
      if (fileHas(name))
        throw new ConflictError(`"${name}" is in this server's file (MCP_STDIO_SERVERS).`, "mcp_server_env");
      const clean = checked(name, draft);
      const [prev] = await deps.db.select().from(instanceMcpServers).where(eq(instanceMcpServers.name, name));
      const kept = prev ? await openEnv(prev) : {};
      const env: Record<string, string> = {};
      for (const v of draft.env) {
        const value = v.value ?? kept?.[v.name];
        if (value === undefined) throw invalid(`Give "${v.name}" a value.`);
        env[v.name] = value;
      }
      const sealed = await sealSecret(deps.keyWrapper, JSON.stringify(env), AAD(name));
      const values = {
        ...clean,
        envNames: draft.env.map((v) => v.name),
        envCiphertext: sealed.ciphertext,
        envWrappedDataKey: sealed.wrappedDataKey,
        envKekId: sealed.kekId,
        updatedBy: userId,
        updatedAt: new Date(),
      };
      const [row] = await deps.db
        .insert(instanceMcpServers)
        .values({ name, ...values })
        .onConflictDoUpdate({ target: instanceMcpServers.name, set: values })
        .returning();
      if (!row) throw new Error("MCP server upsert returned nothing");
      await auditAll(userId, prev ? "mcp_server.changed" : "mcp_server.added", name, {
        command: clean.command,
        env: values.envNames,
      });
      await changed(name);
      return rowView(row);
    },

    async remove(name, userId) {
      if (!deps.editable) throw notEditable();
      const [gone] = await deps.db
        .delete(instanceMcpServers)
        .where(eq(instanceMcpServers.name, name))
        .returning({ name: instanceMcpServers.name });
      if (!gone) throw new NotFoundError("No such MCP server");
      await auditAll(userId, "mcp_server.removed", name, {});
      await changed(name);
    },

    async test(name) {
      const server = stdioServers().find((s) => s.name === name);
      if (!server) throw new NotFoundError("No such MCP server");
      return testStdioServer(server);
    },
  };
}

import { isAgentesCloud, NotFoundError, pinnedOwner, type StdioSettings } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, requireSession, security } from "./context";

const tags = ["System"];

const McpServer = z
  .object({
    name: z.string(),
    address: z.string().openapi({ description: "`stdio://<name>`: what a workspace's admins connect." }),
    label: z.string(),
    description: z.string().nullable(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string().nullable(),
    orgs: z.array(z.string()).nullable().openapi({ description: "Workspace ids; null: every workspace here." }),
    env: z.array(z.string()).openapi({ description: "The variables' names. Their values are never returned." }),
    source: z.enum(["env", "settings"]).openapi({
      description: "`env`: the server's file (`MCP_STDIO_SERVERS`), read-only here. `settings`: added here.",
    }),
    state: z.enum(["ok", "invalid"]).openapi({
      description:
        "`invalid`: its variables don't open on this server (another `AGENTES_SECRET`), so it isn't offered.",
    }),
    updatedAt: z.string().nullable(),
  })
  .openapi("InstanceMcpServer");

const McpServers = z
  .object({
    editable: z.boolean().openapi({ description: "Whether servers may be added here (`MCP_STDIO_EDITABLE`)." }),
    servers: z.array(McpServer),
  })
  .openapi("InstanceMcpServers");

const Draft = z
  .object({
    label: z.string().max(80).nullable().optional(),
    description: z.string().max(300).nullable().optional(),
    command: z.string().min(1).max(1000),
    args: z.array(z.string().max(4000)).max(100),
    cwd: z.string().max(1000).nullable().optional(),
    orgs: z.array(z.uuid()).min(1).max(500).nullable(),
    env: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          value: z.string().max(10_000).optional().openapi({ description: "Omitted: the value already saved." }),
        }),
      )
      .max(100),
  })
  .openapi("InstanceMcpServerDraft");

const TestResult = z
  .discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      tools: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["not_found", "failed", "timeout"]).openapi({
        description:
          "`not_found`: the command isn't on this server (as its own user sees it). `failed`: it exited or broke the protocol. `timeout`: no answer in 30 s.",
      }),
      detail: z.string().openapi({ description: "What failed, with the end of what the command wrote to stderr." }),
    }),
  ])
  .openapi("InstanceMcpServerTest");

const NameParams = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i) });

/** Starting a command is the costly part: limited like checking a key. */
const TESTS = { limit: 10, windowMs: 60_000 };
const notFound = "404 for everyone but the server's pinned owner (ADR 0073), and on agentes.chat itself.";

/**
 * The MCP servers this server runs as local processes (stdio): the operator's file (`MCP_STDIO_SERVERS`), and the ones
 * its owner adds here with `MCP_STDIO_EDITABLE` on. A workspace's admins then connect one by its `stdio://` address.
 */
export function mcpServerRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/mcp-servers", requireSession(deps.auth));
  app.use("/mcp-servers/*", requireSession(deps.auth));

  const ownerOnly = async (userId: string): Promise<StdioSettings> => {
    const settings = deps.extras?.mcpServers;
    if (!settings || isAgentesCloud(config.PUBLIC_URL) || (await pinnedOwner(db)) !== userId) throw new NotFoundError();
    return settings;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/mcp-servers",
      tags,
      summary: "The MCP servers this server runs (stdio), and whether more can be added here",
      description: notFound,
      security,
      responses: { 200: json(McpServers), 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const settings = await ownerOnly(c.get("user").id);
      return c.json(await settings.view(), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/mcp-servers/{name}",
      tags,
      summary: "Add or change an MCP server this server runs",
      description: `${notFound} The command runs as this server's own user, with the default environment and these variables. 409 \`mcp_server_not_editable\` without \`MCP_STDIO_EDITABLE\`, \`mcp_server_env\` for a name in the server's file. A changed server's processes stop, and the next call starts it again. Recorded in every workspace's audit log, with its command and variable names.`,
      security,
      request: { params: NameParams, body: body(Draft) },
      responses: { 200: json(McpServer), ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const settings = await ownerOnly(user.id);
      return c.json(await settings.save(c.req.valid("param").name, c.req.valid("json"), user.id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/mcp-servers/{name}",
      tags,
      summary: "Remove an MCP server added here",
      description: `${notFound} Its processes stop, and workspaces connected to it keep the connection, whose calls fail until a server of that name is back.`,
      security,
      request: { params: NameParams },
      responses: { 204: { description: "Removed" }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const settings = await ownerOnly(user.id);
      await settings.remove(c.req.valid("param").name, user.id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/mcp-servers/{name}/test",
      tags,
      summary: "Start an MCP server once and list its tools",
      description: `${notFound} Either list: the server's file or Settings.`,
      security,
      request: { params: NameParams },
      responses: {
        200: json(TestResult),
        ...errors,
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const settings = await ownerOnly(user.id);
      if (!(await deps.adapters.rateLimiter.consume(`mcp-server-test:${user.id}`, TESTS)).allowed)
        return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      return c.json(await settings.test(c.req.valid("param").name), 200);
    },
  );

  return app;
}

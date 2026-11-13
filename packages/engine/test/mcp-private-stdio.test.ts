import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  allowPrivateMcpServers,
  assertMcpServerUrl,
  type CustomDeps,
  connectCustomServer,
  createConnectorToolSource,
  createToolGateway,
  type McpConnect,
  mcpSessionOver,
  parseStdioServers,
  postPersonMessage,
  StdioPool,
  type StdioServer,
  saveCustomTools,
  setStdioServers,
  stdioNameOf,
  stdioServerFor,
  stdioServersFor,
  stdioUrl,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * MCP servers on this server's own network (`MCP_PRIVATE_SERVERS`, off unless the operator sets it), and the ones this
 * server runs itself (stdio, `MCP_STDIO_SERVERS`): a `stdio://<name>` address is the operator's own command, connected
 * and used as any other server's.
 */

const publicDns = async () => ["93.184.216.34"];

let f: Fixture;
/** A workspace for the tests that need one (the address checks alone don't). */
const workspace = async () => {
  f = await setup();
  return f;
};
afterEach(async () => {
  allowPrivateMcpServers(false);
  setStdioServers([]);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const depsOf = (extra: Partial<CustomDeps> = {}): CustomDeps => ({
  db: f.db,
  keyWrappers: [f.keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost: publicDns,
  ...extra,
});

/** An in-process server with one read-only tool: what a stdio process would answer. */
function localMcp(name = "local") {
  const calls: string[] = [];
  const connect = async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const mcp = new McpServer({ name, version: "1" });
    mcp.registerTool(
      "list_notes",
      { description: "List notes", inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => {
        calls.push("list_notes");
        return { content: [{ type: "text", text: "- buy milk" }] };
      },
    );
    mcp.registerTool("write_note", { description: "Write a note", inputSchema: { text: z.string() } }, async (a) => {
      calls.push(`write_note ${a.text}`);
      return { content: [{ type: "text", text: "saved" }] };
    });
    await mcp.connect(server);
    return mcpSessionOver(client);
  };
  return { connect, calls };
}

describe("a private MCP server's address", () => {
  test("refused unless the operator allows private servers: public https only", async () => {
    for (const url of ["http://127.0.0.1:9790/mcp", "http://localhost:3000/mcp", "https://192.168.1.9/mcp"]) {
      await expect(assertMcpServerUrl(url, publicDns)).rejects.toThrow();
    }
    expect((await assertMcpServerUrl("https://gateway.example.com/mcp", publicDns)).toString()).toBe(
      "https://gateway.example.com/mcp",
    );
  });

  test("with them allowed: http and any address this computer reaches, still no credentials in it", async () => {
    allowPrivateMcpServers(true);
    expect((await assertMcpServerUrl("http://127.0.0.1:9790/mcp")).toString()).toBe("http://127.0.0.1:9790/mcp");
    expect((await assertMcpServerUrl("https://192.168.1.9/mcp", publicDns)).toString()).toBe("https://192.168.1.9/mcp");
    await expect(assertMcpServerUrl("http://user:secret@127.0.0.1:9790/mcp")).rejects.toThrow();
    await expect(assertMcpServerUrl("ftp://127.0.0.1/mcp")).rejects.toThrow();
  });

  test("a workspace connects one over http, and its tools list and run as any server's", async () => {
    await workspace();
    allowPrivateMcpServers(true);
    const listNotes = localMcp();
    const connect: McpConnect = async (connection) => {
      expect(connection.serverUrl).toBe("http://127.0.0.1:9790/mcp");
      return listNotes.connect();
    };
    // No OAuth discovery for a server this one reached over http: the probe's POST needs the same allowance.
    const started = await connectCustomServer(depsOf({ connect }), f.owner.id, f.org.id, {
      serverUrl: "http://127.0.0.1:9790/mcp",
      apiKey: "local-key-1234",
    });
    expect(started.status).toBe("connected");
    if (started.status !== "connected") return;
    expect(started.server.serverUrl).toBe("http://127.0.0.1:9790/mcp");
    expect(started.server.tools.map((t) => t.name)).toEqual(["list_notes", "write_note"]);
    expect(started.server.tools.map((t) => t.access)).toEqual([null, null]);
  }, 30_000);
});

describe("this server's own MCP servers (stdio)", () => {
  const FILE = {
    mcpServers: {
      notes: {
        command: "npx",
        args: ["-y", "notes-mcp"],
        env: { NOTES_TOKEN: "abc" },
        label: "Notes",
        description: "Notes of this computer",
        orgs: ["an-org"],
      },
      everything: { command: "bun", args: ["server.ts"] },
    },
  };

  test("the file: names, commands, and which workspaces each is offered to", () => {
    const servers = parseStdioServers(JSON.stringify(FILE));
    expect(servers.map((s) => s.name)).toEqual(["notes", "everything"]);
    expect(servers[0]).toMatchObject({ label: "Notes", command: "npx", args: ["-y", "notes-mcp"], orgs: ["an-org"] });
    // No label: its name; no orgs: every workspace here.
    expect(servers[1]).toMatchObject({ label: "everything", env: {} });
    expect(servers[1]?.orgs).toBeUndefined();

    setStdioServers(servers);
    expect(stdioServersFor("an-org").map((s) => s.name)).toEqual(["notes", "everything"]);
    expect(stdioServersFor("other-org").map((s) => s.name)).toEqual(["everything"]);
    expect(stdioServerFor("an-org", stdioUrl("notes"))?.label).toBe("Notes");
    expect(stdioServerFor("other-org", stdioUrl("notes"))).toBeNull();
    expect(stdioNameOf("stdio://notes")).toBe("notes");
    expect(stdioNameOf("https://tickets.example.com/mcp")).toBeNull();
  });

  test("a file that isn't one is refused, with the entry that isn't", () => {
    expect(() => parseStdioServers("not json")).toThrow(/isn't JSON/);
    expect(() => parseStdioServers('{"servers": {}}')).toThrow(/mcpServers/);
    expect(() => parseStdioServers('{"mcpServers":{"a":{"args":[]}}}')).toThrow(/"a" needs a command/);
    expect(() => parseStdioServers('{"mcpServers":{"a":{"command":"x","args":"y"}}}')).toThrow(/args must be strings/);
    expect(() => parseStdioServers('{"mcpServers":{"a":{"command":"x","env":{"K":1}}}}')).toThrow(
      /env must be strings/,
    );
    expect(() => parseStdioServers('{"mcpServers":{"a b":{"command":"x"}}}')).toThrow(/isn't a name/);
  });

  test("an admin connects one by its address: no sign-in, its tools listed and classified as any server's", async () => {
    await workspace();
    setStdioServers(
      parseStdioServers(JSON.stringify({ mcpServers: { notes: { ...FILE.mcpServers.notes, orgs: [f.org.id] } } })),
    );
    const local = localMcp("notes");
    const pool = new StdioPool(() => local.connect());
    const connect: McpConnect = async (connection) => {
      expect(connection.serverUrl).toBe("stdio://notes");
      return pool.lease(f.org.id, stdioServerFor(f.org.id, "stdio://notes") as StdioServer);
    };
    const started = await connectCustomServer(depsOf({ connect }), f.owner.id, f.org.id, {
      serverUrl: "stdio://notes",
    });
    expect(started.status).toBe("connected");
    if (started.status !== "connected") return;
    // Named as the operator's file names it, at its own address, with every tool waiting for a decision.
    expect(started.server).toMatchObject({ label: "Notes", serverUrl: "stdio://notes" });
    expect(started.server.tools.map((t) => t.name)).toEqual(["list_notes", "write_note"]);

    // Classified by an admin as any server's, the tools reach the agent with its scopes, and the sensitive one asks.
    const server = started.server;
    await saveCustomTools(depsOf({ connect }), f.owner.id, f.org.id, server.id, {
      label: "Notas",
      tools: [
        { name: "list_notes", access: "read", label: "Listar notas" },
        { name: "write_note", access: "approval", label: "Escrever nota" },
      ],
    });
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "x",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
    };
    const gateway = createToolGateway({ sources: [createConnectorToolSource({ ...depsOf(), connect })] });
    expect((await gateway.list(ctx)).map((t) => [t.name, t.sensitive])).toEqual([
      ["notes_list_notes", false],
      ["notes_write_note", true],
    ]);

    // Read again through the same pool: the process is kept, and the tools come back the same.
    const listed = await pool.with(f.org.id, stdioServerFor(f.org.id, "stdio://notes") as StdioServer, (s) =>
      s.listTools(),
    );
    expect(listed.map((t) => t.name)).toEqual(["list_notes", "write_note"]);
    await pool.close();
  }, 30_000);

  test("a server the operator doesn't offer this workspace is refused", async () => {
    await workspace();
    setStdioServers(parseStdioServers(JSON.stringify(FILE)));
    await expect(connectCustomServer(depsOf(), f.owner.id, f.org.id, { serverUrl: "stdio://unknown" })).rejects.toThrow(
      /isn't offered here/,
    );
  }, 30_000);

  test("the pool keeps one process per workspace and server, one call at a time, and closes it when idle", async () => {
    await workspace();
    const local = localMcp();
    let opened = 0;
    let closed = 0;
    const pool = new StdioPool(async () => {
      opened++;
      const session = await local.connect();
      return { ...session, close: async () => void closed++ };
    });
    const spec: StdioServer = { name: "notes", label: "Notes", command: "x", args: [], env: {} };
    const twice = await Promise.all([
      pool.with(f.org.id, spec, (s) => s.listTools()),
      pool.with(f.org.id, spec, (s) => s.listTools()),
    ]);
    expect(twice.map((t) => t.length)).toEqual([2, 2]);
    expect(opened).toBe(1);
    await pool.close();
    expect(closed).toBe(1);
  });
});

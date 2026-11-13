import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryPubSub } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createStdioSettings,
  type McpServerDraft,
  parseStdioServers,
  StdioPool,
  setStdioServers,
  setStoredStdioServers,
  stdioPool,
  stdioServerFor,
  stdioServersFor,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * The MCP servers this server runs (stdio) that its owner adds in Settings (`MCP_STDIO_EDITABLE`): kept with their
 * variables sealed, offered like the file's, and read again by every process when one changes them.
 */

const FIXTURE = new URL("./fixtures/stdio-mcp.ts", import.meta.url).pathname;
const FILE = JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } });

const draft = (over: Partial<McpServerDraft> = {}): McpServerDraft => ({
  label: "Fixture",
  command: process.execPath,
  args: [FIXTURE],
  orgs: null,
  env: [{ name: "FIXTURE_TOKEN", value: "s3cret-token" }],
  ...over,
});

let f: Fixture;
afterEach(async () => {
  setStdioServers([]);
  setStoredStdioServers([]);
  await stdioPool.close();
  await f?.close();
});

const settingsOf = (
  editable: boolean,
  extra: { pool?: StdioPool; pubsub?: ReturnType<typeof createMemoryPubSub> } = {},
) => createStdioSettings({ db: f.db, keyWrapper: f.keyWrapper, keyWrappers: [f.keyWrapper], editable, ...extra });

describe("MCP servers added in Settings", () => {
  test("off without the switch: the file's servers are shown, nothing is added", async () => {
    f = await setup();
    setStdioServers(parseStdioServers(FILE));
    const settings = settingsOf(false);
    await settings.start();
    expect(await settings.view()).toMatchObject({ editable: false, servers: [{ name: "notes", source: "env" }] });
    await expect(settings.save("fixture", draft(), f.owner.id)).rejects.toThrow(/MCP_STDIO_EDITABLE/);
  }, 30_000);

  test("a saved server is offered, its variables sealed and only their names shown", async () => {
    f = await setup();
    const settings = settingsOf(true);
    await settings.start();
    const saved = await settings.save("fixture", draft(), f.owner.id);
    expect(saved).toMatchObject({
      address: "stdio://fixture",
      env: ["FIXTURE_TOKEN"],
      source: "settings",
      state: "ok",
    });
    expect(JSON.stringify(await settings.view())).not.toContain("s3cret-token");
    const [row] = await f.db.select().from(schema.instanceMcpServers);
    expect(JSON.stringify(row)).not.toContain("s3cret-token");
    expect(stdioServersFor(f.org.id).map((s) => s.name)).toEqual(["fixture"]);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "mcp_server.added"));
    expect(audit.map((a) => a.targetId)).toEqual(["fixture"]);
  }, 30_000);

  test("its process runs with the variable, and an edit that leaves it empty keeps it", async () => {
    f = await setup();
    const settings = settingsOf(true);
    await settings.start();
    await settings.save("fixture", draft(), f.owner.id);
    const said = async () => {
      const spec = stdioServerFor(f.org.id, "stdio://fixture");
      if (!spec) throw new Error("not offered");
      const res = await stdioPool.with(f.org.id, spec, (s) => s.callTool("whoami", {}));
      return res.content;
    };
    expect(await said()).toBe("s3cret-token");
    await settings.save("fixture", draft({ label: "Renamed", env: [{ name: "FIXTURE_TOKEN" }] }), f.owner.id);
    // The edit stopped the old process; the next call starts the new one, with the kept value.
    expect(await said()).toBe("s3cret-token");
    await expect(
      settings.save("fixture", draft({ env: [{ name: "FIXTURE_TOKEN" }, { name: "OTHER" }] }), f.owner.id),
    ).rejects.toThrow(/Give "OTHER" a value/);
  }, 60_000);

  test("a name in the server's file and a bad draft are refused", async () => {
    f = await setup();
    setStdioServers(parseStdioServers(FILE));
    const settings = settingsOf(true);
    await settings.start();
    await expect(settings.save("notes", draft(), f.owner.id)).rejects.toThrow(/MCP_STDIO_SERVERS/);
    await expect(settings.save("fixture", draft({ cwd: "relative/dir" }), f.owner.id)).rejects.toThrow(/full path/);
    await expect(settings.save("fixture", draft({ env: [{ name: "1BAD", value: "x" }] }), f.owner.id)).rejects.toThrow(
      /variable name/,
    );
    await expect(settings.save("fixture", draft({ orgs: [] }), f.owner.id)).rejects.toThrow(/workspace/);
  }, 30_000);

  test("limited to a workspace, it is offered there only; removed, it is offered nowhere", async () => {
    f = await setup();
    const settings = settingsOf(true);
    await settings.start();
    await settings.save("fixture", draft({ orgs: [f.org.id] }), f.owner.id);
    expect(stdioServerFor(f.org.id, "stdio://fixture")).not.toBeNull();
    expect(stdioServerFor(crypto.randomUUID(), "stdio://fixture")).toBeNull();
    await settings.remove("fixture", f.owner.id);
    expect(stdioServersFor(f.org.id)).toEqual([]);
    await expect(settings.remove("fixture", f.owner.id)).rejects.toThrow(/No such/);
  }, 30_000);

  test("another process hears of a change and lets go of that server's sessions", async () => {
    f = await setup();
    const pubsub = createMemoryPubSub();
    const closed = Promise.withResolvers<string>();
    const other = new StdioPool();
    other.closeServer = async (name) => closed.resolve(name);
    const there = settingsOf(true, { pubsub, pool: other });
    const stop = await there.start();
    await settingsOf(true, { pubsub }).save("fixture", draft(), f.owner.id);
    expect(await closed.promise).toBe("fixture");
    stop();
  }, 30_000);

  test("Test starts it once: its tools, or why it didn't start", async () => {
    f = await setup();
    const settings = settingsOf(true);
    await settings.start();
    await settings.save("fixture", draft(), f.owner.id);
    expect(await settings.test("fixture")).toEqual({
      ok: true,
      tools: [{ name: "whoami", description: "Says the variable it was started with" }],
    });
    await settings.save("missing", draft({ command: "agentes-no-such-command", args: [] }), f.owner.id);
    expect(await settings.test("missing")).toMatchObject({ ok: false, reason: "not_found" });
    await settings.save("broken", draft({ command: "sh", args: ["-c", "echo boom >&2; exit 3"] }), f.owner.id);
    const broken = await settings.test("broken");
    expect(broken).toMatchObject({ ok: false, reason: "failed" });
    expect(broken.ok === false && broken.detail).toContain("boom");
  }, 60_000);
});

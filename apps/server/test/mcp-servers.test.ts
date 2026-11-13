import { afterEach, expect, test } from "bun:test";
import { setStoredStdioServers } from "@agenteschat/engine";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/**
 * The MCP servers this server runs (stdio), in Settings: only its first account, only with `MCP_STDIO_EDITABLE`,
 * never on agentes.chat; a saved one is then what a workspace's admins may connect.
 */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  setStoredStdioServers([]);
});

const draft = {
  label: "Notes",
  command: "notes-mcp",
  args: ["--root", "/srv/notes"],
  orgs: null,
  env: [{ name: "NOTES_TOKEN", value: "notes_do_not_leak_91c2" }],
};

async function start(env: Record<string, string> = {}) {
  const server = await createTestServer({ env: { ALLOW_SIGNUP: "true", ...env } });
  t = server;
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const other = browser(server);
  await signUp(other, "other@example.com");
  return { server, owner, other };
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("only the first account reaches it; without the switch it lists and refuses to add", async () => {
  const { server, owner, other } = await start();
  expect((await browser(server)("/api/app/mcp-servers")).status).toBe(401);
  expect((await other("/api/app/mcp-servers")).status).toBe(404);
  expect((await other("/api/app/mcp-servers/notes", { method: "PUT", json: draft })).status).toBe(404);
  expect(await (await owner("/api/app/mcp-servers")).json()).toEqual({ editable: false, servers: [] });
  const res = await owner("/api/app/mcp-servers/notes", { method: "PUT", json: draft });
  expect(res.status).toBe(409);
  expect(await errorCode(res)).toBe("mcp_server_not_editable");
}, 30_000);

test("on agentes.chat itself nobody has it, even with the switch", async () => {
  const origin = "https://app.agentes.chat";
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true", PUBLIC_URL: origin, MCP_STDIO_EDITABLE: "true" } });
  const first = browser(t);
  await first("/api/auth/sign-up/email", {
    json: { email: "first@example.com", password: "correct horse battery", name: "First" },
    origin,
  });
  expect((await first("/api/app/mcp-servers")).status).toBe(404);
  expect((await first("/api/app/mcp-servers/notes", { method: "PUT", json: draft, origin })).status).toBe(404);
}, 30_000);

test("saved by the owner: offered to a workspace's admins, its variable never returned; removed: gone", async () => {
  const { owner } = await start({ MCP_STDIO_EDITABLE: "true" });
  const saved = await owner("/api/app/mcp-servers/notes", { method: "PUT", json: draft });
  expect(saved.status).toBe(200);
  const view = await (await owner("/api/app/mcp-servers")).text();
  expect(view).toContain('"env":["NOTES_TOKEN"]');
  expect(view).not.toContain("notes_do_not_leak_91c2");
  const created = (await (await owner("/api/app/organizations", { json: { name: "Acme" } })).json()) as {
    organization: { id: string };
  };
  const local = `/api/app/organizations/${created.organization.id}/connectors/local-servers`;
  expect(await (await owner(local)).json()).toMatchObject({ servers: [{ name: "notes", serverUrl: "stdio://notes" }] });
  expect((await owner("/api/app/mcp-servers/notes", { method: "DELETE" })).status).toBe(204);
  expect(await (await owner(local)).json()).toEqual({ servers: [] });
}, 30_000);

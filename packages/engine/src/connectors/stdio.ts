import { readFileSync } from "node:fs";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ValidationError } from "../errors";
import { type McpConnect, type McpSession, mcpSessionOver } from "./mcp";

/**
 * MCP servers this server runs itself (stdio, `MCP_STDIO_SERVERS`): the operator's file names each command, so a
 * workspace's admins can only connect one of them, never type a command. Its address is `stdio://<name>`, and the rest
 * of a connection is any other server's: tools listed, classified, approved and audited the same way.
 */
export interface StdioServer {
  name: string;
  label: string;
  description?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** The workspaces it is offered to; unset: every workspace on this server. */
  orgs?: string[];
}

/** `stdio://<name>`, one line and no spaces: the address a workspace connects. */
export const stdioUrl = (name: string) => `stdio://${name}`;

/** The server a `stdio:` address names; null for any other address. */
export function stdioNameOf(serverUrl: string): string | null {
  if (!serverUrl.toLowerCase().startsWith("stdio:")) return null;
  try {
    return new URL(serverUrl).hostname || null;
  } catch {
    return null;
  }
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

interface StdioFile {
  mcpServers?: unknown;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Reads and checks the operator's file. Every entry needs a command; `orgs` (workspace ids) are not checked here (a
 * workspace may be added later), and an entry that names none is offered to every workspace.
 */
export function parseStdioServers(text: string): StdioServer[] {
  let file: StdioFile;
  try {
    file = JSON.parse(text) as StdioFile;
  } catch {
    throw new Error("MCP_STDIO_SERVERS: the file isn't JSON");
  }
  const listed = file?.mcpServers;
  if (!listed || typeof listed !== "object" || Array.isArray(listed))
    throw new Error('MCP_STDIO_SERVERS: the file needs an "mcpServers" object');
  const out: StdioServer[] = [];
  for (const [name, raw] of Object.entries(listed as Record<string, unknown>)) {
    if (!NAME.test(name)) throw new Error(`MCP_STDIO_SERVERS: "${name}" isn't a name (letters, digits, - and _)`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`MCP_STDIO_SERVERS: "${name}" needs an object`);
    const e = raw as Record<string, unknown>;
    const command = e.command;
    if (typeof command !== "string" || command.trim() === "")
      throw new Error(`MCP_STDIO_SERVERS: "${name}" needs a command`);
    const args = e.args ?? [];
    if (!strings(args)) throw new Error(`MCP_STDIO_SERVERS: "${name}": args must be strings`);
    const env = e.env ?? {};
    if (typeof env !== "object" || Array.isArray(env) || !Object.values(env).every((v) => typeof v === "string"))
      throw new Error(`MCP_STDIO_SERVERS: "${name}": env must be strings`);
    const orgs = e.orgs;
    if (orgs !== undefined && !strings(orgs)) throw new Error(`MCP_STDIO_SERVERS: "${name}": orgs must be ids`);
    if (e.cwd !== undefined && typeof e.cwd !== "string")
      throw new Error(`MCP_STDIO_SERVERS: "${name}": cwd must be a path`);
    out.push({
      name,
      label: typeof e.label === "string" && e.label.trim() ? e.label.trim() : name,
      ...(typeof e.description === "string" && e.description.trim() ? { description: e.description.trim() } : {}),
      command,
      args: args as string[],
      env: env as Record<string, string>,
      ...(typeof e.cwd === "string" ? { cwd: e.cwd } : {}),
      ...(orgs === undefined ? {} : { orgs: orgs as string[] }),
    });
  }
  return out;
}

let registered: StdioServer[] = [];

/** The operator's list, in place for this process (an empty list removes every server). */
export function setStdioServers(servers: StdioServer[]) {
  registered = servers;
}

/** The servers of the operator's file, all of them (admins of a workspace see the ones it may connect). */
export const stdioServers = () => registered;

/** The servers one workspace may connect: the ones naming it, and the ones that name no workspace. */
export const stdioServersFor = (orgId: string) => registered.filter((s) => !s.orgs || s.orgs.includes(orgId));

/** The server a workspace's connection names, or null when the operator's file doesn't offer it to that workspace. */
export function stdioServerFor(orgId: string, serverUrl: string): StdioServer | null {
  const name = stdioNameOf(serverUrl);
  if (!name) return null;
  const server = registered.find((s) => s.name === name);
  return server && (!server.orgs || server.orgs.includes(orgId)) ? server : null;
}

/**
 * Reads the file `MCP_STDIO_SERVERS` names. Problems are the operator's: the error is logged and no server is
 * offered, rather than one bad entry taking every other connector of the process with it.
 */
export function loadStdioServers(path: string): StdioServer[] {
  return parseStdioServers(readFileSync(path, "utf8"));
}

/**
 * Opens one of them: the command runs as this server's own user, with the default environment (never this process's
 * secrets) and the file's own variables. Each session is its own process; the tool source keeps one for the calls it
 * runs (`stdioPool`).
 */
export function connectOverStdio(server: StdioServer): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...getDefaultEnvironment(), ...server.env },
    ...(server.cwd ? { cwd: server.cwd } : {}),
    stderr: "ignore",
  });
  return mcpSessionOver(transport);
}

interface PoolEntry {
  session: Promise<McpSession>;
  /** The open session once it is up (a lease answers `serverInfo` from it). */
  up?: McpSession;
  last: number;
  /** Calls running on it now: an idle sweep never closes a session mid-call. */
  busy: number;
  /** Calls run one at a time: one stdio process answers one request at a time. */
  queue: Promise<unknown>;
}

/**
 * One open session per workspace and server, one call at a time: a stdio server keeps state between calls (a browser
 * it drove, a project it opened), and starting it again for every call would be slow and lose that. An idle session
 * is closed after `idleMs`.
 */
export class StdioPool {
  private open = new Map<string, PoolEntry>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly openServer: (server: StdioServer) => Promise<McpSession> = connectOverStdio,
    private readonly idleMs = 5 * 60_000,
  ) {}

  /** Runs `fn` on the workspace's session with that server, opening it first when it isn't. */
  async with<T>(orgId: string, server: StdioServer, fn: (session: McpSession) => Promise<T>): Promise<T> {
    const entry = this.entry(orgId, server);
    entry.busy++;
    const run = entry.queue.then(async () => fn(await entry.session));
    entry.queue = run.catch(() => {});
    return run.finally(() => {
      entry.busy--;
      entry.last = Date.now();
    });
  }

  /**
   * The workspace's session with that server, for a caller that closes what it opens (the tool source does): its
   * `close` leaves the process running for the next call, and an idle one is closed by the pool.
   */
  lease(orgId: string, server: StdioServer): McpSession {
    const run = <T>(fn: (session: McpSession) => Promise<T>) => this.with(orgId, server, fn);
    return {
      listTools: () => run((s) => s.listTools()),
      callTool: (name, args, meta) => run((s) => s.callTool(name, args, meta)),
      serverInfo: () => this.open.get(poolKey(orgId, server.name))?.up?.serverInfo?.() ?? null,
      close: async () => {},
    };
  }

  /** Closes every session (a shutdown, a test, or a server the operator removed). */
  async close(): Promise<void> {
    const entries = [...this.open.values()];
    this.open.clear();
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all(entries.map((e) => e.session.then((s) => s.close()).catch(() => {})));
  }

  private entry(orgId: string, server: StdioServer): PoolEntry {
    const key = poolKey(orgId, server.name);
    let entry = this.open.get(key);
    if (!entry) {
      entry = { session: this.openServer(server), last: Date.now(), busy: 0, queue: Promise.resolve() };
      const created = entry;
      this.open.set(key, created);
      created.session.then(
        (s) => {
          created.up = s;
        },
        () => {},
      );
      // A server that couldn't start isn't kept: the next call tries again.
      created.session.catch(() => {
        if (this.open.get(key) === created) this.open.delete(key);
      });
      this.watch();
    }
    return entry;
  }

  private watch() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), Math.min(this.idleMs, 60_000));
    this.timer.unref?.();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.open) {
      if (entry.busy > 0 || now - entry.last < this.idleMs) continue;
      this.open.delete(key);
      entry.session.then((s) => s.close()).catch(() => {});
    }
    if (this.open.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

const poolKey = (orgId: string, name: string) => `${orgId}|${name}`;

/** One pool for the process: the tool source and a listing share each workspace's sessions. */
export const stdioPool = new StdioPool();

/**
 * Opens a session to any MCP server a connection names: a `stdio:` one from the operator's list (through the pool, so
 * the process is kept between calls), or an http(s) one (`connectOverHttp`).
 */
export function connectAny(http: McpConnect): McpConnect {
  return async (connection, headers) => {
    if (!stdioNameOf(connection.serverUrl)) return http(connection, headers);
    const org = connection.orgId;
    const spec = org ? stdioServerFor(org, connection.serverUrl) : null;
    if (!org || !spec) throw new ValidationError("Unknown local MCP server", "connector.stdio_unknown");
    return stdioPool.lease(org, spec);
  };
}

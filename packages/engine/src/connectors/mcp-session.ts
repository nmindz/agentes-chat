import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { tolerantMcpFetch } from "./mcp-fetch";
import type { McpServerInfo } from "./server-icon";

/** A tool as an MCP server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** The server's `readOnlyHint` annotation, when it sends one. */
  readOnlyHint?: boolean | null;
  /** The server's `destructiveHint` annotation, when it sends one. */
  destructiveHint?: boolean | null;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
  /** A Composio action's answer as Composio gave it (files and all), for `keepComposioFiles`. */
  data?: unknown;
}

/** An open MCP client session. Only the connector tool source uses it, behind the Tool Gateway. */
export interface McpSession {
  listTools(): Promise<McpTool[]>;
  /** `meta`: what the request carries in `params._meta`, beside the tool's arguments. */
  callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<McpCallResult>;
  /** Who the server said it is in `initialize` (name, title, icons); null when it said nothing. */
  serverInfo?(): McpServerInfo | null;
  close(): Promise<void>;
}

/**
 * Every tool result passes. The SDK's default compiles each listed tool's `outputSchema` with a new Ajv for every
 * client, so for every listing, on the main thread: a second or more and tens of MB for a server with large schemas.
 * Nothing here checks a result against its schema; it reaches the model as untrusted text either way.
 */
const NO_OUTPUT_VALIDATION: jsonSchemaValidator = {
  getValidator: () => (input) => ({ valid: true, data: input as never, errorMessage: undefined }),
};

/** Wraps an official MCP SDK client over any transport (Streamable HTTP, SSE, or a local process' stdio). */
export async function mcpSessionOver(transport: Transport): Promise<McpSession> {
  const client = new Client({ name: "agentes.chat", version: "1" }, { jsonSchemaValidator: NO_OUTPUT_VALIDATION });
  await client.connect(transport);
  return {
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of res.tools) {
          tools.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
            readOnlyHint: (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint ?? null,
            destructiveHint: (t.annotations as { destructiveHint?: boolean } | undefined)?.destructiveHint ?? null,
          });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name, args, meta) {
      const res = (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as {
        content?: { type: string; text?: string; resource?: { text?: unknown } }[];
        isError?: boolean;
        structuredContent?: unknown;
      };
      // GitHub's `get_file_contents` sends the file itself as an embedded resource next to a one-line text block.
      const parts = (res.content ?? []).map((c) =>
        c.type === "text"
          ? (c.text ?? "")
          : c.type === "resource" && typeof c.resource?.text === "string"
            ? c.resource.text
            : `[${c.type}]`,
      );
      if (parts.length === 0 && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent));
      return { content: parts.join("\n"), isError: res.isError === true };
    },
    serverInfo: () => (client.getServerVersion() as McpServerInfo | undefined) ?? null,
    close: () => client.close(),
  };
}

export { tolerantMcpFetch };

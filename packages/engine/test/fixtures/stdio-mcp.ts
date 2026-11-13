import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// A real stdio MCP server for tests: one tool, and the variable it was given as its answer.
const server = new McpServer({ name: "fixture-stdio", version: "1" });
server.registerTool("whoami", { description: "Says the variable it was started with" }, async () => ({
  content: [{ type: "text", text: process.env.FIXTURE_TOKEN ?? "none" }],
}));
await server.connect(new StdioServerTransport());

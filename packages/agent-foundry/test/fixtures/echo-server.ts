// A minimal stdio MCP server, so the lifecycle tests need no network and no
// Infino credentials.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "0.0.0" });
server.registerTool(
  "echo",
  { description: "Echo the message back.", inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: "text" as const, text: message }] }),
);
await server.connect(new StdioServerTransport());

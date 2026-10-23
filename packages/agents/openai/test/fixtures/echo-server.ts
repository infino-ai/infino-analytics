// A minimal stdio MCP server, so the lifecycle tests need no network and no
// Infino credentials. One read tool and one write tool, named as the Infino
// server names them, so the read-only filter in front of it is exercised too.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "0.0.0" });
server.registerTool(
  "infino_sql",
  { description: "Echo the query back.", inputSchema: { query: z.string() } },
  async ({ query }) => ({ content: [{ type: "text" as const, text: query }] }),
);
server.registerTool(
  "infino_drop_table",
  { description: "Would drop a table.", inputSchema: { table: z.string() } },
  async ({ table }) => ({ content: [{ type: "text" as const, text: `dropped ${table}` }] }),
);
await server.connect(new StdioServerTransport());

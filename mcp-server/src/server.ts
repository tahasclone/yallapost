import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

/**
 * Build a fresh MCP server with every tool registered.
 *
 * One instance is created per request. The tools hold no state between calls,
 * so there is nothing to share and nothing to leak between sessions.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "daily-content-agent", version: "0.1.0" },
    {
      instructions:
        "Tools for a daily content agent. The pipeline runs SCOUT (get_watchlist, save_topics), PRODUCE (save_package), EDIT (transcribe, render_video), then PUBLISH (publish_post). publish_post is irreversible and requires human approval.",
    },
  );

  registerTools(server);
  return server;
}

import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "./server.js";

const PORT = Number(process.env.MCP_PORT ?? 8791);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

const app = express();
app.use(express.json({ limit: "4mb" }));

/**
 * Optional shared-token auth. TrueForge sends the token as a bearer header on
 * every request. With MCP_AUTH_TOKEN unset the server is open, which is fine
 * only because it binds to loopback (see listen below).
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) {
    next();
    return;
  }

  const header = req.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(AUTH_TOKEN);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }

  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "daily-content-agent", version: "0.1.0" });
});

/**
 * Stateless Streamable HTTP: a new server and transport per request, torn down
 * when the response closes. TrueForge also speaks SSE, but streamable-http is
 * the current transport and needs no long-lived session state on our side.
 */
app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no server-initiated stream and no session to delete.
for (const method of ["get", "delete"] as const) {
  app[method]("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });
}

// Loopback only. This server has no business being reachable off this machine.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(AUTH_TOKEN ? "Auth: bearer token required" : "Auth: disabled (loopback only)");
});

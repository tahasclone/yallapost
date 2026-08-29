import { createClient } from "@/lib/trueforge";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Continue the pipeline session with the next stage instruction: topic pick,
 * clip uploaded, publish request, or a revision. Plain user message; approval
 * decisions go through /api/approve instead.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { sessionId?: string; message?: string };
  try {
    body = (await request.json()) as { sessionId?: string; message?: string };
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { sessionId, message } = body;
  if (!sessionId || !message) {
    return Response.json({ error: "sessionId and message are required" }, { status: 400 });
  }

  return sseResponse(async (send) => {
    const client = createClient();
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [{ type: "user.message", content: message }],
    });
    for await (const event of stream) send(event);
  });
}

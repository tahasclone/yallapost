import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { createClient } from "@/lib/trueforge";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ApproveBody {
  sessionId?: string;
  threadId?: string;
  toolCallId?: string;
  decision?: "allow" | "deny";
  reason?: string;
}

/**
 * Answer a pending `tool.approval_required` and stream the resumed run.
 *
 * Resuming is a new turn on the same session whose input is a
 * `user.tool_approval` item rather than a user message. TrueForge is explicit
 * that approval items must not be mixed with user messages in one turn, so this
 * route sends the decision on its own.
 */
export async function POST(request: Request): Promise<Response> {
  let body: ApproveBody;
  try {
    body = (await request.json()) as ApproveBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { sessionId, threadId, toolCallId, decision, reason } = body;
  if (!sessionId || !threadId || !toolCallId) {
    return Response.json(
      { error: "sessionId, threadId and toolCallId are required" },
      { status: 400 },
    );
  }
  if (decision !== "allow" && decision !== "deny") {
    return Response.json(
      { error: 'decision must be "allow" or "deny"' },
      { status: 400 },
    );
  }

  const approval: TrueForgeApi.ApprovalDecision =
    decision === "allow"
      ? { status: "allow" }
      : { status: "deny", ...(reason ? { reason } : {}) };

  return sseResponse(async (send) => {
    const client = createClient();
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [{ type: "user.tool_approval", threadId, toolCallId, approval }],
    });

    for await (const event of stream) {
      send(event);
    }
  });
}

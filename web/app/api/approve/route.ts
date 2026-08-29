import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { createClient } from "@/lib/trueforge";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DecisionInput {
  threadId?: string;
  toolCallId?: string;
  decision?: "allow" | "deny";
  reason?: string;
}

interface ApproveBody {
  sessionId?: string;
  decisions?: DecisionInput[];
}

/**
 * Answer every pending tool call and stream the resumed run.
 *
 * The decision set must be complete. A paused turn can hold more than one call
 * awaiting approval, and the harness rejects a partial batch outright:
 * "Send batch must resolve all pending tool calls awaiting user input."
 * So this takes an array and submits one `user.tool_approval` item per call in
 * a single turn.
 *
 * Each item carries its own `threadId`, because pending calls can belong to
 * different threads when subagents are involved.
 *
 * Resuming is a new turn whose input is approval items rather than a user
 * message; TrueForge forbids mixing the two in one turn.
 */
export async function POST(request: Request): Promise<Response> {
  let body: ApproveBody;
  try {
    body = (await request.json()) as ApproveBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { sessionId, decisions } = body;
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return Response.json(
      { error: "decisions must be a non-empty array" },
      { status: 400 },
    );
  }

  const input: TrueForgeApi.TurnInputItem[] = [];
  const seen = new Set<string>();

  for (const [i, item] of decisions.entries()) {
    const { threadId, toolCallId, decision, reason } = item;
    if (!threadId || !toolCallId) {
      return Response.json(
        { error: `decisions[${i}] needs threadId and toolCallId` },
        { status: 400 },
      );
    }
    if (decision !== "allow" && decision !== "deny") {
      return Response.json(
        { error: `decisions[${i}].decision must be "allow" or "deny"` },
        { status: 400 },
      );
    }
    if (seen.has(toolCallId)) {
      return Response.json(
        { error: `decisions contains ${toolCallId} more than once` },
        { status: 400 },
      );
    }
    seen.add(toolCallId);

    const approval: TrueForgeApi.ApprovalDecision =
      decision === "allow"
        ? { status: "allow" }
        : { status: "deny", ...(reason ? { reason } : {}) };

    input.push({ type: "user.tool_approval", threadId, toolCallId, approval });
  }

  return sseResponse(async (send) => {
    const client = createClient();
    const stream = await client.sessions.createTurnStream(sessionId, { input });

    for await (const event of stream) {
      send(event);
    }
  });
}

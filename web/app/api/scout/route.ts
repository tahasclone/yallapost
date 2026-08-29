import { createClient, scoutAgentSpec } from "@/lib/trueforge";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a SCOUT session and forward every event to the browser.
 *
 * Same streaming contract as /api/run: a synthetic `client.session` frame
 * first, then the harness event stream untouched. The instructions live in
 * agents/scout.md, so the turn prompt only pulls the trigger.
 */
export async function POST(): Promise<Response> {
  return sseResponse(async (send) => {
    const client = createClient();

    const { data: session } = await client.sessions.create({
      agent: { spec: scoutAgentSpec() },
    });
    send({ type: "client.session", sessionId: session.id });

    const stream = await client.sessions.createTurnStream(session.id, {
      input: [
        {
          type: "user.message",
          content:
            "Run the scout flow now, following your instructions end to end.",
        },
      ],
    });

    for await (const event of stream) {
      send(event);
    }
  });
}

import { agentSpec, createClient } from "@/lib/trueforge";
import { DEMO_PROMPT } from "@/lib/prompt";
import { sseResponse } from "@/lib/sse";

// The SDK is a Node client and the response streams, so neither edge runtime
// nor static optimisation applies here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a session, send the demo prompt, and forward every event to the browser.
 *
 * The session id goes out first as a synthetic `client.session` frame. The
 * browser needs it to resume the run after an approval, and it is not part of
 * the harness event stream.
 */
export async function POST(): Promise<Response> {
  return sseResponse(async (send) => {
    const client = createClient();

    const { data: session } = await client.sessions.create({
      agent: { spec: agentSpec() },
    });
    send({ type: "client.session", sessionId: session.id });

    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: DEMO_PROMPT }],
    });

    for await (const event of stream) {
      send(event);
    }
  });
}

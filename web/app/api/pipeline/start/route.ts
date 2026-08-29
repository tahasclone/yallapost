import { createClient, pipelineAgentSpec } from "@/lib/trueforge";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create the pipeline session and run the SCOUT stage. */
export async function POST(): Promise<Response> {
  return sseResponse(async (send) => {
    const client = createClient();
    const { data: session } = await client.sessions.create({
      agent: { spec: pipelineAgentSpec() },
    });
    send({ type: "client.session", sessionId: session.id });

    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: "Run the SCOUT stage now." }],
    });
    for await (const event of stream) send(event);
  });
}

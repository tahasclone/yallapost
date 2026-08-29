/**
 * Wrap a producer in a Server-Sent Events response.
 *
 * Both API routes forward TrueForge's event stream to the browser unchanged, so
 * the client renders whatever the harness emits. Errors are pushed into the
 * stream as a `client.error` frame rather than thrown, because by the time they
 * happen the response headers are already sent and an HTTP error code would
 * never reach the browser.
 */
export function sseResponse(
  produce: (send: (event: unknown) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        await produce(send);
      } catch (error) {
        send({
          type: "client.error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops proxies buffering the stream, which would batch every event
      // into one delivery at the end and defeat the point.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Read an SSE response body and hand each parsed frame to `onEvent`.
 *
 * Frames arrive as `data: {...}\n\n`. A chunk boundary can land mid-frame, so
 * the tail of each read is kept in `buffer` until its terminator shows up.
 */
export async function readSseStream(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response has no body to stream");

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;

      try {
        onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
      } catch {
        onEvent({ type: "client.parse_error", raw: line });
      }
    }
  }
}

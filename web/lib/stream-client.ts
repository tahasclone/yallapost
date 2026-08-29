/** Cap on how much of a failed response body we read back for the error message. */
const MAX_ERROR_BODY = 4000;
/** Cap on how much of that body is shown in the error message. */
const MAX_ERROR_DETAIL = 300;

/**
 * Pull a short, useful message out of a failed response.
 *
 * API routes reject bad input with `{ "error": "..." }`, so prefer that field
 * and fall back to raw text for anything else (a framework error page, say).
 */
async function readErrorBody(response: Response): Promise<string> {
  let text: string;
  try {
    text = (await response.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    return "";
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === "string") return error;
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }

  const trimmed = text.trim();
  // An HTML error page carries nothing a reader wants and buries the status
  // code under kilobytes of markup, so report the status alone.
  if (trimmed.startsWith("<")) return "";

  return trimmed.length > MAX_ERROR_DETAIL
    ? `${trimmed.slice(0, MAX_ERROR_DETAIL)}...`
    : trimmed;
}

/**
 * Read an SSE response body and hand each parsed frame to `onEvent`.
 *
 * The status and content type are checked first. Without that, a 400 from a
 * route returns a JSON body containing no `data:` frames, the read loop ends
 * immediately, and the run looks like it finished cleanly when it never
 * started. Throwing here surfaces the reason to the caller instead.
 *
 * Frames arrive as `data: {...}\n\n`. A chunk boundary can land mid-frame, so
 * the tail of each read is kept in `buffer` until its terminator shows up.
 */
export async function readSseStream(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(
      `Request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const detail = await readErrorBody(response);
    throw new Error(
      `Expected an event stream but got "${contentType || "no content type"}"` +
        (detail ? `: ${detail}` : ""),
    );
  }

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

"use client";

import { useCallback, useRef, useState } from "react";
import { readSseStream } from "@/lib/stream-client";

type Event = Record<string, unknown>;

interface PendingApproval {
  threadId: string;
  toolCallId: string;
}

/** Read a string field that may arrive camelCase or snake_case. */
function str(event: Event, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = event[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function toolCallsOf(event: Event): Array<Record<string, unknown>> {
  const raw = event.toolCalls ?? event.tool_calls;
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

/**
 * Pull the pending approval out of a tool.approval_required event.
 * Only the first pending call is handled; the harness re-emits the event for
 * any that remain, so they arrive one at a time.
 */
function pendingFrom(event: Event): PendingApproval | null {
  if (event.type !== "tool.approval_required") return null;
  const threadId = str(event, "threadId", "thread_id");
  const first = toolCallsOf(event)[0];
  const toolCallId = first ? str(first, "id") : undefined;
  return threadId && toolCallId ? { threadId, toolCallId } : null;
}

export default function Page() {
  const [events, setEvents] = useState<Event[]>([]);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const sessionId = useRef<string | null>(null);

  const consume = useCallback(async (response: Response) => {
    await readSseStream(response, (event) => {
      setEvents((prev) => [...prev, event]);

      if (event.type === "client.session") {
        sessionId.current = str(event, "sessionId") ?? null;
      }
      const found = pendingFrom(event);
      if (found) setPending(found);
    });
  }, []);

  const start = useCallback(async () => {
    setEvents([]);
    setPending(null);
    sessionId.current = null;
    setRunning(true);
    try {
      const response = await fetch("/api/run", { method: "POST" });
      await consume(response);
    } catch (error) {
      setEvents((prev) => [
        ...prev,
        { type: "client.error", message: String(error) },
      ]);
    } finally {
      setRunning(false);
    }
  }, [consume]);

  const respond = useCallback(
    async (decision: "allow" | "deny") => {
      if (!pending || !sessionId.current) return;
      const answered = pending;
      setPending(null);
      setRunning(true);
      setEvents((prev) => [
        ...prev,
        { type: "client.decision", decision, toolCallId: answered.toolCallId },
      ]);

      try {
        const response = await fetch("/api/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionId.current,
            threadId: answered.threadId,
            toolCallId: answered.toolCallId,
            decision,
            ...(decision === "deny"
              ? { reason: "Rejected by the operator in the app UI." }
              : {}),
          }),
        });
        await consume(response);
      } catch (error) {
        setEvents((prev) => [
          ...prev,
          { type: "client.error", message: String(error) },
        ]);
      } finally {
        setRunning(false);
      }
    },
    [consume, pending],
  );

  return (
    <main style={{ maxWidth: 900 }}>
      <h1 style={{ fontSize: 18 }}>Daily Content Agent</h1>

      <button
        onClick={start}
        disabled={running}
        style={{ padding: "8px 14px", fontSize: 14, cursor: running ? "wait" : "pointer" }}
      >
        {running ? "Running..." : "Run daily cycle"}
      </button>

      {pending ? (
        <div
          style={{
            border: "2px solid #e0a500",
            background: "#2a2200",
            padding: 12,
            margin: "12px 0",
          }}
        >
          <strong>Approval required</strong>
          <div style={{ fontSize: 12, opacity: 0.8, margin: "6px 0" }}>
            thread {pending.threadId} / tool call {pending.toolCallId}
          </div>
          <button onClick={() => respond("allow")} style={{ marginRight: 8, padding: "6px 12px" }}>
            Approve
          </button>
          <button onClick={() => respond("deny")} style={{ padding: "6px 12px" }}>
            Reject
          </button>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        {events.map((event, i) => (
          <EventRow key={i} event={event} />
        ))}
      </div>

      {events.length === 0 ? (
        <p style={{ opacity: 0.6, fontSize: 13 }}>No events yet. Click the button.</p>
      ) : null}
    </main>
  );
}

/**
 * Render one event.
 *
 * Deliberately generic: it switches on event type only, never on tool names, and
 * anything unrecognised still renders as raw JSON so nothing is silently
 * dropped when the harness emits an event type we have not seen.
 */
function EventRow({ event }: { event: Event }) {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const thread = str(event, "threadId", "thread_id");

  return (
    <div style={{ borderBottom: "1px solid #333", padding: "6px 0", fontSize: 13 }}>
      <div style={{ color: "#7ec9ff" }}>
        {type}
        {thread && thread !== "main" ? (
          <span style={{ color: "#c58aff" }}> [subagent thread: {thread}]</span>
        ) : null}
      </div>
      <EventBody event={event} type={type} />
    </div>
  );
}

function EventBody({ event, type }: { event: Event; type: string }) {
  const pre: React.CSSProperties = {
    margin: "4px 0 0",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  if (type === "model.message") {
    const reasoning = str(event, "reasoningContent", "reasoning_content");
    const content = typeof event.content === "string" ? event.content : null;
    const calls = toolCallsOf(event);
    return (
      <div>
        {reasoning ? <pre style={{ ...pre, color: "#999" }}>{reasoning}</pre> : null}
        {content ? <pre style={pre}>{content}</pre> : null}
        {calls.map((call, i) => {
          const fn = (call.function ?? {}) as Record<string, unknown>;
          return (
            <pre key={i} style={{ ...pre, color: "#ffd479" }}>
              {`call ${String(fn.name ?? "?")}(${String(fn.arguments ?? "")})`}
            </pre>
          );
        })}
      </div>
    );
  }

  if (type === "tool.response") {
    return <pre style={{ ...pre, color: "#9ee493" }}>{String(event.content ?? "")}</pre>;
  }

  if (type === "turn.done") {
    const state = (event.state ?? {}) as Record<string, unknown>;
    const status = String(state.status ?? "?");
    const message = typeof state.message === "string" ? state.message : null;
    const failed = status !== "done";
    return (
      <pre style={{ ...pre, color: failed ? "#ff8080" : undefined }}>
        {`status: ${status}`}
        {message ? `\n${message}` : ""}
      </pre>
    );
  }

  if (type === "client.error" || type === "client.parse_error") {
    return <pre style={{ ...pre, color: "#ff8080" }}>{JSON.stringify(event, null, 2)}</pre>;
  }

  return <pre style={{ ...pre, opacity: 0.7 }}>{JSON.stringify(event)}</pre>;
}

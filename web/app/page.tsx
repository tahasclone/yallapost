"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { readSseStream } from "@/lib/stream-client";

type Event = Record<string, unknown>;

interface PendingCall {
  threadId: string;
  toolCallId: string;
  sourceEventId?: string;
}

interface ResolvedCall {
  name: string;
  args: string;
}

type Decision = "allow" | "deny";

const DENY_REASON = "Rejected by the operator in the app UI.";
const MAX_ARGS_SHOWN = 800;

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

/** Pretty-print JSON arguments when they parse, otherwise show them raw. */
function formatArgs(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "(no arguments)";
  let text = trimmed;
  try {
    text = JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    // Streaming can hand us a partial fragment; show it as-is.
  }
  return text.length > MAX_ARGS_SHOWN
    ? `${text.slice(0, MAX_ARGS_SHOWN)}\n... truncated`
    : text;
}

export default function Page() {
  const [events, setEvents] = useState<Event[]>([]);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<PendingCall[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const sessionId = useRef<string | null>(null);

  /**
   * Rebuild each tool call from the event stream.
   *
   * A pending approval carries only a tool call id and the id of the
   * model.message that requested it, so the name and arguments have to be
   * recovered from earlier events. Live streaming makes that awkward: the
   * model.message arrives first with `tool_calls: null`, then a series of
   * model.message.delta events share that same event id. The first delta
   * carries the tool call id and name with empty arguments, and every delta
   * after it carries only an argument fragment keyed by `index`.
   *
   * So slots are keyed by event id and call index, and argument fragments are
   * concatenated. A non-delta model.message with complete arguments (the shape
   * the persisted event list returns) replaces rather than appends, so both
   * shapes end up the same.
   */
  const { slots, byCallId } = useMemo(() => {
    const slots = new Map<
      string,
      { eventId: string; id?: string; name: string; args: string }
    >();

    for (const event of events) {
      const type = event.type;
      const isDelta = type === "model.message.delta";
      if (type !== "model.message" && !isDelta) continue;

      const eventId = str(event, "id");
      if (!eventId) continue;

      for (const call of toolCallsOf(event)) {
        const index = typeof call.index === "number" ? call.index : 0;
        const key = `${eventId}#${index}`;
        const slot = slots.get(key) ?? { eventId, name: "", args: "" };

        const id = str(call, "id");
        if (id) slot.id = id;

        const fn = (call.function ?? {}) as Record<string, unknown>;
        if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
        if (typeof fn.arguments === "string") {
          slot.args = isDelta ? slot.args + fn.arguments : fn.arguments || slot.args;
        }

        slots.set(key, slot);
      }
    }

    const byCallId = new Map<string, ResolvedCall>();
    for (const slot of slots.values()) {
      if (slot.id) byCallId.set(slot.id, { name: slot.name, args: slot.args });
    }

    return { slots: [...slots.values()], byCallId };
  }, [events]);

  const resolveCall = useCallback(
    (call: PendingCall): ResolvedCall => {
      if (call.sourceEventId) {
        const match = slots.find(
          (s) => s.eventId === call.sourceEventId && s.id === call.toolCallId,
        );
        if (match) return { name: match.name, args: match.args };
      }
      return byCallId.get(call.toolCallId) ?? { name: "unknown tool", args: "" };
    },
    [byCallId, slots],
  );

  const consume = useCallback(async (response: Response) => {
    await readSseStream(response, (event) => {
      setEvents((prev) => [...prev, event]);

      if (event.type === "client.session") {
        sessionId.current = str(event, "sessionId") ?? null;
      }

      if (event.type !== "tool.approval_required") return;

      const threadId = str(event, "threadId", "thread_id");
      if (!threadId) return;

      const found: PendingCall[] = toolCallsOf(event).flatMap((call) => {
        const toolCallId = str(call, "id");
        if (!toolCallId) return [];
        const sourceEventId = str(call, "sourceEventId", "source_event_id");
        return [{ threadId, toolCallId, ...(sourceEventId ? { sourceEventId } : {}) }];
      });

      // A paused turn can hold several calls, and the harness rejects a partial
      // batch, so every one of them has to be collected and answered together.
      setPending((prev) => {
        const known = new Set(prev.map((c) => c.toolCallId));
        return [...prev, ...found.filter((c) => !known.has(c.toolCallId))];
      });
    });
  }, []);

  const start = useCallback(async () => {
    setEvents([]);
    setPending([]);
    setDecisions({});
    sessionId.current = null;
    setRunning(true);
    try {
      await consume(await fetch("/api/run", { method: "POST" }));
    } catch (error) {
      setEvents((prev) => [
        ...prev,
        { type: "client.error", message: String(error) },
      ]);
    } finally {
      setRunning(false);
    }
  }, [consume]);

  const submit = useCallback(
    async (chosen: Record<string, Decision>) => {
      const answered = pending;
      if (answered.length === 0 || !sessionId.current) return;

      const payload = answered.map((call) => ({
        threadId: call.threadId,
        toolCallId: call.toolCallId,
        decision: chosen[call.toolCallId],
        ...(chosen[call.toolCallId] === "deny" ? { reason: DENY_REASON } : {}),
      }));

      setPending([]);
      setDecisions({});
      setRunning(true);
      setEvents((prev) => [...prev, { type: "client.decisions", decisions: payload }]);

      try {
        await consume(
          await fetch("/api/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId.current, decisions: payload }),
          }),
        );
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

  const decideAll = useCallback(
    (decision: Decision) => {
      const all: Record<string, Decision> = {};
      for (const call of pending) all[call.toolCallId] = decision;
      void submit(all);
    },
    [pending, submit],
  );

  const allDecided =
    pending.length > 0 && pending.every((c) => decisions[c.toolCallId]);

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

      {pending.length > 0 ? (
        <section
          style={{
            border: "2px solid #e0a500",
            background: "#2a2200",
            padding: 12,
            margin: "12px 0",
          }}
        >
          <strong>
            Approval required ({pending.length} tool call
            {pending.length === 1 ? "" : "s"})
          </strong>

          {pending.map((call) => {
            const resolved = resolveCall(call);
            const chosen = decisions[call.toolCallId];
            return (
              <div
                key={call.toolCallId}
                style={{ borderTop: "1px solid #5a4a00", marginTop: 10, paddingTop: 8 }}
              >
                <div style={{ color: "#ffd479" }}>{resolved.name}</div>
                <pre
                  style={{
                    margin: "4px 0",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: 12,
                  }}
                >
                  {formatArgs(resolved.args)}
                </pre>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  thread {call.threadId} / {call.toolCallId}
                </div>
                <div style={{ marginTop: 6 }}>
                  <button
                    onClick={() =>
                      setDecisions((prev) => ({ ...prev, [call.toolCallId]: "allow" }))
                    }
                    style={{
                      marginRight: 8,
                      padding: "4px 10px",
                      fontWeight: chosen === "allow" ? "bold" : "normal",
                    }}
                  >
                    {chosen === "allow" ? "✓ Approve" : "Approve"}
                  </button>
                  <button
                    onClick={() =>
                      setDecisions((prev) => ({ ...prev, [call.toolCallId]: "deny" }))
                    }
                    style={{
                      padding: "4px 10px",
                      fontWeight: chosen === "deny" ? "bold" : "normal",
                    }}
                  >
                    {chosen === "deny" ? "✓ Reject" : "Reject"}
                  </button>
                </div>
              </div>
            );
          })}

          <div style={{ marginTop: 12, borderTop: "1px solid #5a4a00", paddingTop: 10 }}>
            <button
              onClick={() => void submit(decisions)}
              disabled={!allDecided || running}
              style={{ marginRight: 8, padding: "6px 12px" }}
            >
              Submit {pending.length} decision{pending.length === 1 ? "" : "s"}
            </button>
            <button
              onClick={() => decideAll("allow")}
              disabled={running}
              style={{ marginRight: 8, padding: "6px 12px" }}
            >
              Approve all
            </button>
            <button
              onClick={() => decideAll("deny")}
              disabled={running}
              style={{ padding: "6px 12px" }}
            >
              Reject all
            </button>
            {!allDecided ? (
              <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 8 }}>
                Every call must be decided before the run can resume.
              </span>
            ) : null}
          </div>
        </section>
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

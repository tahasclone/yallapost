"use client";

import { Caveat } from "next/font/google";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  AgentCard,
  ApprovalGate,
  EdlTimeline,
  PackagePanel,
  TopicBoard,
  type AgentCardProps,
  type AgentState,
  type AgentTask,
  type Beat,
  type Subagent,
  type TaskStatus,
  type Topic,
} from "@/components/agents";
import styles from "@/components/agents/agents.module.css";
import { readSseStream } from "@/lib/stream-client";

const caveat = Caveat({ subsets: ["latin"], variable: "--font-hand", display: "swap" });

type Event = Record<string, unknown>;
type UiPhase =
  | "idle"
  | "scouting"
  | "topics_ready"
  | "producing"
  | "package_ready"
  | "editing"
  | "rendered"
  | "publishing"
  | "published";

interface PendingCall {
  threadId: string;
  toolCallId: string;
  sourceEventId?: string;
}

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

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** Everything the UI shows, derived from the raw event stream on every append. */
function deriveFromEvents(events: Event[]) {
  // Accumulate tool calls across streaming deltas: model.message arrives with
  // tool_calls null, then deltas share its event id; only the first fragment
  // carries the call id and name, the rest carry argument fragments by index.
  const slots = new Map<string, { eventId: string; id?: string; name: string; args: string }>();
  const responses = new Map<string, string>();
  const failures = new Map<string, string>();
  let mainReport = "";
  const threads = new Map<string, { name: string; status: TaskStatus; lastText: string }>();
  let sandboxCreated = false;
  let sandboxExecs = 0;
  let lastError: string | null = null;

  for (const event of events) {
    const type = event.type;
    const eventId = str(event, "id");

    if (type === "thread.created") {
      const info = (event.agentInfo ?? event.agent_info ?? {}) as Record<string, unknown>;
      const tid = str(event, "threadId", "thread_id") ?? eventId ?? "";
      threads.set(tid, {
        name: typeof info.name === "string" ? info.name : tid,
        status: "active",
        lastText: "",
      });
    }
    if (type === "thread.done") {
      const tid = str(event, "threadId", "thread_id") ?? "";
      const thread = threads.get(tid);
      if (thread) thread.status = "done";
    }
    if (type === "sandbox.created") sandboxCreated = true;

    if ((type === "model.message" || type === "model.message.delta") && eventId) {
      const isDelta = type === "model.message.delta";
      const tid = str(event, "threadId", "thread_id") ?? "";
      const content = typeof event.content === "string" ? event.content : null;
      if (content && threads.has(tid)) threads.get(tid)!.lastText += isDelta ? content : "";
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

    if (type === "tool.response") {
      const callId = str(event, "toolCallId", "tool_call_id");
      const content = typeof event.content === "string" ? event.content : "";
      if (callId) {
        // Error results arrive as tool.response too, wrapped in {"error": ...};
        // counting them as success would strike through a task that failed.
        const parsed = parseJson<Record<string, unknown>>(content);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          failures.set(callId, JSON.stringify(parsed.error).slice(0, 300));
        } else {
          responses.set(callId, content);
        }
      }
    }
    if (type === "model.message") {
      const tid = str(event, "threadId", "thread_id");
      const content = typeof event.content === "string" ? event.content : "";
      if (tid === "main" && content.trim()) mainReport = content;
    }
    if (type === "turn.done") {
      const state = (event.state ?? {}) as Record<string, unknown>;
      if (state.status !== "done") {
        lastError = typeof state.message === "string" ? state.message : String(state.status);
      }
    }
    if (type === "client.error") lastError = str(event, "message") ?? "unknown client error";
  }

  const byCallId = new Map<string, { name: string; args: string }>();
  for (const slot of slots.values()) {
    if (slot.id) byCallId.set(slot.id, { name: slot.name, args: slot.args });
  }

  const callsNamed = (name: string) =>
    [...byCallId.entries()].filter(([, v]) => v.name === name);
  const completed = (name: string) =>
    callsNamed(name).filter(([id]) => responses.has(id));

  // Sandbox executions: any tool call routed at the sandbox exec tool.
  sandboxExecs = [...byCallId.values()].filter((v) => /exec|run_code|bash|python/i.test(v.name)).length;

  // Topics from the last completed save_topics call.
  let topics: Topic[] = [];
  const savedTopics = completed("save_topics").at(-1);
  if (savedTopics) {
    const args = parseJson<{ topics: Array<Record<string, unknown>> }>(byCallId.get(savedTopics[0])?.args);
    const resp = parseJson<{ ids?: string[] }>(responses.get(savedTopics[0]) ?? "");
    if (args?.topics) {
      topics = args.topics.map((t, i) => ({
        id: resp?.ids?.[i] ?? `topic_${i + 1}`,
        title: String(t.title ?? ""),
        summary: String(t.summary ?? ""),
        velocity: `${Number(t.velocity ?? 0).toFixed(2)}/h`,
        evidence: (Array.isArray(t.evidence) ? t.evidence : []).slice(0, 5).map((e) => {
          const ev = e as Record<string, unknown>;
          return {
            source: String(ev.source ?? ""),
            relativeTime: relativeTime(String(ev.observed_at ?? "")),
            href: String(ev.url ?? "#"),
          };
        }),
      }));
    }
  }

  // Package from the last save_package call plus generate_image results.
  let pkg: { title: string; beats: Beat[]; imagesFailed: number } | null = null;
  const savedPackage = completed("save_package").at(-1);
  if (savedPackage) {
    const args = parseJson<{
      script?: { title?: string; beats?: Array<Record<string, unknown>> };
      image_urls?: string[];
    }>(byCallId.get(savedPackage[0])?.args);
    if (args?.script?.beats) {
      const imageByBeat = new Map<string, string>();
      let sequential: string[] = [];
      for (const [id, call] of callsNamed("generate_image")) {
        const resp = parseJson<{ image_url?: string }>(responses.get(id) ?? "");
        if (!resp?.image_url) continue;
        const input = parseJson<{ beat_id?: string }>(call.args);
        if (input?.beat_id) imageByBeat.set(input.beat_id, resp.image_url);
        else sequential.push(resp.image_url);
      }
      if (imageByBeat.size === 0 && (args.image_urls?.length ?? 0) > 0) {
        sequential = args.image_urls ?? [];
      }
      const failures = callsNamed("generate_image").length - completed("generate_image").length;
      pkg = {
        title: args.script.title ?? "Untitled",
        beats: args.script.beats.map((b, i) => ({
          id: String(b.id ?? `beat_${i + 1}`),
          text: String(b.text ?? ""),
          visual_cue: String(b.visual_cue ?? ""),
          image_url: imageByBeat.get(String(b.id)) ?? sequential[i],
        })),
        imagesFailed: failures,
      };
    }
  }

  // EDL and render result from the last render_video call.
  let edl: {
    sourceVideo: string;
    clips: Array<{ beat_id: string; source_start: number; source_end: number; image_url?: string }>;
    captionCount: number;
  } | null = null;
  let render: { outputPath: string; duration: number } | null = null;
  const renderCall = callsNamed("render_video").at(-1);
  if (renderCall) {
    const args = parseJson<{
      edl?: {
        source_video?: string;
        clips?: Array<Record<string, unknown>>;
        captions?: unknown[];
      };
    }>(byCallId.get(renderCall[0])?.args);
    if (args?.edl?.clips) {
      edl = {
        sourceVideo: args.edl.source_video ?? "",
        clips: args.edl.clips.map((c) => ({
          beat_id: String(c.beat_id ?? ""),
          source_start: Number(c.source_start ?? 0),
          source_end: Number(c.source_end ?? 0),
          image_url: typeof c.image_url === "string" ? c.image_url : undefined,
        })),
        captionCount: args.edl.captions?.length ?? 0,
      };
    }
    const resp = parseJson<{ output_path?: string; duration_seconds?: number }>(
      responses.get(renderCall[0]) ?? "",
    );
    if (resp?.output_path) {
      render = { outputPath: resp.output_path, duration: resp.duration_seconds ?? 0 };
    }
  }

  // Publish result.
  let postUrl: string | null = null;
  const published = completed("publish_post").at(-1);
  if (published) {
    const resp = parseJson<{ post_url?: string }>(responses.get(published[0]) ?? "");
    postUrl = resp?.post_url ?? null;
  }

  // Scout subagent rows with parsed item counts where their JSON is readable.
  const subagents: Subagent[] = [...threads.entries()]
    .filter(([tid]) => tid !== "main")
    .map(([, t]) => {
      const parsed = parseJson<{ items?: unknown[]; status?: string }>(
        t.lastText.slice(t.lastText.indexOf("{")),
      );
      return {
        source: t.name,
        status: t.status,
        itemCount: parsed?.items?.length,
      };
    });

  const toolDone = (name: string) => completed(name).length > 0;
  const toolActive = (name: string) => callsNamed(name).length > completed(name).length;

  const failedTools = [...failures.entries()].map(([id, message]) => ({
    tool: byCallId.get(id)?.name ?? "unknown",
    message,
  }));

  return {
    slots,
    byCallId,
    responses,
    failedTools,
    mainReport,
    subagents,
    sandboxCreated,
    sandboxExecs,
    topics,
    pkg,
    edl,
    render,
    postUrl,
    lastError,
    toolDone,
    toolActive,
  };
}

export default function Page() {
  const [events, setEvents] = useState<Event[]>([]);
  const [phase, setPhase] = useState<UiPhase>("idle");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingCall[]>([]);
  const [pickedTopic, setPickedTopic] = useState<string | null>(null);
  const [editedBeats, setEditedBeats] = useState<Record<string, string>>({});
  const [uploadPath, setUploadPath] = useState<string | null>(null);
  const sessionId = useRef<string | null>(null);

  const derived = useMemo(() => deriveFromEvents(events), [events]);

  const consume = useCallback(async (response: Response) => {
    await readSseStream(response, (event) => {
      setEvents((prev) => [...prev, event]);
      if (event.type === "client.session") {
        sessionId.current = str(event, "sessionId") ?? null;
      }
      if (event.type === "tool.approval_required") {
        const threadId = str(event, "threadId", "thread_id");
        if (!threadId) return;
        const found: PendingCall[] = toolCallsOf(event).flatMap((call) => {
          const toolCallId = str(call, "id");
          if (!toolCallId) return [];
          const sourceEventId = str(call, "sourceEventId", "source_event_id");
          return [{ threadId, toolCallId, ...(sourceEventId ? { sourceEventId } : {}) }];
        });
        setPending((prev) => {
          const known = new Set(prev.map((c) => c.toolCallId));
          return [...prev, ...found.filter((c) => !known.has(c.toolCallId))];
        });
      }
    });
  }, []);

  const run = useCallback(
    async (request: () => Promise<Response>, during: UiPhase, after: UiPhase) => {
      setBusy(true);
      setPhase(during);
      try {
        await consume(await request());
        setPhase(after);
      } catch (error) {
        setEvents((prev) => [...prev, { type: "client.error", message: String(error) }]);
        setPhase(after);
      } finally {
        setBusy(false);
      }
    },
    [consume],
  );

  const startScout = useCallback(() => {
    setEvents([]);
    setPending([]);
    setPickedTopic(null);
    setEditedBeats({});
    setUploadPath(null);
    sessionId.current = null;
    void run(() => fetch("/api/pipeline/start", { method: "POST" }), "scouting", "topics_ready");
  }, [run]);

  const turn = useCallback(
    (message: string, during: UiPhase, after: UiPhase) => {
      if (!sessionId.current) return;
      void run(
        () =>
          fetch("/api/pipeline/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId.current, message }),
          }),
        during,
        after,
      );
    },
    [run],
  );

  const produce = useCallback(() => {
    if (!pickedTopic) return;
    turn(`Run the PRODUCE stage for topic ${pickedTopic}.`, "producing", "package_ready");
  }, [pickedTopic, turn]);

  const upload = useCallback(async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    const parsed = (await response.json()) as { path?: string; error?: string };
    if (!response.ok || !parsed.path) {
      setEvents((prev) => [
        ...prev,
        { type: "client.error", message: parsed.error ?? "upload failed" },
      ]);
      return;
    }
    setUploadPath(parsed.path);
  }, []);

  const edit = useCallback(() => {
    if (!uploadPath || !derived.pkg) return;
    const beats = derived.pkg.beats.map((b) => ({
      id: b.id,
      text: editedBeats[b.id] ?? b.text,
      visual_cue: b.visual_cue,
    }));
    turn(
      `Run the EDIT stage. The clip is at ${uploadPath}. Use this script (the operator may have edited it): ${JSON.stringify(beats)}`,
      "editing",
      "rendered",
    );
  }, [derived.pkg, editedBeats, turn, uploadPath]);

  const publish = useCallback(() => {
    turn("Run the PUBLISH stage for instagram.", "publishing", "publishing");
  }, [turn]);

  const decide = useCallback(
    async (decision: "allow" | "deny", reason?: string) => {
      if (!sessionId.current || pending.length === 0) return;
      const payload = pending.map((call) => ({
        threadId: call.threadId,
        toolCallId: call.toolCallId,
        decision,
        ...(decision === "deny" ? { reason } : {}),
      }));
      setPending([]);
      setBusy(true);
      try {
        await consume(
          await fetch("/api/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId.current, decisions: payload }),
          }),
        );
        if (decision === "allow") setPhase("published");
      } catch (error) {
        setEvents((prev) => [...prev, { type: "client.error", message: String(error) }]);
      } finally {
        setBusy(false);
      }
    },
    [consume, pending],
  );

  // Resolve the pending approval's tool name and arguments for the gate.
  const gate = useMemo(() => {
    const call = pending[0];
    if (!call) return null;
    let resolved = { name: "unknown tool", args: "" };
    if (call.sourceEventId) {
      for (const slot of derived.slots.values()) {
        if (slot.eventId === call.sourceEventId && slot.id === call.toolCallId) {
          resolved = { name: slot.name, args: slot.args };
        }
      }
    }
    if (resolved.name === "unknown tool") {
      const found = derived.byCallId.get(call.toolCallId);
      if (found) resolved = found;
    }
    const args = parseJson<{ platform?: string; caption?: string; video_path?: string }>(resolved.args);
    return {
      toolName: resolved.name,
      platform: args?.platform ?? "",
      caption: args?.caption ?? "",
      videoPath: args?.video_path,
      rawArguments: resolved.args,
    };
  }, [derived.byCallId, derived.slots, pending]);

  // Agent card state machine, driven by the derived tool activity.
  const cards = useMemo((): AgentCardProps[] => {
    const d = derived;
    const editorFailure = d.failedTools.find((f) =>
      ["transcribe", "render_video"].includes(f.tool),
    );
    const scoutTasks: AgentTask[] = [
      { id: "watchlist", label: "Read the watchlist", status: d.toolDone("get_watchlist") ? "done" : phase === "scouting" ? "active" : "pending" },
      { id: "feeds", label: "Fetch all RSS feeds in one call", status: d.toolDone("fetch_feeds") ? "done" : d.toolActive("fetch_feeds") ? "active" : "pending" },
      { id: "fanout", label: "Fan out source subagents", status: d.subagents.length > 0 ? (d.subagents.every((s) => s.status === "done") ? "done" : "active") : "pending" },
      { id: "cluster", label: "Cluster + velocity in sandbox", status: d.topics.length > 0 ? "done" : d.sandboxCreated && phase === "scouting" ? "active" : "pending" },
      { id: "save", label: "Save three topics", status: d.toolDone("save_topics") ? "done" : "pending" },
    ];
    const producerTasks: AgentTask[] = [
      { id: "script", label: "Write the beat script", status: d.pkg ? "done" : phase === "producing" ? "active" : "pending" },
      { id: "images", label: "Generate beat images", status: d.pkg ? (d.pkg.imagesFailed > 0 ? "done" : "done") : d.toolActive("generate_image") ? "active" : "pending" },
      { id: "package", label: "Save the package", status: d.toolDone("save_package") ? "done" : "pending" },
    ];
    const editorTasks: AgentTask[] = [
      { id: "upload", label: "Receive the recording", status: uploadPath ? "done" : "pending" },
      { id: "transcribe", label: "Transcribe the clip", status: d.toolDone("transcribe") ? "done" : d.toolActive("transcribe") ? "active" : "pending" },
      { id: "edl", label: "Align beats → EDL in sandbox", status: d.edl ? "done" : phase === "editing" && d.toolDone("transcribe") ? "active" : "pending" },
      { id: "render", label: "Render with ffmpeg", status: d.render ? "done" : d.toolActive("render_video") ? "active" : "pending" },
    ];
    const publisherTasks: AgentTask[] = [
      { id: "caption", label: "Draft caption + hashtags", status: pending.length > 0 || d.postUrl ? "done" : phase === "publishing" ? "active" : "pending" },
      { id: "approval", label: "Human approval gate", status: d.postUrl ? "done" : pending.length > 0 ? "active" : "pending" },
      { id: "publish", label: "Publish the post", status: d.postUrl ? "done" : "pending" },
    ];

    const stateOf = (tasks: AgentTask[], activePhases: UiPhase[], blocked?: string): AgentState => {
      if (blocked) return "blocked";
      if (tasks.every((t) => t.status === "done")) return "done";
      if (activePhases.includes(phase) || tasks.some((t) => t.status === "active")) return "working";
      return "idle";
    };

    return [
      { name: "Scout", role: "Signal researcher", state: stateOf(scoutTasks, ["scouting"]), tasks: scoutTasks, subagents: d.subagents.length > 0 ? d.subagents : undefined },
      { name: "Producer", role: "Script and image maker", state: stateOf(producerTasks, ["producing"]), tasks: producerTasks },
      {
        name: "Editor",
        role: "Video assembly",
        state:
          (phase === "package_ready" && !uploadPath) || editorFailure
            ? "blocked"
            : stateOf(editorTasks, ["editing"]),
        tasks: editorTasks,
        blockedOn: editorFailure
          ? `Blocked on a failed tool: ${editorFailure.tool} — ${editorFailure.message}`
          : phase === "package_ready" && !uploadPath
            ? "Waiting on your recorded clip. Upload it below to continue."
            : undefined,
      },
      {
        name: "Publisher",
        role: "Caption and release",
        state: pending.length > 0 ? "blocked" : stateOf(publisherTasks, ["publishing"]),
        tasks: publisherTasks,
        blockedOn:
          pending.length > 0
            ? "Publishing is irreversible. The post is drafted and waiting for your approval below."
            : undefined,
      },
    ];
  }, [derived, pending.length, phase, uploadPath]);

  const beatsForPanel: Beat[] =
    derived.pkg?.beats.map((b) => ({ ...b, text: editedBeats[b.id] ?? b.text })) ?? [];

  return (
    <main className={`${caveat.variable} ${styles.page ?? ""}`} style={{ maxWidth: 1080, margin: "0 auto", padding: 20 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-hand), cursive", fontSize: "2.2rem", margin: 0 }}>
            YallaPost
          </h1>
          <p style={{ margin: "2px 0 0", opacity: 0.75 }}>
            Your daily content crew: scout → produce → edit → publish, with you at the gate.
          </p>
        </div>
        <button className={styles.runButton} disabled={busy} onClick={startScout}>
          {phase === "idle" ? "Run today's scout" : busy && phase === "scouting" ? "Scouting…" : "Start over"}
        </button>
      </header>

      {derived.lastError ? (
        <p className={styles.errorLine} role="alert">
          ✗ {derived.lastError}
        </p>
      ) : null}

      {derived.failedTools.length > 0 ? (
        <p className={styles.errorLine} role="alert">
          ✗ Failed tools this run:{" "}
          {derived.failedTools.map((f) => f.tool).join(", ")} — details in the agent report below.
        </p>
      ) : null}

      {derived.mainReport ? (
        <details className={styles.eventLog} open={derived.failedTools.length > 0}>
          <summary>Agent report</summary>
          <pre>{derived.mainReport}</pre>
        </details>
      ) : null}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 16, marginTop: 20 }}>
        {cards.map((card) => (
          <AgentCard key={card.name} {...card} />
        ))}
      </section>

      {derived.topics.length > 0 ? (
        <>
          <TopicBoard topics={derived.topics} selectedTopicId={pickedTopic} onSelect={setPickedTopic} />
          {phase === "topics_ready" || (pickedTopic && !derived.pkg) ? (
            <button className={styles.runButton} disabled={!pickedTopic || busy} onClick={produce}>
              {busy && phase === "producing" ? "Producer is working…" : "Send to Producer →"}
            </button>
          ) : null}
        </>
      ) : null}

      {derived.pkg ? (
        <>
          <PackagePanel
            title={derived.pkg.title}
            beats={beatsForPanel}
            onBeatTextChange={(beatId, text) => setEditedBeats((prev) => ({ ...prev, [beatId]: text }))}
            imagesNote={
              derived.pkg.imagesFailed > 0
                ? `${derived.pkg.imagesFailed} image generation call(s) failed — beats without images are marked. No placeholders were substituted.`
                : undefined
            }
          />
          <div className={styles.uploadBox}>
            <p style={{ fontFamily: "var(--font-hand), cursive", fontSize: "1.3rem", margin: "0 0 8px" }}>
              Record your take, then drop it here.
            </p>
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/x-m4v,video/webm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            {uploadPath ? (
              <>
                <p>
                  ✓ <code>{uploadPath}</code>
                </p>
                <button className={styles.runButton} disabled={busy} onClick={edit}>
                  {busy && phase === "editing" ? "Editor is cutting…" : "Send to Editor →"}
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      {derived.edl ? (
        <EdlTimeline
          clips={derived.edl.clips}
          captionCount={derived.edl.captionCount}
          sourceVideo={derived.edl.sourceVideo}
        />
      ) : null}

      {derived.render ? (
        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <p className={styles.sectionKicker}>Editor rendered</p>
            <h2>
              {derived.render.duration.toFixed(1)}s cut, ready to review
            </h2>
          </header>
          <video className={styles.videoPreview} src={`/api/media/${derived.render.outputPath}`} controls preload="metadata" />
          {!derived.postUrl && pending.length === 0 ? (
            <div style={{ marginTop: 12 }}>
              <button className={styles.runButton} disabled={busy} onClick={publish}>
                {busy && phase === "publishing" ? "Publisher is drafting…" : "Send to Publisher →"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {gate ? (
        <ApprovalGate
          toolName={gate.toolName}
          platform={gate.platform}
          caption={gate.caption}
          videoSrc={gate.videoPath ? `/api/media/${gate.videoPath}` : undefined}
          rawArguments={gate.rawArguments}
          busy={busy}
          onApprove={() => void decide("allow")}
          onReject={(reason) => void decide("deny", reason)}
        />
      ) : null}

      {derived.postUrl ? (
        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <p className={styles.sectionKicker}>Published</p>
            <h2>It's live.</h2>
            <p>
              <a href={derived.postUrl} target="_blank" rel="noreferrer">
                {derived.postUrl}
              </a>
            </p>
          </header>
        </section>
      ) : null}

      <details className={styles.eventLog}>
        <summary>Raw harness event stream ({events.length} events)</summary>
        <pre>
          {events
            .map((e) => JSON.stringify(e))
            .join("\n")}
        </pre>
      </details>
    </main>
  );
}

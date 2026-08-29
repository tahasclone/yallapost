import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stubId, TRANSCRIPT } from "./fixtures.js";
import { WATCHLIST } from "./watchlist.js";
import {
  GetWatchlistOutputSchema,
  PublishPostInputSchema,
  PublishPostOutputSchema,
  RenderVideoInputSchema,
  RenderVideoOutputSchema,
  SavePackageInputSchema,
  SavePackageOutputSchema,
  SaveTopicsInputSchema,
  SaveTopicsOutputSchema,
  TranscribeInputSchema,
  TranscribeOutputSchema,
} from "./schemas.js";

/**
 * How the human approval gate works
 * ---------------------------------
 * TrueForge decides whether a tool needs human approval from its MCP
 * annotations. From the harness's `_is_destructive`:
 *
 *     destructive = annotations.get("destructiveHint")
 *     read_only   = annotations.get("readOnlyHint")
 *     return bool(destructive) or (not read_only and read_only is not None)
 *
 * A tool is destructive if `destructiveHint` is true, OR if `readOnlyHint` is
 * present and false. Destructive tools cannot be called from Code Mode at all —
 * the harness refuses and tells the agent to call them directly so they route
 * through the approval flow.
 *
 * The consequence that is easy to get wrong: setting `readOnlyHint: false` on
 * an ordinary write tool marks it destructive too, which would gate every save
 * behind a human click and lock those tools out of Code Mode. So tools that
 * write but are safe to retry (save_topics, save_package, render_video) omit
 * `readOnlyHint` entirely rather than setting it to false.
 *
 * Only publish_post is annotated destructive. It is the one irreversible step.
 */

export function registerTools(server: McpServer): void {
  // --- SCOUT -------------------------------------------------------------

  server.registerTool(
    "get_watchlist",
    {
      title: "Get watchlist",
      description:
        "Return the creator handles, keyword searches, and RSS feeds to monitor for trending topics. Call this first in the SCOUT stage to learn what to scan.",
      inputSchema: {},
      outputSchema: GetWatchlistOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      // Real configuration, versioned in watchlist.ts. A per-user database
      // read replaces this when accounts exist.
      return structured(WATCHLIST);
    },
  );

  server.registerTool(
    "save_topics",
    {
      title: "Save trending topics",
      description:
        "Persist the trending topics found during SCOUT so the creator can pick one. Every topic must carry the evidence it was clustered from.",
      inputSchema: SaveTopicsInputSchema,
      outputSchema: SaveTopicsOutputSchema.shape,
      // No readOnlyHint: this writes, but it is safe to retry and must stay
      // callable from Code Mode. See the note at the top of this file.
      annotations: {
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topics }) => {
      // TODO: replace with an insert into the topics table, returning real
      // row ids and de-duplicating against topics already saved today.
      const ids = topics.map((_, i) => stubId("topic", i + 1));
      return structured({ saved: topics.length, ids });
    },
  );

  // --- PRODUCE -----------------------------------------------------------

  server.registerTool(
    "save_package",
    {
      title: "Save content package",
      description:
        "Persist a produced script and its generated images against a topic. Returns the package_id the EDIT stage works from.",
      inputSchema: SavePackageInputSchema,
      outputSchema: SavePackageOutputSchema.shape,
      annotations: {
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ topic_id }) => {
      // TODO: replace with an insert into the packages table, linked to
      // topic_id, storing the script beats and the image URLs.
      return structured({ package_id: `pkg_for_${topic_id}` });
    },
  );

  // --- EDIT --------------------------------------------------------------

  server.registerTool(
    "transcribe",
    {
      title: "Transcribe clip",
      description:
        "Transcribe an uploaded video clip into timestamped segments. Use these timestamps to align script beats to the real recording.",
      inputSchema: TranscribeInputSchema,
      outputSchema: TranscribeOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      // TODO: replace with a real speech-to-text call over the uploaded file,
      // returning word-level timings collapsed into segments.
      return structured(TRANSCRIPT);
    },
  );

  server.registerTool(
    "render_video",
    {
      title: "Render video from EDL",
      description:
        "Render a video from an Edit Decision List. The EDL is the source of truth for the cut: clips in order, each tied to a script beat.",
      inputSchema: RenderVideoInputSchema,
      outputSchema: RenderVideoOutputSchema.shape,
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ edl }) => {
      // TODO: replace with a real render (ffmpeg) that cuts source_video at
      // each clip's source_start/source_end and overlays image_url per beat.
      const duration = edl.clips.reduce(
        (total, clip) => total + (clip.source_end - clip.source_start),
        0,
      );
      return structured({
        output_path: "renders/stub-render.mp4",
        duration_seconds: Number(duration.toFixed(2)),
      });
    },
  );

  // --- PUBLISH -----------------------------------------------------------

  server.registerTool(
    "publish_post",
    {
      title: "Publish post",
      description:
        "Publish the rendered video with its caption. This is irreversible and posts publicly, so it requires human approval before it runs.",
      inputSchema: PublishPostInputSchema,
      outputSchema: PublishPostOutputSchema.shape,
      // The approval gate. destructiveHint routes this through TrueForge's
      // human approval flow and blocks it from Code Mode.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ platform }) => {
      // TODO: replace with the real platform publish call, and only after the
      // harness reports the approval was granted.
      return structured({ post_url: `https://${platform}.com/p/stub-post-id` });
    },
  );
}

/**
 * Return a tool result carrying both `structuredContent` (validated against the
 * tool's output schema) and a text rendering for models that read content only.
 */
function structured<T>(value: T) {
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

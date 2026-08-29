import { z } from "zod";

/**
 * Tool contracts for the daily content agent.
 *
 * These schemas are the contract between the agent and our app. The tool
 * implementations in `tools.ts` are stubs returning fixtures, but they return
 * these exact shapes, so swapping in real logic later cannot break callers.
 *
 * Every tool declares an output schema. The MCP SDK validates the
 * `structuredContent` we return against it on every call, so a stub that
 * drifts from its contract fails loudly instead of silently.
 */

export const PlatformSchema = z
  .enum(["instagram", "x"])
  .describe("Social platform a handle or post belongs to.");

// --- SCOUT ---------------------------------------------------------------

export const WatchlistHandleSchema = z.object({
  platform: PlatformSchema,
  handle: z.string().describe("Account handle, without a leading @."),
});

export const GetWatchlistOutputSchema = z.object({
  handles: z
    .array(WatchlistHandleSchema)
    .describe("Creator accounts to monitor for emerging topics."),
  searches: z
    .array(z.string())
    .describe("Keyword queries to run through web search alongside the handles."),
  feeds: z
    .array(z.string().url())
    .describe("RSS feed URLs to monitor alongside the social handles."),
});

export const EvidenceSchema = z.object({
  platform: PlatformSchema.or(z.enum(["rss", "web"])).describe(
    "Where this piece of evidence came from. `web` is a search-engine result.",
  ),
  source: z
    .string()
    .describe(
      "Handle that posted it, the feed title for RSS items, or the site name for web results.",
    ),
  url: z.string().url().describe("Link to the specific post or article."),
  observed_at: z
    .string()
    .describe(
      "ISO 8601 timestamp of when the item was published, or when it was fetched if the source exposes no publish time.",
    ),
});

export const TopicSchema = z.object({
  title: z.string().describe("Short headline for the topic."),
  summary: z
    .string()
    .describe("Two or three sentences on what is happening and why it is rising."),
  velocity: z
    .number()
    .describe(
      "Mentions per hour across the watchlist over the last 24h. Higher means rising faster.",
    ),
  evidence: z
    .array(EvidenceSchema)
    .min(1)
    .describe(
      "The posts and articles this topic was clustered from. Never surface a topic without evidence.",
    ),
});

export const SaveTopicsInputSchema = {
  topics: z
    .array(TopicSchema)
    .min(1)
    .describe("Trending topics to persist for the creator to choose from."),
};

export const SaveTopicsOutputSchema = z.object({
  saved: z.number().int().describe("How many topics were persisted."),
  ids: z
    .array(z.string())
    .describe("IDs of the saved topics, in the same order as the input."),
});

export const FetchFeedInputSchema = {
  url: z.string().url().describe("RSS or Atom feed URL to fetch."),
};

export const FeedItemSchema = z.object({
  title: z.string().describe("Item headline, HTML stripped."),
  link: z.string().describe("Direct link to the article."),
  published_at: z
    .string()
    .describe("ISO 8601 publish time; the fetch time if the feed omits one."),
  summary: z.string().describe("Item summary, HTML stripped, truncated."),
  source: z.string().describe("Feed title this item came from."),
});

export const FetchFeedOutputSchema = z.object({
  source: z.string().describe("Feed title, or the URL when the feed has none."),
  url: z.string().describe("The feed URL that was fetched."),
  fetched_at: z.string().describe("ISO 8601 time of the fetch."),
  items: z.array(FeedItemSchema).describe("Feed entries, newest first as served."),
});

export const FeedResultSchema = z.object({
  url: z.string().describe("The feed URL that was attempted."),
  status: z.enum(["ok", "failed"]).describe("Whether the fetch succeeded."),
  error: z.string().optional().describe("Failure reason when status is failed."),
  feed: FetchFeedOutputSchema.optional().describe("The parsed feed when status is ok."),
});

export const FetchFeedsOutputSchema = z.object({
  results: z
    .array(FeedResultSchema)
    .describe("One entry per watchlist feed, ok or failed, never fabricated."),
});

// --- PRODUCE -------------------------------------------------------------

export const BeatSchema = z.object({
  id: z
    .string()
    .describe(
      "Stable beat identifier, e.g. `beat_1`. The EDL references beats by this id.",
    ),
  text: z.string().describe("What the creator says during this beat."),
  visual_cue: z
    .string()
    .describe("What should be on screen during this beat."),
});

export const ScriptSchema = z.object({
  title: z.string().describe("Working title for the piece."),
  beats: z
    .array(BeatSchema)
    .min(1)
    .describe("Ordered beats. Beat order defines the order of the final cut."),
});

export const SavePackageInputSchema = {
  topic_id: z
    .string()
    .describe("ID of the topic this package was produced for, from save_topics."),
  script: ScriptSchema,
  image_urls: z
    .array(z.string().url())
    .describe("Generated images, one per beat where a visual is needed."),
};

export const SavePackageOutputSchema = z.object({
  package_id: z
    .string()
    .describe("ID of the stored package. Pass this to the EDIT stage."),
});

export const GenerateImageInputSchema = {
  prompt: z
    .string()
    .min(3)
    .describe("Visual description for the beat's image."),
  beat_id: z
    .string()
    .optional()
    .describe("Beat this image belongs to, for traceability."),
};

export const GenerateImageOutputSchema = z.object({
  image_url: z.string().url().describe("URL of the generated image."),
  model: z.string().describe("Model that generated it."),
});

// --- EDIT ----------------------------------------------------------------

export const TranscribeInputSchema = {
  video_path: z
    .string()
    .describe("Path to the uploaded clip, relative to the sandbox working directory."),
};

export const TranscriptSegmentSchema = z.object({
  start: z.number().describe("Segment start in seconds from the top of the clip."),
  end: z.number().describe("Segment end in seconds from the top of the clip."),
  text: z.string().describe("What was said in this segment."),
});

export const TranscribeOutputSchema = z.object({
  segments: z
    .array(TranscriptSegmentSchema)
    .describe("Transcript segments in chronological order."),
});

export const EdlClipSchema = z.object({
  beat_id: z
    .string()
    .describe("Beat this clip covers, from the script saved in save_package."),
  source_start: z.number().describe("Where the clip starts in the source video, in seconds."),
  source_end: z.number().describe("Where the clip ends in the source video, in seconds."),
  image_url: z
    .string()
    .url()
    .optional()
    .describe("Image to overlay for this beat, if any."),
});

export const EdlCaptionSchema = z.object({
  start: z.number().describe("Caption start in source-video seconds."),
  end: z.number().describe("Caption end in source-video seconds."),
  text: z.string().describe("Caption text, usually a transcript segment."),
});

export const EdlSchema = z.object({
  source_video: z.string().describe("Path to the clip the cuts are taken from."),
  clips: z
    .array(EdlClipSchema)
    .min(1)
    .describe("Ordered cuts. Clip order defines the order of the final video."),
  captions: z
    .array(EdlCaptionSchema)
    .optional()
    .describe(
      "Transcript segments to burn in, timed against the source video; the renderer remaps them to the output timeline.",
    ),
});

export const RenderVideoInputSchema = {
  edl: EdlSchema.describe("Edit Decision List describing the cut to render."),
};

export const RenderVideoOutputSchema = z.object({
  output_path: z.string().describe("Path to the rendered video file."),
  duration_seconds: z.number().describe("Duration of the rendered video."),
});

// --- PUBLISH -------------------------------------------------------------

export const PublishPostInputSchema = {
  platform: PlatformSchema.describe("Where to publish."),
  video_path: z.string().describe("Path to the rendered video to publish."),
  caption: z.string().describe("Caption text, including any hashtags."),
};

export const PublishPostOutputSchema = z.object({
  post_url: z.string().url().describe("Public URL of the published post."),
});

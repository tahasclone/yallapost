/**
 * The hardcoded prompt for the demo run.
 *
 * It walks the full pipeline and ends on publish_post, which is the tool that
 * pauses for human approval. That pause is what this UI exists to prove.
 */
export const DEMO_PROMPT = [
  "Run one full daily content cycle end to end:",
  "1. Read the watchlist.",
  "2. Save two trending topics, each with at least one piece of evidence.",
  "3. Produce a package for the first topic: a short script with two beats, plus one placeholder image URL.",
  "4. Transcribe the clip at uploads/take1.mp4.",
  "5. Build an EDL from the transcript timings and render the video.",
  '6. Publish the rendered video to instagram with the caption "Built a daily content agent on TrueForge this week."',
].join("\n");

import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveUnder } from "./store.js";

/**
 * Real transcription via OpenAI Whisper.
 *
 * Requires OPENAI_API_KEY in mcp-server/.env. Without it the tool fails with
 * instructions instead of returning fixture segments: a fabricated transcript
 * would silently poison the EDL downstream.
 */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "transcribe is not configured: set OPENAI_API_KEY in mcp-server/.env (used for Whisper) and restart the MCP server.",
    );
  }
  return key;
}

export async function transcribe(videoPath: string): Promise<TranscriptSegment[]> {
  const key = apiKey();
  const absolute = resolveUnder("uploads", videoPath);

  const bytes = readFileSync(absolute);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)]),
    path.basename(absolute),
  );
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Whisper request failed: HTTP ${response.status}: ${detail}`);
  }

  const parsed = (await response.json()) as {
    segments?: Array<{ start: number; end: number; text: string }>;
  };
  if (!parsed.segments || parsed.segments.length === 0) {
    throw new Error("Whisper returned no segments for this clip");
  }
  return parsed.segments.map((s) => ({
    start: Number(s.start.toFixed(2)),
    end: Number(s.end.toFixed(2)),
    text: s.text.trim(),
  }));
}

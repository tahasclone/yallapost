import { statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegBin } from "./render.js";
import { resolveUnder } from "./store.js";

const execFileAsync = promisify(execFile);

/**
 * Real transcription via OpenAI Whisper.
 *
 * Requires OPENAI_API_KEY in mcp-server/.env. Without it the tool fails with
 * instructions instead of returning fixture segments: a fabricated transcript
 * would silently poison the EDL downstream.
 *
 * The uploaded video never goes to the API directly. Whisper caps requests at
 * 25MB and does not accept every container we accept for upload (iPhone .mov
 * included), so the audio track is extracted first with ffmpeg as mono 16kHz
 * mp3, which is small and always a supported format.
 */

const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

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

async function extractAudio(videoPath: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const work = await mkdtemp(path.join(os.tmpdir(), "whisper-"));
  const audioPath = path.join(work, "audio.mp3");
  try {
    await execFileAsync(
      ffmpegBin("ffmpeg"),
      ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audioPath],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Audio extraction failed (does the clip have an audio track?): ${message.slice(0, 250)}`);
  }
  const size = statSync(audioPath).size;
  if (size > WHISPER_MAX_BYTES) {
    await rm(work, { recursive: true, force: true });
    throw new Error(
      `Extracted audio is ${size} bytes, above Whisper's ${WHISPER_MAX_BYTES} limit; the clip is too long to transcribe in one call.`,
    );
  }
  return { file: audioPath, cleanup: () => rm(work, { recursive: true, force: true }) };
}

export async function transcribe(videoPath: string): Promise<TranscriptSegment[]> {
  const key = apiKey();
  const absolute = resolveUnder("uploads", videoPath);

  const { file, cleanup } = await extractAudio(absolute);
  try {
    const bytes = await readFile(file);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), "audio.mp3");
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
  } finally {
    await cleanup();
  }
}

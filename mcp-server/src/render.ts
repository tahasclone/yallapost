import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { REPO_ROOT, resolveUnder } from "./store.js";

const execFileAsync = promisify(execFile);

/**
 * Real EDL rendering with ffmpeg.
 *
 * The EDL is the source of truth: each clip cuts source_start..source_end out
 * of the source video, cuts are concatenated in order, each beat's image is
 * overlaid during its clip's window, and captions are burned in from the
 * transcript, re-timed from source time to output time.
 */

const RENDER_TIMEOUT_MS = 300_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const OVERLAY_WIDTH = 420;

export interface EdlClip {
  beat_id: string;
  source_start: number;
  source_end: number;
  image_url?: string;
}

export interface EdlCaption {
  start: number;
  end: number;
  text: string;
}

export interface Edl {
  source_video: string;
  clips: EdlClip[];
  captions?: EdlCaption[];
}

function ffmpegBin(name: "ffmpeg" | "ffprobe"): string {
  return process.env[`${name.toUpperCase()}_BIN`] ?? `/opt/homebrew/bin/${name}`;
}

/** Images come from the generation step; still: http(s) only, bounded, must be an image. */
async function downloadImage(url: string, dest: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Overlay image must be http(s), got ${parsed.protocol}`);
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status} for ${url}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) {
    throw new Error(`Overlay URL is not an image (content-type ${type}): ${url}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Overlay image exceeds ${MAX_IMAGE_BYTES} bytes: ${url}`);
  }
  writeFileSync(dest, buf);
}

async function hasAudio(file: string): Promise<boolean> {
  const { stdout } = await execFileAsync(ffmpegBin("ffprobe"), [
    "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
    "-of", "csv=p=0", file,
  ]);
  return stdout.trim().length > 0;
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync(ffmpegBin("ffprobe"), [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value)) throw new Error(`Could not probe duration of ${file}`);
  return Number(value.toFixed(2));
}

interface OutCaption {
  outStart: number;
  outEnd: number;
  text: string;
}

/**
 * Captions are timed against the source; the output is a concatenation of
 * cuts. Remap each caption into every output window it overlaps.
 */
function remapCaptions(edl: Edl): OutCaption[] {
  const captions = edl.captions ?? [];
  const out: OutCaption[] = [];
  let cursor = 0;
  for (const clip of edl.clips) {
    for (const cap of captions) {
      const start = Math.max(cap.start, clip.source_start);
      const end = Math.min(cap.end, clip.source_end);
      if (end - start < 0.05) continue;
      out.push({
        outStart: cursor + (start - clip.source_start),
        outEnd: cursor + (end - clip.source_start),
        text: cap.text,
      });
    }
    cursor += clip.source_end - clip.source_start;
  }
  return out;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Homebrew's ffmpeg ships without libass or freetype, so there is no
 * subtitles or drawtext filter. Captions are rendered here as transparent
 * PNG strips (sharp + SVG) and overlaid like any other image.
 */
async function captionPng(text: string, videoWidth: number, dest: string): Promise<void> {
  const width = Math.round(videoWidth * 0.9);
  const fontSize = Math.max(24, Math.round(videoWidth / 34));
  const height = Math.round(fontSize * 2.2);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="black" fill-opacity="0.55"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" fill="white">${escapeXml(text)}</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(dest);
}

async function probeWidth(file: string): Promise<number> {
  const { stdout } = await execFileAsync(ffmpegBin("ffprobe"), [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width",
    "-of", "csv=p=0", file,
  ]);
  const value = Number(stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : 1280;
}

export async function renderVideo(edl: Edl): Promise<{ output_path: string; duration_seconds: number }> {
  if (edl.clips.length === 0) throw new Error("EDL has no clips");
  const source = resolveUnder("uploads", edl.source_video);
  const rendersDir = path.join(REPO_ROOT, "renders");
  mkdirSync(rendersDir, { recursive: true });
  const outName = `render-${Date.now()}.mp4`;
  const outPath = path.join(rendersDir, outName);
  const work = await mkdtemp(path.join(os.tmpdir(), "edl-"));

  try {
    const audio = await hasAudio(source);

    // Download each distinct overlay image once.
    const imageFiles = new Map<string, string>();
    for (const clip of edl.clips) {
      if (clip.image_url && !imageFiles.has(clip.image_url)) {
        const dest = path.join(work, `img-${imageFiles.size}.png`);
        await downloadImage(clip.image_url, dest);
        imageFiles.set(clip.image_url, dest);
      }
    }

    const inputs: string[] = ["-i", source];
    const imageInputIndex = new Map<string, number>();
    for (const [url, file] of imageFiles) {
      imageInputIndex.set(url, inputs.length / 2);
      inputs.push("-i", file);
    }

    // Trim each cut, concat, overlay per-beat images, burn captions.
    const parts: string[] = [];
    edl.clips.forEach((clip, i) => {
      parts.push(
        `[0:v]trim=start=${clip.source_start}:end=${clip.source_end},setpts=PTS-STARTPTS[v${i}]`,
      );
      if (audio) {
        parts.push(
          `[0:a]atrim=start=${clip.source_start}:end=${clip.source_end},asetpts=PTS-STARTPTS[a${i}]`,
        );
      }
    });
    const concatIn = edl.clips.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
    parts.push(
      `${concatIn}concat=n=${edl.clips.length}:v=1:a=${audio ? 1 : 0}${audio ? "[vc][ac]" : "[vc]"}`,
    );

    let current = "vc";
    let cursor = 0;
    edl.clips.forEach((clip, i) => {
      const clipLen = clip.source_end - clip.source_start;
      if (clip.image_url) {
        const idx = imageInputIndex.get(clip.image_url);
        const scaled = `ov${i}`;
        const next = `vo${i}`;
        parts.push(`[${idx}:v]scale=${OVERLAY_WIDTH}:-1[${scaled}]`);
        parts.push(
          `[${current}][${scaled}]overlay=x=W-w-48:y=48:enable='between(t,${cursor.toFixed(3)},${(cursor + clipLen).toFixed(3)})'[${next}]`,
        );
        current = next;
      }
      cursor += clipLen;
    });

    const outCaptions = remapCaptions(edl);
    const videoWidth = await probeWidth(source);
    let capIdx = 0;
    for (const cap of outCaptions) {
      const capFile = path.join(work, `cap-${capIdx}.png`);
      await captionPng(cap.text, videoWidth, capFile);
      const inputIdx = inputs.length / 2;
      inputs.push("-i", capFile);
      const next = `vcap${capIdx}`;
      parts.push(
        `[${current}][${inputIdx}:v]overlay=x=(W-w)/2:y=H-h-56:enable='between(t,${cap.outStart.toFixed(3)},${cap.outEnd.toFixed(3)})'[${next}]`,
      );
      current = next;
      capIdx += 1;
    }
    const finalLabel = current;

    const args = [
      "-y",
      ...inputs,
      "-filter_complex", parts.join(";"),
      "-map", `[${finalLabel}]`,
      ...(audio ? ["-map", "[ac]"] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      ...(audio ? ["-c:a", "aac"] : []),
      "-movflags", "+faststart",
      outPath,
    ];
    await execFileAsync(ffmpegBin("ffmpeg"), args, {
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });

    const duration = await probeDuration(outPath);
    return { output_path: `renders/${outName}`, duration_seconds: duration };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

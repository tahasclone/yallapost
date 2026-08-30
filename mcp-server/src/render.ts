import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
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

/**
 * Resolve ffmpeg/ffprobe portably: explicit env override first, then common
 * absolute install locations, then the bare name for PATH resolution. The
 * old default hardcoded the Apple Silicon Homebrew path and broke everywhere
 * else.
 */
export function ffmpegBin(name: "ffmpeg" | "ffprobe"): string {
  const override = process.env[`${name.toUpperCase()}_BIN`];
  if (override) return override;
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:") // v4-mapped; conservative reject
    );
  }
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Overlay URLs arrive in a model-written EDL, so treat them as hostile:
 * http(s) only, no redirects, and the host must not resolve to loopback,
 * private, or link-local space (cloud metadata included). DNS is checked
 * before the fetch; a re-resolution race remains theoretically possible, but
 * the no-redirect rule closes the common laundering path.
 */
async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Overlay image must be http(s), got ${url.protocol}`);
  }
  const host = url.hostname;
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error(`Overlay image host does not resolve: ${host}`);
      });
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `Overlay image host resolves to a private or reserved address (${address}): ${raw}`,
      );
    }
  }
  return url;
}

/** Streamed download with the byte cap enforced as bytes arrive, not after. */
async function downloadImage(rawUrl: string, dest: string): Promise<void> {
  const url = await assertPublicHttpUrl(rawUrl);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status} for ${rawUrl}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) {
    throw new Error(`Overlay URL is not an image (content-type ${type}): ${rawUrl}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Image response had no body: ${rawUrl}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      void reader.cancel();
      throw new Error(`Overlay image exceeds ${MAX_IMAGE_BYTES} bytes: ${rawUrl}`);
    }
    chunks.push(value);
  }
  writeFileSync(dest, Buffer.concat(chunks));
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

import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

/**
 * Serve files from the repo-root uploads/ and renders/ directories so the UI
 * can preview clips and rendered videos. Range requests are honoured because
 * <video> scrubbing depends on them.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const parts = (await params).path;
  const repoRoot = path.resolve(process.cwd(), "..");
  const resolved = path.resolve(repoRoot, ...parts);
  const allowedRoots = [path.join(repoRoot, "uploads"), path.join(repoRoot, "renders")];
  if (!allowedRoots.some((root) => resolved.startsWith(root + path.sep))) {
    return Response.json({ error: "Only uploads/ and renders/ are served" }, { status: 403 });
  }
  if (!existsSync(resolved)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const size = statSync(resolved).size;
  const type = TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.get("range");

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match?.[1] !== undefined) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start <= end && start < size) {
        const stream = Readable.toWeb(
          createReadStream(resolved, { start, end }),
        ) as ReadableStream;
        return new Response(stream, {
          status: 206,
          headers: {
            "Content-Type": type,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
          },
        });
      }
    }
  }

  const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    },
  });
}

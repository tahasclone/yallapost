import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

/**
 * Accept the creator's recorded clip and store it under the repo-root
 * uploads/ directory, where the MCP server's transcribe and render tools
 * expect to find it. Returns the relative path to pass into the EDIT stage.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "multipart form with a `file` field required" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: `File exceeds ${MAX_UPLOAD_BYTES} bytes` }, { status: 413 });
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return Response.json(
      { error: `Unsupported extension ${ext || "(none)"}; use mp4, mov, m4v, or webm` },
      { status: 415 },
    );
  }

  const uploadsDir = path.resolve(process.cwd(), "..", "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const name = `clip-${Date.now()}${ext}`;
  writeFileSync(path.join(uploadsDir, name), Buffer.from(await file.arrayBuffer()));

  return Response.json({ path: `uploads/${name}` });
}

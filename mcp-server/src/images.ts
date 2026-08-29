import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Real image generation via the Higgsfield CLI.
 *
 * The CLI holds its own auth (`higgsfield auth login`); when it is missing or
 * unauthenticated the tool fails with the exact remedy rather than returning
 * a placeholder URL.
 */

const CLI_CANDIDATES = [
  process.env.HIGGSFIELD_BIN ?? "",
  "higgsfield",
  `${process.env.HOME}/.nvm/versions/node/v22.12.0/bin/higgsfield`,
].filter(Boolean);

const MODEL = process.env.HIGGSFIELD_MODEL?.trim() || "nano_banana_2";
const GENERATE_TIMEOUT_MS = 180_000;

function findCli(): string {
  // Absolute candidates first: the MCP server may run under a different nvm
  // node than the one the CLI was globally installed into, so PATH lookup
  // alone misses it.
  for (const candidate of CLI_CANDIDATES) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
  }
  return "higgsfield";
}

/** Pull the first plausible result URL out of the CLI's JSON output. */
function extractUrl(raw: string): string | null {
  const urls: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string" && /^https?:\/\//.test(v)) urls.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      walk(JSON.parse(trimmed));
    } catch {
      if (/^https?:\/\//.test(trimmed)) urls.push(trimmed);
    }
  }
  const media = urls.find((u) => /\.(png|jpe?g|webp)(\?|$)/i.test(u));
  return media ?? urls[urls.length - 1] ?? null;
}

export async function generateImage(prompt: string): Promise<{ image_url: string; model: string }> {
  const cli = findCli();
  let stdout: string;
  try {
    const result = await execFileAsync(
      cli,
      ["generate", "create", MODEL, "--prompt", prompt, "--wait", "--json", "--no-color"],
      { timeout: GENERATE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    stdout = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not authenticated/i.test(message) || /auth login/i.test(message)) {
      throw new Error(
        "Higgsfield CLI is not authenticated: run `higgsfield auth login` on this machine, then retry.",
      );
    }
    if (/ENOENT/.test(message)) {
      throw new Error(
        "Higgsfield CLI not found: install it (npm i -g higgsfield) or set HIGGSFIELD_BIN.",
      );
    }
    throw new Error(`Higgsfield generation failed: ${message.slice(0, 300)}`);
  }

  if (/not authenticated/i.test(stdout)) {
    throw new Error(
      "Higgsfield CLI is not authenticated: run `higgsfield auth login` on this machine, then retry.",
    );
  }
  const url = extractUrl(stdout);
  if (!url) {
    throw new Error(`Higgsfield returned no result URL. Output head: ${stdout.slice(0, 200)}`);
  }
  return { image_url: url, model: MODEL };
}

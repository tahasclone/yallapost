import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Flat-file persistence under the repo-root data/ directory (gitignored).
 * Topics and packages need to survive between tool calls so later pipeline
 * stages and the UI can read them; a database replaces this when accounts
 * exist.
 */

export const REPO_ROOT = path.resolve(process.cwd(), "..");
const DATA_DIR = path.join(REPO_ROOT, "data");

export function writeJson(name: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2));
}

export function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, name), "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve a caller-supplied relative path inside an allowed repo-root
 * directory, refusing traversal outside it. Tool inputs are model-written,
 * so "uploads/../../etc" must die here.
 */
export function resolveUnder(dir: "uploads" | "renders", rel: string): string {
  const base = path.join(REPO_ROOT, dir);
  const resolved = path.resolve(REPO_ROOT, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path must be inside ${dir}/: got ${rel}`);
  }
  return resolved;
}

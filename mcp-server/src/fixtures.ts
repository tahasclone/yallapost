
/**
 * Hardcoded data backing the stubbed tools.
 *
 * This file exists so the fixtures are easy to find and delete. When a tool
 * gets a real implementation, its fixture goes with it. If this file is empty,
 * the stubs are gone.
 */

/** Deterministic ids so repeated stub calls are traceable in the event stream. */
export function stubId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}

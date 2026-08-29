import type { z } from "zod";
import type { TranscribeOutputSchema } from "./schemas.js";

/**
 * Hardcoded data backing the stubbed tools.
 *
 * This file exists so the fixtures are easy to find and delete. When a tool
 * gets a real implementation, its fixture goes with it. If this file is empty,
 * the stubs are gone.
 */

export const TRANSCRIPT: z.infer<typeof TranscribeOutputSchema> = {
  segments: [
    { start: 0.0, end: 3.4, text: "Everyone is talking about agent harnesses this week." },
    { start: 3.4, end: 9.1, text: "So I spent two days building on one, and the surprising part was not the model." },
    { start: 9.1, end: 15.8, text: "It was that the harness decides when to stop and ask me before it does something I cannot undo." },
    { start: 15.8, end: 21.2, text: "Here is what that looks like when you actually ship with it." },
  ],
};

/** Deterministic ids so repeated stub calls are traceable in the event stream. */
export function stubId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}

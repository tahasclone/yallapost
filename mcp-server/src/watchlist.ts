import type { z } from "zod";
import type { GetWatchlistOutputSchema } from "./schemas.js";

/**
 * The creator's watchlist. Real configuration, not a fixture: this is the
 * source of truth the SCOUT flow fans out over, versioned in the repo until a
 * per-user database replaces it.
 *
 * The niche is early-stage startups and venture (YC, pre-seed/seed, a16z), so
 * the handles, searches, and the first four feeds are picked for that beat and
 * the rest cover general tech for cross-checking velocity.
 */
export const WATCHLIST: z.infer<typeof GetWatchlistOutputSchema> = {
  handles: [
    { platform: "instagram", handle: "brycent" },
    { platform: "instagram", handle: "100xengineers" },
    { platform: "x", handle: "gregisenberg" },
    { platform: "x", handle: "AIFrontliner" },
  ],
  searches: [
    "Y Combinator batch",
    "pre-seed round",
    "a16z investment",
  ],
  feeds: [
    "https://news.ycombinator.com/rss",
    "https://techcrunch.com/category/startups/feed/",
    "https://a16z.com/feed/",
    "https://www.ycombinator.com/blog/rss",
    "https://techcrunch.com/feed/",
    "https://www.theverge.com/rss/index.xml",
    "https://arstechnica.com/feed/",
    "https://www.wired.com/feed/rss",
  ],
};

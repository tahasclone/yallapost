import { XMLParser } from "fast-xml-parser";

/**
 * Fetch and parse one RSS 2.0 or Atom feed.
 *
 * This runs in the MCP server process, which has normal outbound internet.
 * The sandbox deliberately does not: it only analyses data the tools fetched.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 30;
const MAX_SUMMARY_CHARS = 300;

export interface FeedItem {
  title: string;
  link: string;
  published_at: string;
  summary: string;
  source: string;
}

export interface FetchedFeed {
  source: string;
  url: string;
  fetched_at: string;
  items: FeedItem[];
}

/** Some fields parse as `{ "#text": ... }` when the element has attributes. */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function toIso(raw: string): string {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Atom links come as one object or an array; prefer rel="alternate". */
function atomLink(value: unknown): string {
  const links = asArray(value) as Array<Record<string, unknown>>;
  const alternate = links.find((l) => l["@_rel"] === "alternate" || l["@_rel"] === undefined);
  return text(alternate?.["@_href"] ?? links[0]?.["@_href"] ?? "");
}

export async function fetchFeed(url: string): Promise<FetchedFeed> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "daily-content-agent/0.1 (+https://github.com/tahasclone/yallapost)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
  });
  if (!response.ok) {
    throw new Error(`Feed request failed: HTTP ${response.status} for ${url}`);
  }

  const xml = await response.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error(`Feed at ${url} is not parseable XML`);
  }

  const fetchedAt = new Date().toISOString();

  // RSS 2.0: rss.channel.{title,item[]}
  const channel = ((doc.rss as Record<string, unknown>)?.channel ??
    null) as Record<string, unknown> | null;
  if (channel) {
    const source = text(channel.title) || url;
    const items = asArray(channel.item).map((raw): FeedItem => {
      const item = raw as Record<string, unknown>;
      return {
        title: stripHtml(text(item.title)),
        link: text(item.link) || text((item.guid as Record<string, unknown>) ?? ""),
        published_at: toIso(text(item.pubDate)) || fetchedAt,
        summary: stripHtml(text(item.description)).slice(0, MAX_SUMMARY_CHARS),
        source,
      };
    });
    return { source, url, fetched_at: fetchedAt, items: items.slice(0, MAX_ITEMS) };
  }

  // Atom: feed.{title,entry[]}
  const atom = (doc.feed ?? null) as Record<string, unknown> | null;
  if (atom) {
    const source = text(atom.title) || url;
    const items = asArray(atom.entry).map((raw): FeedItem => {
      const entry = raw as Record<string, unknown>;
      return {
        title: stripHtml(text(entry.title)),
        link: atomLink(entry.link),
        published_at:
          toIso(text(entry.published)) || toIso(text(entry.updated)) || fetchedAt,
        summary: stripHtml(text(entry.summary) || text(entry.content)).slice(
          0,
          MAX_SUMMARY_CHARS,
        ),
        source,
      };
    });
    return { source, url, fetched_at: fetchedAt, items: items.slice(0, MAX_ITEMS) };
  }

  throw new Error(`Feed at ${url} is neither RSS 2.0 nor Atom`);
}

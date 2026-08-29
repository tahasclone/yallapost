import { XMLParser, XMLValidator } from "fast-xml-parser";
import { WATCHLIST } from "./watchlist.js";

/**
 * Fetch and parse one RSS 2.0 or Atom feed.
 *
 * This runs in the MCP server process, which has normal outbound internet.
 * The sandbox deliberately does not: it only analyses data the tools fetched.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 30;
const MAX_SUMMARY_CHARS = 300;
// A feed larger than this is either broken or hostile; stop reading there
// rather than buffering it all before the parser sees a byte.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

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

/**
 * Model-supplied URLs never reach fetch() directly: that would make this tool
 * an SSRF primitive able to probe loopback, private ranges, and cloud
 * metadata endpoints from the server's network. The tool exists to fetch the
 * creator's configured feeds, so the watchlist is the allowlist.
 */
function assertAllowedFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Only http(s) feeds are supported, got ${url.protocol}`);
  }
  const allowed = WATCHLIST.feeds.some((f) => new URL(f).href === url.href);
  if (!allowed) {
    throw new Error(
      `Feed URL is not on the watchlist: ${raw}. fetch_feed only fetches the feeds get_watchlist returns.`,
    );
  }
  return url;
}

/** Read the body with a hard byte cap instead of buffering unboundedly. */
async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      void reader.cancel();
      throw new Error(
        `Feed body exceeded ${MAX_BODY_BYTES} bytes; refusing to parse it`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
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

/** Atom hrefs may be relative; resolve against the feed URL so evidence URLs stay absolute. */
function absolutize(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/** Atom links come as one object or an array; prefer rel="alternate". */
function atomLink(value: unknown, baseUrl: string): string {
  const links = asArray(value) as Array<Record<string, unknown>>;
  const alternate = links.find((l) => l["@_rel"] === "alternate" || l["@_rel"] === undefined);
  return absolutize(text(alternate?.["@_href"] ?? links[0]?.["@_href"] ?? ""), baseUrl);
}

export async function fetchFeed(rawUrl: string): Promise<FetchedFeed> {
  const url = assertAllowedFeedUrl(rawUrl);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // The watchlist check covers the initial URL; a redirect could still walk
    // off it, so follow none. None of the configured feeds redirect.
    redirect: "error",
    headers: {
      "User-Agent": "daily-content-agent/0.1 (+https://github.com/tahasclone/yallapost)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
  });
  if (!response.ok) {
    throw new Error(`Feed request failed: HTTP ${response.status} for ${url.href}`);
  }

  const xml = await readBodyCapped(response);

  // parse() alone does not reject malformed XML when validation is off, so a
  // broken document could come back looking like a successful fetch.
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new Error(
      `Feed at ${url.href} is not parseable XML: ${valid.err.msg} (line ${valid.err.line})`,
    );
  }

  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const fetchedAt = new Date().toISOString();

  // RSS 2.0: rss.channel.{title,item[]}
  const channel = ((doc.rss as Record<string, unknown>)?.channel ??
    null) as Record<string, unknown> | null;
  if (channel) {
    const source = text(channel.title) || url.href;
    const items = asArray(channel.item).map((raw): FeedItem => {
      const item = raw as Record<string, unknown>;
      return {
        title: stripHtml(text(item.title)),
        link: absolutize(
          text(item.link) || text((item.guid as Record<string, unknown>) ?? ""),
          url.href,
        ),
        published_at: toIso(text(item.pubDate)) || fetchedAt,
        summary: stripHtml(text(item.description)).slice(0, MAX_SUMMARY_CHARS),
        source,
      };
    });
    return { source, url: url.href, fetched_at: fetchedAt, items: items.slice(0, MAX_ITEMS) };
  }

  // Atom: feed.{title,entry[]}
  const atom = (doc.feed ?? null) as Record<string, unknown> | null;
  if (atom) {
    const source = text(atom.title) || url.href;
    const items = asArray(atom.entry).map((raw): FeedItem => {
      const entry = raw as Record<string, unknown>;
      return {
        title: stripHtml(text(entry.title)),
        link: atomLink(entry.link, url.href),
        published_at:
          toIso(text(entry.published)) || toIso(text(entry.updated)) || fetchedAt,
        summary: stripHtml(text(entry.summary) || text(entry.content)).slice(
          0,
          MAX_SUMMARY_CHARS,
        ),
        source,
      };
    });
    return { source, url: url.href, fetched_at: fetchedAt, items: items.slice(0, MAX_ITEMS) };
  }

  throw new Error(`Feed at ${url.href} is neither RSS 2.0 nor Atom`);
}

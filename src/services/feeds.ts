// Direct outlet feeds: one request each for 10 to 90 headlines, polled every minute. Reuters, Barron's and AP publish
// no open feed; Fortune only its home feed. The press-release wires carry company announcements before any outlet
// writes them up (GlobeNewswire turns away our server).
export const FEEDS: { name: string; url: string }[] = [
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { name: "CNBC", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html" },
  { name: "CNBC", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html" },
  { name: "WSJ", url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain" },
  { name: "WSJ", url: "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness" },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  { name: "Bloomberg", url: "https://feeds.bloomberg.com/markets/news.rss" },
  { name: "Bloomberg", url: "https://feeds.bloomberg.com/technology/news.rss" },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { name: "Fortune", url: "https://fortune.com/feed/" },
  { name: "Financial Times", url: "https://www.ft.com/rss/home" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "Motley Fool", url: "https://www.fool.com/feeds/index.aspx" },
  { name: "Business Insider", url: "https://feeds.businessinsider.com/custom/all" },
  { name: "NYT", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml" },
  { name: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "The Guardian", url: "https://www.theguardian.com/uk/business/rss" },
  { name: "Investing.com", url: "https://www.investing.com/rss/news_25.rss" },
  { name: "Seeking Alpha", url: "https://seekingalpha.com/market_currents.xml" },
  { name: "Benzinga", url: "https://www.benzinga.com/feed" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "PR Newswire", url: "https://www.prnewswire.com/rss/news-releases-list.rss" },
  {
    name: "PR Newswire",
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss",
  },
  { name: "Business Wire", url: "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFtRWA==" },
];

export type FeedItem = {
  title: string;
  summary: string | null;
  source: string | null;
  url: string;
  image: string | null;
  publishedAt: number;
};

export const UA = "Mozilla/5.0 (compatible; Stonks247/1.0)";
export const xmlTag = (s: string, t: string) =>
  (s.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`))?.[1] ?? "").trim();
const attr = (s: string, tag: string, a: string) =>
  s.match(new RegExp(`<${tag}[^>]*\\b${a}=["']([^"']+)["']`))?.[1] ?? null;
export const text = (s: string) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();

// Polled every minute, so each feed is only downloaded when it changed, and an outlet that pushes back (403/429) is
// left alone for 10 minutes. Lives as long as the news loop does.
const polled = new Map<string, { etag: string | null; modified: string | null; quietUntil: number }>();

// RSS `<item>` and Atom `<entry>` both land here; whichever fields an outlet fills are used.
export async function outletFeed(f: { name: string; url: string }): Promise<FeedItem[]> {
  const p = polled.get(f.url);
  if (p && p.quietUntil > Date.now()) return [];
  const r = await fetch(f.url, {
    headers: {
      "user-agent": UA,
      accept: "application/rss+xml, application/xml, text/xml",
      ...(p?.etag ? { "if-none-match": p.etag } : {}),
      ...(p?.modified ? { "if-modified-since": p.modified } : {}),
    },
  });
  if (r.status === 403 || r.status === 429) {
    polled.set(f.url, { etag: null, modified: null, quietUntil: Date.now() + 600_000 });
    return [];
  }
  if (!r.ok) return []; // 304: nothing new since the last pass
  polled.set(f.url, { etag: r.headers.get("etag"), modified: r.headers.get("last-modified"), quietUntil: 0 });
  const xml = await r.text();
  const entries = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);
  return entries
    .map((it) => {
      const link =
        xmlTag(it, "link") ||
        attr(it, "link[^>]*rel=[\"']alternate[\"']", "href") ||
        attr(it, "link", "href") ||
        "";
      const when =
        xmlTag(it, "pubDate") || xmlTag(it, "published") || xmlTag(it, "updated") || xmlTag(it, "dc:date");
      const body = xmlTag(it, "description") || xmlTag(it, "summary") || xmlTag(it, "content");
      const image =
        attr(it, "media:content", "url") ??
        attr(it, "media:thumbnail", "url") ??
        (attr(it, "enclosure", "type")?.startsWith("image/") ? attr(it, "enclosure", "url") : null) ??
        body.match(/<img[^>]+src=["']([^"']+)["']/)?.[1] ??
        null;
      return {
        title: text(xmlTag(it, "title")),
        summary: body ? text(body).slice(0, 300) || null : null,
        source: f.name,
        url: link
          .trim()
          .replace(/[?&](utm_[a-z]+|guccounter|cmpid|siteid)=[^&]*/g, "")
          .replace(/[?&]$/, ""),
        image,
        publishedAt: Math.floor(new Date(when).getTime() / 1000),
      };
    })
    .filter((n) => n.title && /^https?:\/\//.test(n.url) && Number.isFinite(n.publishedAt));
}

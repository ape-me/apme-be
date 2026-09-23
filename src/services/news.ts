import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { newsRepo, type NewsRow } from "../repos/news";
import { sign } from "../lib/hmac";
import { tickerOf } from "./insights";
import type { IngestNews } from "../contract";
import type { z } from "zod";
import { sha256hex } from "../lib/solana";

const UA = "Mozilla/5.0 (compatible; ApeMe/1.0)";
const JUNK =
  /top .*pick|\$\d[\d,]* (investment|in )|stocks? to buy|here'?s (why|my|how)|should you|millionaire|prediction|best .*stocks?|\bvs\.?\b|forget |could (double|triple)|price target/i;
const TIER1 = [
  "reuters",
  "bloomberg",
  "cnbc",
  "wall street",
  "wsj",
  "financial times",
  "barron",
  "associated press",
  "axios",
  "marketwatch",
  "the information",
  "techcrunch",
  "fortune",
  "the verge",
];
const IMPACT = ["none", "minor", "material", "major", "critical"] as const;
export const IMPACT_LEVEL: Record<string, number> = { none: 0, minor: 1, material: 2, major: 3, critical: 4 };
const ymd = (x: Date) => x.toISOString().slice(0, 10);
const xmlTag = (s: string, t: string) =>
  (s.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`))?.[1] ?? "").trim();

// Match the company name case-insensitively, the ticker only in caps: lowercase "ups" is a word, "UPS" is a company.
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (s: { name: string; symbol: string; issuer: string }, title: string) => {
  const first = s.name.split(/[\s,.]+/)[0]!;
  const names = [s.name, first].filter((x) => x.length > 3);
  if (names.length && new RegExp(`\\b(${names.map(esc).join("|")})\\b`, "i").test(title)) return true;
  const t = tickerOf(s);
  return !!t && t.length > 1 && new RegExp(`\\b${esc(t)}\\b`).test(title);
};

type Raw = {
  title: string;
  summary: string | null;
  source: string | null;
  url: string;
  image: string | null;
  publishedAt: number;
};

async function finnhub(env: Env, ticker: string): Promise<Raw[]> {
  const to = new Date(),
    from = new Date(Date.now() - 2 * 86400_000);
  const r = await fetch(
    `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${ymd(from)}&to=${ymd(to)}&token=${env.FINNHUB_KEY}`,
  );
  if (!r.ok) return [];
  const j = (await r.json()) as {
    headline: string;
    summary: string;
    source: string;
    url: string;
    image: string;
    datetime: number;
  }[];
  return j.map((n) => ({
    title: n.headline,
    summary: n.summary || null,
    source: n.source,
    url: n.url,
    image: n.image || null,
    publishedAt: n.datetime,
  }));
}

async function google(name: string): Promise<Raw[]> {
  const r = await fetch(
    `https://news.google.com/rss/search?q=${encodeURIComponent(`"${name}" when:2d`)}&hl=en-US&gl=US&ceid=US:en`,
    { headers: { "user-agent": UA } },
  );
  if (!r.ok) return [];
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
  return items
    .map((it) => ({
      title: xmlTag(it, "title").replace(/ - [^-]+$/, ""),
      summary: null,
      source: xmlTag(it, "source") || null,
      url: xmlTag(it, "link"),
      image: null,
      publishedAt: Math.floor(new Date(xmlTag(it, "pubDate")).getTime() / 1000),
    }))
    .filter((n) => n.url && Number.isFinite(n.publishedAt));
}

// Follow Finnhub / Google redirects so we store the outlet's own URL. HEAD is not redirected by Finnhub, so GET
// with redirect:"manual" and the body dropped. Null means we could not attribute the article, so we skip it.
const AGGREGATORS = /(^|\.)(finnhub\.io)$/;
async function resolve(url: string): Promise<string | null> {
  let cur = url;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(cur, { method: "GET", redirect: "manual", headers: { "user-agent": UA } }).catch(
      () => null,
    );
    if (!r) break;
    r.body?.cancel().catch(() => {});
    const loc = r.status >= 300 && r.status <= 399 ? r.headers.get("location") : null;
    if (!loc) break;
    cur = new URL(loc, cur).toString();
  }
  const clean = cur.replace(/[?&](\.tsrc|utm_[a-z]+|guccounter)=[^&]*/g, "").replace(/[?&]$/, "");
  const host = new URL(clean).hostname;
  if (AGGREGATORS.test(host)) return null;
  // Google News wraps the publisher behind a consent redirect that only a real browser can follow, so the
  // article opens through Google. ucbcb=1 skips the consent interstitial.
  return /(^|\.)news\.google\.com$/.test(host) ? `${clean}${clean.includes("?") ? "&" : "?"}ucbcb=1` : clean;
}

const PLACEHOLDER = /yahoo_finance|s\.yimg\.com\/rz\/stage|default|placeholder|logo\.png|sprite|blank\./i;
const articleImage = (u: string | null) => (u && !PLACEHOLDER.test(u) ? u : null);

// Feeds hand us the publisher's logo or nothing, so the real picture comes from the article's own og:image.
// No accept header: asking for text/html gets Yahoo's trimmed page, which has no og tags at all.
// Only the head is read, capped at 250KB: Yahoo buries og:image 100KB deep behind inline script.
const OG =
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/i;
const OG_REV =
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["']/i;
export async function ogImage(url: string): Promise<string | null> {
  if (/(^|\.)news\.google\.com$/.test(new URL(url).hostname)) return null;
  const r = await fetch(url, { headers: { "user-agent": UA } }).catch(() => null);
  if (!r?.ok || !r.body) return null;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let html = "";
  try {
    while (html.length < 250_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const hit = OG.exec(html)?.[1] ?? OG_REV.exec(html)?.[1];
  if (!hit) return null;
  try {
    return articleImage(new URL(hit, url).toString());
  } catch {
    return null;
  }
}

const SOURCE_ALIASES: Record<string, string> = {
  seekingalpha: "Seeking Alpha",
  yahoofinance: "Yahoo Finance",
  finance: "Yahoo Finance",
  investorsbusinessdaily: "Investor's Business Daily",
  thestreet: "TheStreet",
  businessinsider: "Business Insider",
  marketwatch: "MarketWatch",
  cnbc: "CNBC",
  wsj: "WSJ",
  "247wallst": "24/7 Wall St",
};
// "Law360" and "law360.com" are one publisher; strip the domain suffix and settle on one spelling.
export const cleanSource = (s: string) => {
  const bare = s
    .trim()
    .replace(/^www\./i, "")
    .replace(/\.(com|net|org|co|io|news|xyz|us|uk)$/i, "");
  const key = bare.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SOURCE_ALIASES[key] ?? bare.replace(/^\w/, (c) => c.toUpperCase());
};

export const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Outlets rewrite the same headline ("seeks CFTC OK" vs "seeks CFTC approval"), so an exact key is not enough.
// Containment rather than Jaccard, because a longer headline should still match the shorter one it restates.
export const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
export const sameStory = (a: Set<string>, b: Set<string>) => {
  if (a.size < 5 || b.size < 5) return false;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit >= 4 && hit / Math.min(a.size, b.size) >= 0.6;
};

const outlet = (url: string, source: string | null) => {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (/finance\.yahoo/.test(host)) return "Yahoo Finance";
  return source && !/^yahoo$/i.test(source)
    ? cleanSource(source)
    : host
        .split(".")
        .slice(-2, -1)[0]!
        .replace(/^\w/, (c) => c.toUpperCase());
};

// Four typed questions per article, no text generation.
const jevInput = (a: { title: string; summary: string | null; name: string; symbol: string }) => ({
  state: `Stock: ${a.name} (${a.symbol}). Headline: ${a.title}. Summary: ${a.summary ?? ""}`,
  questions: {
    about: {
      type: "noul",
      instructions: "Is this article primarily about the named company rather than mentioning it in passing?",
    },
    impact: {
      type: "score",
      instructions: "How much could this news move the stock price over the next few days?",
      criteria: [
        "No effect: filler, listicle, opinion",
        "Minor: routine coverage",
        "Material: guidance, deal, regulation, lawsuit",
        "Major: earnings surprise, M&A, big policy change",
        "Critical: fraud, bankruptcy, delisting",
      ],
    },
    direction: {
      type: "choice",
      instructions: "Likely direction of the price effect",
      criteria: {
        bullish: "Positive for the stock",
        bearish: "Negative for the stock",
        neutral: "Unclear or mixed",
      },
    },
    junk: {
      type: "noul",
      instructions:
        "Is this a listicle, prediction piece or SEO filler rather than a report of a specific event?",
    },
  },
});

// Workers AI binding inside the Worker, the same model over REST from the box. Null means "not scored", never a guess.
type JevAnswers = Record<string, { noul?: number; score?: number; choice?: string; confidence?: number }>;
type JevOut = { answers?: JevAnswers; result?: { answers?: JevAnswers } };
async function score(env: Env, a: { title: string; summary: string | null; name: string; symbol: string }) {
  let out: JevOut | null = null;
  if (env.AI) {
    out = (await env.AI.run("typesafe/jev", jevInput(a), { gateway: { id: "default" } })) as JevOut;
  } else if (env.AI_GATEWAY_URL && env.AI_GATEWAY_TOKEN && env.CF_API_TOKEN) {
    const r = await fetch(env.AI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
        "cf-aig-gateway-id": "default",
      },
      body: JSON.stringify({ model: "typesafe/jev", input: jevInput(a) }),
    });
    if (!r.ok) {
      console.warn("jev", r.status, (await r.text()).slice(0, 200));
      return null;
    }
    out = ((await r.json()) as { result?: JevOut }).result ?? null;
  }
  if (!out) return null;
  const an = out.result?.answers ?? out.answers;
  if (!an) return null;
  const dir = an.direction;
  return {
    about: an.about?.noul ?? 1,
    impact: an.impact?.score == null ? null : Math.round(an.impact.score),
    // A calibrated model says "unsure" often; below half confidence we show no direction at all.
    direction: (dir?.confidence ?? 0) >= 0.5 ? (dir?.choice ?? null) : null,
    confidence: dir?.confidence ?? null,
    junk: (an.junk?.noul ?? 0) > 0.7,
  };
}

// The box has no Durable Object binding, so new items reach the WebSocket rooms through the signed ingest route.
async function pushNews(env: Env, items: z.infer<typeof IngestNews>[]) {
  if (!env.INGEST_URL || !env.INGEST_SECRET) return;
  const body = JSON.stringify({
    trades: [],
    tokens: [],
    prices: [],
    news: items,
    sentAt: Math.floor(Date.now() / 1000),
  });
  await fetch(`${env.INGEST_URL}/trades`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": await sign(env.INGEST_SECRET, body) },
    body,
  }).catch(() => {});
}

// Diagnostics for the admin route: one Jev call, raw status and body.
export async function jevProbe(env: Env) {
  if (!env.AI) return { error: "no AI binding" };
  try {
    const r = await env.AI.run(
      "typesafe/jev",
      {
        state: "Nvidia beat earnings.",
        questions: { up: { type: "noul", instructions: "Is this good for the stock?" } },
      },
      { gateway: { id: "default" } },
    );
    return { ok: true, r };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }
}

// Jev pass: score whatever the ingest left unscored. Stops on the first failure so a broken gateway costs one call.
export async function scoreNews(env: Env, sql: Sql, limit = 120) {
  let scored = 0,
    dropped = 0;
  for (const a of await newsRepo.unscored(sql, limit)) {
    const sc = await score(env, a).catch((e) => {
      console.warn("jev", (e as Error).message);
      return null;
    });
    if (!sc) break;
    const junk = sc.junk || sc.about < 0.8 || sc.impact === 0;
    if (junk) dropped++;
    scored++;
    await newsRepo.score(sql, a.id, {
      impact: sc.impact,
      direction: sc.direction,
      confidence: sc.confidence,
      junk,
    });
  }
  return { scored, dropped };
}

// Cron body: half the universe per run (each stock every 10 min), cheap filter, store, tag, notify rooms.
export async function ingestNews(env: Env, sql: Sql, minute: number) {
  // A Worker gets 1000 subrequests per invocation and each article costs one redirect fetch, so the universe is
  // walked in quarters (every stock every 20 min) with a cap per stock.
  const stocks = await newsRepo.stocksForNews(sql);
  const slice = stocks.filter((_, i) => i % 4 === Math.floor(minute / 5) % 4);
  const t = Math.floor(Date.now() / 1000);
  const fresh: z.infer<typeof IngestNews>[] = [];
  let added = 0;
  for (const s of slice) {
    const ticker = tickerOf(s);
    let raws = ticker && env.FINNHUB_KEY ? await finnhub(env, ticker) : [];
    if (!raws.length) raws = await google(s.name);
    const seen = new Set<string>();
    const recent = await newsRepo.recentTitles(sql, s.mint, t - 2 * 86400);
    let fetched = 0;
    for (const n of raws.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 12)) {
      const title = n.title.trim();
      if (!title || seen.has(title) || !mentions(s, title) || JUNK.test(title)) continue;
      seen.add(title);
      if (++fetched > 6) break;
      const url = await resolve(n.url);
      if (!url) continue;
      // A second outlet running the same headline is the same story: tag the stock onto the row we have.
      const key = titleKey(title);
      const [exact] = await newsRepo.byTitleKey(sql, key, t - 7 * 86400);
      const w = words(title);
      const near = exact ?? recent.find((r) => sameStory(w, words(r.title)));
      if (near) {
        await newsRepo.tag(sql, near.id, s.mint, 1);
        continue;
      }
      const id = (await sha256hex(new TextEncoder().encode(url))).slice(0, 32);
      const [row] = await newsRepo.upsert(sql, {
        id,
        title,
        summary: n.summary,
        source: outlet(url, n.source),
        url,
        image: articleImage(n.image) ?? (await ogImage(url)),
        titleKey: key,
        publishedAt: n.publishedAt,
        t,
      });
      if (!row) continue;
      await newsRepo.tag(sql, row.id, s.mint, 1);
      if (row.inserted) {
        added++;
        fresh.push({
          mint: s.mint,
          symbol: s.symbol,
          title,
          source: outlet(url, n.source),
          url,
          publishedAt: n.publishedAt,
        });
      }
    }
  }
  const { scored } = await scoreNews(env, sql, 40);
  if (minute % 60 === 0) await newsRepo.prune(sql, t - 7 * 86400);
  if (fresh.length) await pushNews(env, fresh);
  return { stocks: slice.length, added, scored };
}

export const shapeNews = (r: NewsRow) => ({
  id: r.id,
  mint: r.mint,
  symbol: r.symbol,
  name: r.name,
  image: r.logo,
  priceUsd: r.price_usd == null ? null : Number(r.price_usd),
  change24h: r.change_24h == null ? null : Number(r.change_24h),
  title: r.title,
  summary: r.summary,
  source: r.source,
  url: r.url,
  articleImage: r.image,
  publishedAt: Number(r.published_at),
  impact: r.impact == null ? null : (IMPACT[r.impact] ?? null),
  direction: r.direction,
  confidence: r.confidence,
  tier1: !!r.source && TIER1.some((x) => r.source!.toLowerCase().includes(x)),
});

export const news = {
  byMint: async (sql: Sql, mint: string, limit: number, before: number | null) =>
    (await newsRepo.byMint(sql, mint, limit, before)).map(shapeNews),
  feed: async (
    sql: Sql,
    a: { mints: string[]; limit: number; before: number | null; minImpact: number; perStock: number },
  ) => (await newsRepo.feed(sql, a)).map(shapeNews),
};

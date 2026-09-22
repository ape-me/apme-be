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

const PLACEHOLDER = /yahoo_finance|s\.yimg\.com\/rz\/stage|default|placeholder|logo\.png/i;
const articleImage = (u: string | null) => (u && !PLACEHOLDER.test(u) ? u : null);

const outlet = (url: string, source: string | null) => {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (/finance\.yahoo/.test(host)) return "Yahoo Finance";
  return source && !/^yahoo$/i.test(source)
    ? source
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
    let fetched = 0;
    for (const n of raws.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 12)) {
      const title = n.title.trim();
      if (!title || seen.has(title) || !mentions(s, title) || JUNK.test(title)) continue;
      seen.add(title);
      if (++fetched > 6) break;
      const url = await resolve(n.url);
      if (!url) continue;
      const id = (await sha256hex(new TextEncoder().encode(url))).slice(0, 32);
      const [row] = await newsRepo.upsert(sql, {
        id,
        title,
        summary: n.summary,
        source: outlet(url, n.source),
        url,
        image: articleImage(n.image),
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
  ticker: async (sql: Sql, limit: number) => (await newsRepo.ticker(sql, limit)).map(shapeNews),
};

import type { Sql } from "../lib/db";

export type NewsRow = {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  logo: string | null;
  price_usd: number | null;
  change_24h: number | null;
  title: string;
  summary: string | null;
  source: string | null;
  url: string;
  image: string | null;
  published_at: string;
  impact: number | null;
  direction: string | null;
  confidence: number | null;
};

const SELECT = (sql: Sql) => sql`
  SELECT n.id, ns.mint, s.symbol, s.name, s.logo, s.price_usd, s.change_24h, n.title, n.summary, n.source, n.url, n.image,
         n.published_at, n.impact, n.direction, n.confidence
  FROM news n JOIN news_stocks ns ON ns.news_id = n.id JOIN stocks s ON s.mint = ns.mint
  WHERE NOT n.junk AND NOT s.excluded`;

export const newsRepo = {
  upsert: (
    sql: Sql,
    n: {
      id: string;
      title: string;
      summary: string | null;
      source: string | null;
      url: string;
      image: string | null;
      publishedAt: number;
      t: number;
    },
  ) =>
    sql<
      { id: string; inserted: boolean }[]
    >`INSERT INTO news (id, title, summary, source, url, image, published_at, fetched_at)
      VALUES (${n.id}, ${n.title}, ${n.summary}, ${n.source}, ${n.url}, ${n.image}, ${n.publishedAt}, ${n.t})
      ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title RETURNING id, (xmax = 0) AS inserted`,
  tag: (sql: Sql, newsId: string, mint: string, relevance: number) =>
    sql`INSERT INTO news_stocks (news_id, mint, relevance) VALUES (${newsId}, ${mint}, ${relevance}) ON CONFLICT DO NOTHING`,
  score: (
    sql: Sql,
    id: string,
    s: { impact: number | null; direction: string | null; confidence: number | null; junk: boolean },
  ) =>
    sql`UPDATE news SET impact = ${s.impact}, direction = ${s.direction}, confidence = ${s.confidence}, junk = ${s.junk} WHERE id = ${id}`,
  unscored: (sql: Sql, limit: number) =>
    sql<{ id: string; title: string; summary: string | null; name: string; symbol: string; mint: string }[]>`
      SELECT n.id, n.title, n.summary, s.name, s.symbol, ns.mint FROM news n JOIN news_stocks ns ON ns.news_id = n.id JOIN stocks s ON s.mint = ns.mint
      WHERE n.impact IS NULL AND NOT n.junk ORDER BY n.published_at DESC LIMIT ${limit}`,
  byMint: (sql: Sql, mint: string, limit: number) =>
    sql<NewsRow[]>`${SELECT(sql)} AND ns.mint = ${mint} ORDER BY n.published_at DESC LIMIT ${limit}`,
  // Feed: the caller's stocks first, then everything else, newest first within each group.
  feed: (sql: Sql, mints: string[], limit: number) =>
    sql<NewsRow[]>`${SELECT(sql)} AND n.published_at > ${Math.floor(Date.now() / 1000) - 7 * 86400}
      ORDER BY ${mints.length ? sql`(ns.mint IN ${sql(mints)}) DESC,` : sql``} n.published_at DESC LIMIT ${limit}`,
  // Ticker: one headline per stock, material or better when scored, biggest movers first.
  ticker: (sql: Sql, limit: number) =>
    sql<
      NewsRow[]
    >`SELECT * FROM (SELECT DISTINCT ON (ns.mint) n.id, ns.mint, s.symbol, s.name, s.logo, s.price_usd, s.change_24h, n.title, n.summary, n.source, n.url, n.image,
         n.published_at, n.impact, n.direction, n.confidence
      FROM news n JOIN news_stocks ns ON ns.news_id = n.id JOIN stocks s ON s.mint = ns.mint
      WHERE NOT n.junk AND NOT s.excluded AND n.published_at > ${Math.floor(Date.now() / 1000) - 86400} AND (n.impact IS NULL OR n.impact >= 2)
      ORDER BY ns.mint, n.impact DESC NULLS LAST, n.published_at DESC) x
      ORDER BY abs(coalesce(x.change_24h, 0)) DESC, x.published_at DESC LIMIT ${limit}`,
  prune: (sql: Sql, before: number) => sql`DELETE FROM news WHERE published_at < ${before}`,
  stocksForNews: (sql: Sql) =>
    sql<
      { mint: string; symbol: string; name: string; issuer: string }[]
    >`SELECT mint, symbol, name, issuer FROM stocks WHERE NOT excluded AND category <> 'crypto' ORDER BY symbol`,
};

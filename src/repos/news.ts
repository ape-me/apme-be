import type { Sql } from "../lib/db";

export type NewsRow = {
  id: string;
  mint: string | null;
  symbol: string | null;
  name: string | null;
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
  scope: string;
};

const SELECT = (sql: Sql) => sql`
  SELECT n.id, ns.mint, s.symbol, s.name, s.logo, s.price_usd, s.change_24h, n.title, n.summary, n.source, n.url, n.image,
         n.published_at, n.impact, n.direction, n.confidence, n.scope
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
      titleKey: string;
      scope: "stock" | "market";
      publishedAt: number;
      t: number;
    },
  ) =>
    sql<
      { id: string; inserted: boolean }[]
    >`INSERT INTO news (id, title, summary, source, url, image, title_key, scope, published_at, fetched_at)
      VALUES (${n.id}, ${n.title}, ${n.summary}, ${n.source}, ${n.url}, ${n.image}, ${n.titleKey}, ${n.scope}, ${n.publishedAt}, ${n.t})
      ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, image = COALESCE(news.image, EXCLUDED.image)
      RETURNING id, (xmax = 0) AS inserted`,
  // The same story from a second outlet is the same story: reuse the row we already have.
  byTitleKey: (sql: Sql, titleKey: string, since: number) =>
    sql<{ id: string }[]>`SELECT id FROM news WHERE title_key = ${titleKey} AND published_at > ${since}
      ORDER BY published_at LIMIT 1`,
  recentTitles: (sql: Sql, mint: string, since: number) =>
    sql<
      { id: string; title: string }[]
    >`SELECT n.id, n.title FROM news n JOIN news_stocks ns ON ns.news_id = n.id
      WHERE ns.mint = ${mint} AND n.published_at > ${since}`,
  recentMarketTitles: (sql: Sql, since: number) =>
    sql<
      { id: string; title: string }[]
    >`SELECT id, title FROM news WHERE scope = 'market' AND published_at > ${since}`,
  setImage: (sql: Sql, id: string, image: string) =>
    sql`UPDATE news SET image = ${image} WHERE id = ${id} AND image IS NULL`,
  // A story about Apple belongs on every Apple token (AAPLx, AAPLon, ...), not only the one it was matched under.
  tag: (sql: Sql, newsId: string, mint: string, relevance: number) =>
    sql`INSERT INTO news_stocks (news_id, mint, relevance)
        SELECT ${newsId}, sib.mint, ${relevance} FROM stocks s
        JOIN stocks sib ON coalesce(sib.underlying, sib.mint) = coalesce(s.underlying, s.mint)
        WHERE s.mint = ${mint} AND NOT sib.excluded
        ON CONFLICT DO NOTHING`,
  score: (
    sql: Sql,
    id: string,
    s: { impact: number | null; direction: string | null; confidence: number | null; junk: boolean },
  ) =>
    sql`UPDATE news SET impact = ${s.impact}, direction = ${s.direction}, confidence = ${s.confidence}, junk = ${s.junk} WHERE id = ${id}`,
  // Market rows have no stock; they are scored against the market itself.
  unscored: (sql: Sql, limit: number) =>
    sql<{ id: string; title: string; summary: string | null; name: string | null; symbol: string | null }[]>`
      SELECT id, title, summary, name, symbol FROM (
        SELECT DISTINCT ON (n.id) n.id, n.title, n.summary, s.name, s.symbol, n.published_at
        FROM news n LEFT JOIN news_stocks ns ON ns.news_id = n.id LEFT JOIN stocks s ON s.mint = ns.mint
        WHERE n.impact IS NULL AND NOT n.junk AND (n.scope = 'market' OR s.mint IS NOT NULL)
        ORDER BY n.id, ns.relevance DESC NULLS LAST, s.symbol) x
      ORDER BY published_at DESC LIMIT ${limit}`,
  market: (sql: Sql, a: { limit: number; before: number | null; minImpact: number; withImage: boolean }) =>
    sql<NewsRow[]>`
      SELECT n.id, NULL AS mint, NULL AS symbol, NULL AS name, NULL AS logo, NULL AS price_usd, NULL AS change_24h,
             n.title, n.summary, n.source, n.url, n.image, n.published_at, n.impact, n.direction, n.confidence, n.scope
      FROM news n
      WHERE n.scope = 'market' AND NOT n.junk AND n.impact IS NOT NULL AND n.impact >= ${a.minImpact}
        AND n.published_at > ${Math.floor(Date.now() / 1000) - 7 * 86400}
        ${a.before ? sql`AND n.published_at < ${a.before}` : sql``}
        ${a.withImage ? sql`AND n.image IS NOT NULL` : sql``}
      ORDER BY n.published_at DESC LIMIT ${a.limit}`,
  byMint: (sql: Sql, mint: string, limit: number, before: number | null, withImage: boolean) =>
    sql<
      NewsRow[]
    >`${SELECT(sql)} AND ns.mint = ${mint} ${before ? sql`AND n.published_at < ${before}` : sql``}
      ${withImage ? sql`AND n.image IS NOT NULL` : sql``}
      ORDER BY n.published_at DESC LIMIT ${limit}`,
  // Feed: at most `perStock` per stonk so one busy company cannot fill a page, the caller's stocks first,
  // newest first inside each group. Unscored articles are held back until the next scoring pass.
  feed: (
    sql: Sql,
    a: {
      mints: string[];
      limit: number;
      before: number | null;
      minImpact: number;
      perStock: number;
      withImage: boolean;
      only?: boolean; // just these mints, not merely these first
    },
  ) =>
    sql<
      NewsRow[]
    >`SELECT id, mint, symbol, name, logo, price_usd, change_24h, title, summary, source, url, image,
                          published_at, impact, direction, confidence FROM (
      SELECT n.id, ns.mint, s.symbol, s.name, s.logo, s.price_usd, s.change_24h, n.title, n.summary, n.source, n.url, n.image,
             n.published_at, n.impact, n.direction, n.confidence,
             row_number() OVER (PARTITION BY ns.mint ORDER BY n.published_at DESC) AS rn,
             -- one article can name two companies; the merged feed shows it once, under the stock that matters most here
             row_number() OVER (PARTITION BY n.id ORDER BY ${a.mints.length ? sql`(ns.mint IN ${sql(a.mints)}) DESC,` : sql``} ns.relevance DESC, s.symbol) AS dup
      FROM news n JOIN news_stocks ns ON ns.news_id = n.id JOIN stocks s ON s.mint = ns.mint
      WHERE NOT n.junk AND NOT s.excluded AND n.impact IS NOT NULL AND n.impact >= ${a.minImpact}
        AND n.published_at > ${Math.floor(Date.now() / 1000) - 7 * 86400}
        ${a.before ? sql`AND n.published_at < ${a.before}` : sql``}
        ${a.withImage ? sql`AND n.image IS NOT NULL` : sql``}
        ${a.only && a.mints.length ? sql`AND ns.mint IN ${sql(a.mints)}` : sql``}) x
      WHERE rn <= ${a.perStock} AND dup = 1
      ORDER BY ${a.mints.length ? sql`(mint IN ${sql(a.mints)}) DESC,` : sql``} published_at DESC LIMIT ${a.limit}`,
  prune: (sql: Sql, before: number) => sql`DELETE FROM news WHERE published_at < ${before}`,
  // One row per company the app shows, its deepest token standing in for the rest. `pooled` is false for names
  // only Ondo carries: they fill over RFQ, have no pool, and get polled less often.
  stocksForNews: (sql: Sql) =>
    sql<
      {
        mint: string;
        symbol: string;
        name: string;
        issuer: string;
        underlying: string | null;
        pooled: boolean;
        category: string;
      }[]
    >`SELECT DISTINCT ON (coalesce(underlying, mint)) mint, symbol, name, issuer, underlying, category,
             coalesce(liquidity_usd, 0) >= 5000 AS pooled
        FROM stocks
        WHERE NOT excluded AND price_usd IS NOT NULL AND category IN ('stock', 'etf', 'preipo')
          AND (coalesce(liquidity_usd, 0) >= 5000 OR issuer = 'ondo')
        ORDER BY coalesce(underlying, mint), coalesce(liquidity_usd, 0) DESC`,
};

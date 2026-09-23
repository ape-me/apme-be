// One-off repair on the prod box: fold duplicate headlines into one row, settle publisher spellings, and
// pull og:image for articles that arrived before ingest started doing it.
import postgres from "postgres";
import { cleanSource, ogImage, words, sameStory } from "../src/services/news";

const sql = postgres(process.env.DATABASE_URL!, { max: 4, prepare: false, idle_timeout: 5 });

const merged = await sql.begin(async (tx) => {
  await tx`CREATE TEMP TABLE dupes ON COMMIT DROP AS
    WITH keep AS (
      SELECT title_key, (array_agg(id ORDER BY (image IS NULL), published_at))[1] AS keep_id
      FROM news GROUP BY title_key HAVING count(*) > 1
    )
    SELECT n.id, k.keep_id FROM news n JOIN keep k ON k.title_key = n.title_key AND n.id <> k.keep_id`;
  await tx`INSERT INTO news_stocks (news_id, mint, relevance)
           SELECT d.keep_id, ns.mint, ns.relevance FROM news_stocks ns JOIN dupes d ON d.id = ns.news_id
           ON CONFLICT DO NOTHING`;
  await tx`DELETE FROM news_stocks WHERE news_id IN (SELECT id FROM dupes)`;
  const gone = await tx`DELETE FROM news WHERE id IN (SELECT id FROM dupes)`;
  return gone.count;
});

// Near-duplicates: same stock, same fortnight, headlines that restate each other.
const cand = await sql<{ id: string; title: string; mint: string; published_at: string }[]>`
  SELECT n.id, n.title, ns.mint, n.published_at FROM news n JOIN news_stocks ns ON ns.news_id = n.id
  WHERE n.published_at > extract(epoch from now()) - 14 * 86400 ORDER BY ns.mint, n.published_at`;
const byMint = new Map<string, { id: string; w: Set<string> }[]>();
const fold: [string, string][] = [];
for (const c of cand) {
  const list = byMint.get(c.mint) ?? [];
  const w = words(c.title);
  const hit = list.find((x) => x.id !== c.id && sameStory(w, x.w));
  if (hit) fold.push([c.id, hit.id]);
  else list.push({ id: c.id, w });
  byMint.set(c.mint, list);
}
let folded = 0;
for (const [from, to] of fold) {
  if (from === to) continue;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO news_stocks (news_id, mint, relevance)
             SELECT ${to}, mint, relevance FROM news_stocks WHERE news_id = ${from} ON CONFLICT DO NOTHING`;
    await tx`DELETE FROM news_stocks WHERE news_id = ${from}`;
    await tx`DELETE FROM news WHERE id = ${from}`;
  });
  folded++;
}

const sources = await sql<{ source: string }[]>`SELECT DISTINCT source FROM news WHERE source IS NOT NULL`;
let renamed = 0;
for (const { source } of sources) {
  const clean = cleanSource(source);
  if (clean === source) continue;
  await sql`UPDATE news SET source = ${clean} WHERE source = ${source}`;
  renamed++;
}

const rows = await sql<{ id: string; url: string }[]>`
  SELECT id, url FROM news WHERE image IS NULL AND url NOT LIKE '%news.google.com%'
  ORDER BY published_at DESC LIMIT ${Number(process.argv[2] ?? 300)}`;
let found = 0;
for (const r of rows) {
  const img = await ogImage(r.url).catch(() => null);
  if (!img) continue;
  await sql`UPDATE news SET image = ${img} WHERE id = ${r.id}`;
  found++;
}

console.log(JSON.stringify({ merged, folded, renamed, looked: rows.length, images: found }));
await sql.end({ timeout: 2 });

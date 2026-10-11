import type { Sql } from "../lib/db";
import { marketRepo } from "../repos/market";
import type { HistoryRange, HistoryResponse } from "../contract";
import { IMPACT, sameStory, sourceTier, words } from "./news";
import type { z } from "zod";

// Chart ranges: how far back, and the bucket size that keeps each under ~750 points.
const RANGE = {
  "5m": { span: 300, step: 5 },
  "15m": { span: 900, step: 15 },
  "1h": { span: 3600, step: 60 },
  "1d": { span: 86400, step: 120 },
  "1w": { span: 604800, step: 900 },
  "1m": { span: 2592000, step: 3600 },
} as const;
// News markers per range: the lowest impact that counts, the impact a story needs to stand without a known outlet
// behind it, and which 6 a range keeps (newest on the short ranges, biggest on the long ones). The news loop runs
// every minute, so a story is on the 1h chart within a minute or two of reaching us.
const MARKERS: Partial<Record<keyof typeof RANGE, { min: number; alone: number; newest: boolean }>> = {
  "1h": { min: 1, alone: 3, newest: true },
  "1d": { min: 1, alone: 3, newest: true },
  "1w": { min: 3, alone: 4, newest: false },
  "1m": { min: 3, alone: 4, newest: false },
};
const MAX_MARKERS = 6;
// Long words too common in market headlines to tie two stories together.
const COMMON = new Set(
  (
    "earnings quarter quarterly revenue billion million investors investor analysts analyst company companies " +
    "financial according announces announced launches launched acquire acquires acquisition results guidance " +
    "outlook trading markets reports reported shareholders dividend partnership partners interview exclusive " +
    "breaking artificial intelligence technology technologies startup startups explores further options " +
    "investment investing rallies plunges surges percent infrastructure buying selling nasdaq record"
  ).split(" "),
);
// The same story under different headlines usually shares one distinctive name ("Reflection" in four takes on
// Nvidia's deal talks): a long word that is not market boilerplate and not the company's own name.
const keyTerms = (title: string, own: Set<string>) =>
  [...words(title)].filter((w) => w.length >= 7 && !own.has(w) && !COMMON.has(w));
// The outlet's icon by the article's domain; a Google News redirect link carries none, so the outlet name stands in
// for it ("Engadget" → engadget.com).
const logoOf = (url: string, source: string | null) => {
  const host = URL.canParse(url) ? new URL(url).hostname : null;
  const domain =
    host && host !== "news.google.com"
      ? host
      : source && `${source.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : null;
};
type Story = Awaited<ReturnType<typeof marketRepo.events>>[number];

export const market = {
  history: async (
    sql: Sql,
    mint: string,
    range: z.infer<typeof HistoryRange>,
  ): Promise<z.infer<typeof HistoryResponse>> => {
    const { span, step } = RANGE[range];
    const to = Math.floor(Date.now() / 1000),
      from = to - span;
    const rows =
      step < 60
        ? await marketRepo.ticks(sql, mint, from, step)
        : await marketRepo.history(sql, mint, from, step);
    const rule = MARKERS[range];
    const found: Story[] = rule ? await marketRepo.events(sql, mint, from, to, rule.min, 60) : [];
    // Best outlet first, so when ten sites run one story, its dot is the best-sourced write-up.
    const ranked = found
      .filter((n) => sourceTier(n.source) < 3 || n.impact >= rule!.alone)
      .sort((a, b) => sourceTier(a.source) - sourceTier(b.source) || b.impact - a.impact);
    const news: Story[] = [];
    const own = words(found[0]?.stock ?? "");
    const same = (a: Story, b: Story) =>
      sameStory(words(a.title), words(b.title)) ||
      (Math.abs(Number(a.published_at) - Number(b.published_at)) < 86400 &&
        keyTerms(a.title, own).some((w) => keyTerms(b.title, own).includes(w)));
    for (const n of ranked) if (!news.some((k) => same(n, k))) news.push(n);
    news.sort((a, b) =>
      rule!.newest
        ? Number(b.published_at) - Number(a.published_at)
        : b.impact - a.impact || Number(b.published_at) - Number(a.published_at),
    );
    const events = news
      .slice(0, MAX_MARKERS)
      .map((n) => {
        const at = Number(n.published_at);
        return {
          t: Math.floor(at / step) * step,
          publishedAt: at,
          id: n.id,
          title: n.title,
          source: n.source,
          url: n.url,
          sourceLogo: logoOf(n.url, n.source),
          impact: IMPACT[n.impact] ?? null,
          direction: n.direction,
          moveAfterPct: at <= to - 3600 && n.p0 && n.p1 ? Math.round((n.p1 / n.p0 - 1) * 10000) / 100 : null,
        };
      })
      .sort((a, b) => a.t - b.t);
    const first = rows[0]?.price,
      last = rows[rows.length - 1]?.price;
    const changeAbs = first != null && last != null ? last - first : null;
    return {
      mint,
      range,
      from,
      to,
      points: rows.map((r) => ({
        t: Number(r.t),
        price: Number(r.price),
        mark: r.mark == null ? null : Number(r.mark),
      })),
      changeAbs,
      changePct: changeAbs != null && first ? (changeAbs / first) * 100 : null,
      events,
    };
  },
};

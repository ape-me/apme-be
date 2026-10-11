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
    for (const n of ranked) if (!news.some((k) => sameStory(words(n.title), words(k.title)))) news.push(n);
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

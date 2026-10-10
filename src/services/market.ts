import type { Sql } from "../lib/db";
import { marketRepo } from "../repos/market";
import type { HistoryRange, HistoryResponse } from "../contract";
import { IMPACT } from "./news";
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
// News markers per range: the day shows material stories, the longer ranges only major ones, never more than 6.
const MARKERS: Partial<Record<keyof typeof RANGE, number>> = { "1d": 2, "1w": 3, "1m": 3 };
const MAX_MARKERS = 6;

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
    const minImpact = MARKERS[range];
    const news = minImpact ? await marketRepo.events(sql, mint, from, to, minImpact, MAX_MARKERS) : [];
    const events = news
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

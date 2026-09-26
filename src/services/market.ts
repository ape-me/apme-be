import type { Sql } from "../lib/db";
import { marketRepo } from "../repos/market";
import type { HistoryRange, HistoryResponse } from "../contract";
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
    };
  },
};

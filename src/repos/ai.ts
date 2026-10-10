import type { Sql } from "../lib/db";

export type AiBasketRow = {
  id: string;
  idea: string;
  name: string;
  tagline: string | null;
  bear_case: string | null;
  picks: string; // json text: BasketPick[]
  created_at: string;
};

const COLS = (sql: Sql) => sql`id, idea, name, tagline, bear_case, picks::text AS picks, created_at`;

export const aiRepo = {
  insert: (sql: Sql, r: Omit<AiBasketRow, "created_at"> & { userId: string; model: string; t: number }) =>
    sql`INSERT INTO ai_baskets (id, user_id, idea, name, tagline, bear_case, picks, model, created_at)
        VALUES (${r.id}, ${r.userId}, ${r.idea}, ${r.name}, ${r.tagline}, ${r.bear_case}, ${r.picks}::text::jsonb, ${r.model}, ${r.t})`,
  // Only its author sees a basket: once invested in, or as a draft until `draftsFrom`.
  byId: (sql: Sql, id: string, userId: string, draftsFrom: number) =>
    sql<AiBasketRow[]>`SELECT ${COLS(sql)} FROM ai_baskets WHERE id = ${id} AND user_id = ${userId}
        AND (saved_at IS NOT NULL OR created_at > ${draftsFrom})`,
  save: (sql: Sql, id: string, t: number) =>
    sql`UPDATE ai_baskets SET saved_at = ${t} WHERE id = ${id} AND saved_at IS NULL`,
  names: (sql: Sql, ids: string[]) =>
    sql<{ id: string; name: string }[]>`SELECT id, name FROM ai_baskets WHERE id IN ${sql(ids)}`,
  mine: (sql: Sql, userId: string, limit: number) =>
    sql<
      AiBasketRow[]
    >`SELECT ${COLS(sql)} FROM ai_baskets WHERE user_id = ${userId} AND saved_at IS NOT NULL ORDER BY saved_at DESC LIMIT ${limit}`,
  countSince: async (sql: Sql, userId: string, t: number) =>
    Number(
      (
        await sql<
          { n: string }[]
        >`SELECT count(*) AS n FROM ai_baskets WHERE user_id = ${userId} AND created_at > ${t}`
      )[0]!.n,
    ),
  // The same idea typed again shortly after: reuse the basket instead of paying for a new one.
  recent: (sql: Sql, userId: string, idea: string, t: number) =>
    sql<
      { id: string }[]
    >`SELECT id FROM ai_baskets WHERE user_id = ${userId} AND lower(idea) = lower(${idea}) AND created_at > ${t}
        ORDER BY created_at DESC LIMIT 1`,
};

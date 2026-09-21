import type { Sql } from "../lib/db";

type TickerRow = {
  id: string;
  kind: "meme" | "stonk";
  label: string;
  logo: string | null;
  change24h: number | null;
  price: number | null;
};

export const tickerRepo = {
  // Top stonks by meme count, top memes by 24h USD volume. Both carry live prices from the indexer.
  rows: (sql: Sql, stonks: number, memes: number) => sql<TickerRow[]>`
    (SELECT s.mint AS id, 'stonk' AS kind, s.symbol AS label, s.logo, s.change_24h AS change24h, s.price_usd AS price,
            (SELECT count(*) FROM tokens t WHERE t.quote_mint = s.mint) AS rank
     FROM stocks s WHERE s.price_usd IS NOT NULL ORDER BY rank DESC LIMIT ${stonks})
    UNION ALL
    (SELECT t.mint AS id, 'meme' AS kind, '$' || coalesce(t.symbol, left(t.mint, 4)) AS label, t.image AS logo, st.change_24h AS change24h, st.price_usd AS price,
            st.vol_24h_usd AS rank
     FROM token_stats st JOIN tokens t ON t.mint = st.token_mint
     WHERE st.price_usd IS NOT NULL AND st.vol_24h_usd > 0 ORDER BY st.vol_24h_usd DESC LIMIT ${memes})`,
};

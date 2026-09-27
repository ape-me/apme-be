import type { StockRow } from "../repos/stocks";

// Order matters: this is the order the home screen shows them.
export const COLLECTIONS: readonly {
  id: string;
  title: string;
  tagline: string;
  issuer?: string;
  category?: string;
  underlyings?: readonly string[]; // real-world tickers, so a pick survives whichever issuer wins the row
}[] = [
  { id: "preipo", title: "Pre-IPO", tagline: "Private companies, before the IPO", issuer: "prestocks" },
  {
    id: "ai",
    title: "AI",
    tagline: "The models and the chips behind them",
    underlyings: [
      "OPENAI",
      "ANTHROPIC",
      "NVDA",
      "AMD",
      "MU",
      "PLTR",
      "NBIS",
      "MRVL",
      "SKHY",
      "SNDK",
      "DRAM",
      "FIGUREAI",
      "NEURALINK",
      "QUBT",
    ],
  },
  {
    id: "mag7",
    title: "Big Tech",
    tagline: "The seven that move the market",
    underlyings: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"],
  },
  {
    id: "crypto-stocks",
    title: "Crypto stocks",
    tagline: "Public companies that live on crypto",
    underlyings: ["COIN", "CRCL", "HOOD", "MSTR", "STRC", "WULF", "DFDV", "VIDA"],
  },
  {
    id: "memestocks",
    title: "Meme stocks",
    tagline: "The originals",
    underlyings: ["GME", "AMC", "DJT", "BB", "RUM", "BULL", "RBLX", "SNAP"],
  },
  {
    id: "prediction",
    title: "Bets & markets",
    tagline: "Prediction markets, sportsbooks, casinos",
    underlyings: ["KALSHI", "POLYMARKET", "DKNG", "MGM"],
  },
  {
    id: "defense",
    title: "Defense & space",
    tagline: "Hardware for hard times",
    underlyings: ["ANDURIL", "LMT", "BA"],
  },
  {
    id: "health",
    title: "Health",
    tagline: "Pharma and care",
    underlyings: ["LLY", "JNJ", "PFE", "MRNA", "HIMS"],
  },
  { id: "etf", title: "ETFs & commodities", tagline: "Whole markets in one token", category: "etf" },
];

export const COLLECTION_IDS = COLLECTIONS.map((c) => c.id);
// text[] comes back from Hyperdrive as its literal ("{ai,mag7}"), so parse defensively.
export const pgArr = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : typeof v === "string"
      ? v
          .replace(/^\{|\}$/g, "")
          .split(",")
          .map((x) => x.trim().replace(/^"|"$/g, ""))
          .filter(Boolean)
      : [];

// Operator tags from stock_config add a stock to a collection without a deploy.
const inCollection = (c: (typeof COLLECTIONS)[number], r: StockRow) =>
  pgArr(r.tags).includes(c.id) ||
  (c.issuer
    ? r.issuer === c.issuer
    : c.category
      ? r.category === c.category
      : (c.underlyings ?? []).includes(r.underlying ?? r.symbol));
// Every collection a stock belongs to; goes out as `tags` so the app can filter without another call.
export const tagsFor = (r: StockRow) => COLLECTIONS.filter((c) => inCollection(c, r)).map((c) => c.id);
export const filterCollection = (rows: StockRow[], id: string) => {
  const c = COLLECTIONS.find((x) => x.id === id);
  return c ? rows.filter((r) => inCollection(c, r)) : [];
};

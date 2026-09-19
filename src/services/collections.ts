import type { StockRow } from "../repos/stocks";

// Order matters: this is the order the home screen shows them.
export const COLLECTIONS: readonly { id: string; title: string; tagline: string; issuer?: string; category?: string; symbols?: readonly string[] }[] = [
  { id: "preipo", title: "Pre-IPO", tagline: "Private companies, before the IPO", issuer: "prestocks" },
  { id: "ai", title: "AI", tagline: "The models and the chips behind them", symbols: ["OPENAI", "ANTHROPIC", "NVDAX", "AMD", "MU", "PLTRX", "NBIS", "MRVL", "SKHY", "SNDK", "DRAM", "FIGUREAI", "NEURALINK", "QUBT"] },
  { id: "mag7", title: "Big Tech", tagline: "The seven that move the market", symbols: ["APPLX", "MSFTX", "NVDAX", "AMZNX", "GOOGLX", "METAX", "TSLAX"] },
  { id: "crypto-stocks", title: "Crypto stocks", tagline: "Public companies that live on crypto", symbols: ["COINX", "CRCLX", "HOODX", "MSTRX", "STRCX", "WULF", "DFDV", "VIDAX"] },
  { id: "memestocks", title: "Meme stocks", tagline: "The originals", symbols: ["GMEX", "AMC", "DJT", "BB", "RUM", "WEBULL", "RBLX", "SNAP"] },
  { id: "prediction", title: "Bets & markets", tagline: "Prediction markets, sportsbooks, casinos", symbols: ["KALSHI", "POLYMARKET", "DKNG", "MGM"] },
  { id: "defense", title: "Defense & space", tagline: "Hardware for hard times", symbols: ["ANDURIL", "LMT", "BOEING"] },
  { id: "health", title: "Health", tagline: "Pharma and care", symbols: ["LLY", "JNJ", "PFIZER", "MRNA", "HIMS"] },
  { id: "etf", title: "ETFs & commodities", tagline: "Whole markets in one token", category: "etf" },
];

export const COLLECTION_IDS = COLLECTIONS.map((c) => c.id);
const inCollection = (c: (typeof COLLECTIONS)[number], r: StockRow) =>
  c.issuer ? r.issuer === c.issuer : c.category ? r.category === c.category : (c.symbols ?? []).includes(r.symbol);
// Every collection a stock belongs to; goes out as `tags` so the app can filter without another call.
export const tagsFor = (r: StockRow) => COLLECTIONS.filter((c) => inCollection(c, r)).map((c) => c.id);
export const filterCollection = (rows: StockRow[], id: string) => { const c = COLLECTIONS.find((x) => x.id === id); return c ? rows.filter((r) => inCollection(c, r)) : []; };

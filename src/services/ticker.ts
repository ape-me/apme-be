import type { TickerResponse } from "../contract";
import type { z } from "zod";

// The landing page tape: well-known stonks priced straight from Jupiter, so it runs with no database.
const TAPE = [
  [
    "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    "NVDAx",
    "https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png",
  ],
  [
    "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    "SPYx",
    "https://xstocks-metadata.backed.fi/logos/tokens/SPYx.png",
  ],
  [
    "XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo",
    "AVGOx",
    "https://xstocks-metadata.backed.fi/logos/tokens/AVGOx.png",
  ],
  [
    "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    "METAx",
    "https://xstocks-metadata.backed.fi/logos/tokens/METAx.png",
  ],
  [
    "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    "GOOGLx",
    "https://xstocks-metadata.backed.fi/logos/tokens/GOOGLx.png",
  ],
  [
    "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    "MSFTx",
    "https://xstocks-metadata.backed.fi/logos/tokens/MSFTx.png",
  ],
  [
    "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",
    "CRCLx",
    "https://xstocks-metadata.backed.fi/logos/tokens/CRCLx.png",
  ],
  ["MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1", "MU", "https://backpack.exchange/api/stock-logo/MU"],
  [
    "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3",
    "SKHY",
    "https://xstocks-metadata.backed.fi/logos/tokens/SKHYx.png",
  ],
  [
    "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF",
    "DJT",
    "https://xstocks-metadata.backed.fi/logos/tokens/DJTx.png",
  ],
] as const;

type Price = { usdPrice?: number; priceChange24h?: number };

export async function ticker(): Promise<z.infer<typeof TickerResponse>> {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${TAPE.map(([id]) => id).join(",")}`);
  const prices = r.ok ? ((await r.json()) as Record<string, Price>) : {};
  return {
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    tokens: TAPE.map(([id, label, logo]) => ({
      id,
      kind: "stonk" as const,
      label,
      logo,
      change24h: prices[id]?.priceChange24h ?? null,
      price: prices[id]?.usdPrice ?? null,
    })),
  };
}

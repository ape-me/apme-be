import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError } from "../lib/errors";
import type { UserRow } from "../repos/account";
import { aiRepo } from "../repos/ai";
import { basketsRepo } from "../repos/baskets";
import type { StockRow } from "../repos/stocks";
import { DRAFT_S, basketDetail, closeKey, universe, type BasketPick } from "./baskets";
import { news } from "./news";

// AI baskets: Sonnet shortlists from everything we list, code drops what trades badly, Sonnet weighs the rest
// against their recent news (scored by Jev). Haiku writes the idea chips.
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const DAILY_LIMIT = 20;
const MIN_POOL_USD = 50_000;
const EXAMPLES = [
  "AI needs way more chips and power",
  "Defense spending is going to boom",
  "Bitcoin keeps going up",
  "People keep paying for streaming",
];
const now = () => Math.floor(Date.now() / 1000);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}%`;

const SHORTLIST = `You build stock baskets for Stonks247, an app where people buy tokenized US stocks, ETFs, pre-IPO companies and crypto on Solana.
The user types an investing idea. Shortlist 8 to 12 tickers from the list below that best express it: the most direct plays first, then a few second-order ones (suppliers, infrastructure, a matching ETF or coin).
Rules:
- Use tickers exactly as written in the list. Nothing else exists.
- One ticker per company, and no two funds that track the same thing (e.g. two gold funds).
- No leveraged or inverse funds unless the idea asks for them.
- A bearish idea ("oil will crash") means picking what gains from it.
- If the text is not an investing idea (gibberish, a question, a request for something else, harmful), set ok to false, candidates to [], and give 3 short example ideas in its place. Otherwise ok is true and examples is [].

Ticker | Name | Type`;

const FINAL = `You build stock baskets for Stonks247 from a user's investing idea and a shortlist of candidates, each with its 1-year return and its recent news (impact and direction scored by our news model).
Pick 3 to 6 candidates and weight them.
- Weights are multiples of 5, each 5 to 40, summing to 100.
- More weight for what is closest to the idea and has strong recent news in its favour; less for side bets.
- No two picks that are the same bet (two funds on the same asset, a fund plus its top holding at a small weight).
- why: at most 12 plain words, no trailing period. Say first how it fits the idea.
- newsId: only for a story that is about this company itself and backs the idea; add its fact to why. Otherwise null. A story about a supplier, partner or an unrelated product does not count. With newsId null, why mentions no news at all.
- name: 1 to 3 words, catchy, no tickers. tagline: at most 8 words.
- bearCase: one sentence, at most 25 words, the main way this basket loses money.
- Plain English, no hype, never advice ("you should").`;

const Shortlist = z.object({
  ok: z.boolean(),
  examples: z.array(z.string()),
  candidates: z.array(z.string()),
});
const Final = z.object({
  name: z.string(),
  tagline: z.string(),
  bearCase: z.string(),
  picks: z.array(
    z.object({ ticker: z.string(), weight: z.number(), why: z.string(), newsId: z.string().nullable() }),
  ),
});
const Ideas = z.object({ ideas: z.array(z.string()) });

const client = (env: Env) => {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "ai_not_configured");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
};

// One structured call; null when the model refuses. Usage goes to the logs for cost tracking.
async function ask<T>(
  claude: Anthropic,
  a: {
    model: string;
    effort: "low" | "medium";
    system: string;
    cache?: boolean;
    content: string;
    schema: z.ZodType<T>;
  },
) {
  const r = await claude.messages
    .parse({
      model: a.model,
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: a.system,
          ...(a.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
      ],
      messages: [{ role: "user", content: a.content }],
      output_config: { effort: a.effort, format: zodOutputFormat(a.schema) },
    })
    .catch((e: Error) => {
      console.error("claude", a.model, e.message);
      throw new HttpError(503, "ai_busy");
    });
  const u = r.usage;
  console.log(
    "claude",
    a.model,
    r.stop_reason,
    u.input_tokens,
    u.cache_read_input_tokens ?? 0,
    u.output_tokens,
  );
  return r.parsed_output as T | null;
}

// Only what trades well enough to put real money in: a deep pool (Ondo fills at the real price) and a price close to
// the real stock's (pre-IPO tokens run above their last round, so they get more room).
const pickable = (r: StockRow) =>
  !r.halted &&
  (r.issuer === "ondo" || Number(r.liquidity_usd ?? 0) >= MIN_POOL_USD) &&
  Math.abs(Number(r.premium_pct ?? 0)) <= (r.category === "preipo" ? 10 : 3);

// 3 to 6 picks in steps of 5% (1 to 8 steps each, 20 in all), as close to the model's weights as that allows.
function fives(picks: { weight: number }[]) {
  const sum = picks.reduce((n, p) => n + Math.max(p.weight, 1), 0);
  const raw = picks.map((p) => (Math.max(p.weight, 1) / sum) * 20);
  const steps = raw.map((r) => Math.min(8, Math.max(1, Math.floor(r))));
  for (let left = 20 - steps.reduce((n, x) => n + x, 0); left !== 0; left -= Math.sign(left)) {
    const gap = (i: number) => (raw[i]! - steps[i]!) * Math.sign(left);
    const i = [...steps.keys()]
      .filter((k) => (left > 0 ? steps[k]! < 8 : steps[k]! > 1))
      .sort((x, y) => gap(y) - gap(x))[0]!;
    steps[i]! += Math.sign(left);
  }
  return steps.map((x) => x * 5);
}

const clean = (typed: string) => typed.trim().replace(/\s+/g, " ");

// The model's basket for an idea: name, tagline, bear case and weighted picks. Nothing is saved.
async function generate(env: Env, sql: Sql, idea: string) {
  const rows = (await universe(sql)).filter(pickable).sort((a, b) => closeKey(a).localeCompare(closeKey(b)));
  const by = new Map(rows.map((r) => [closeKey(r), r]));
  const claude = client(env);
  const short = await ask(claude, {
    model: SONNET,
    effort: "low",
    system: `${SHORTLIST}\n${rows.map((r) => `${closeKey(r)} | ${r.name} | ${r.category}`).join("\n")}`,
    cache: true,
    content: idea,
    schema: Shortlist,
  });
  if (!short?.ok)
    throw new HttpError(400, "not_an_idea", { examples: short?.examples.slice(0, 3) ?? EXAMPLES });
  const candidates = [...new Set(short.candidates)].filter((t) => by.has(t));
  if (candidates.length < 3) throw new HttpError(409, "no_match");

  const tickerOf = new Map(candidates.map((t) => [by.get(t)!.mint, t]));
  const [stories, closes] = await Promise.all([
    news.feed(sql, {
      mints: [...tickerOf.keys()],
      only: true,
      limit: 60,
      before: null,
      minImpact: 2,
      perStock: 3,
      withImage: false,
    }),
    basketsRepo.closes(sql, candidates, now() - 366 * 86400),
  ]);
  const brief = candidates
    .map((t) => {
      const c = closes.filter((x) => x.ticker === t);
      const y = c.length > 1 ? ` | 1Y ${pct((c.at(-1)!.close / c[0]!.close - 1) * 100)}` : "";
      const lines = stories
        .filter((n) => tickerOf.get(n.mint!) === t)
        .map(
          (n) =>
            `  news ${n.id} | ${new Date(n.publishedAt * 1000).toISOString().slice(0, 10)} | ${n.impact} ${n.direction ?? ""} | ${n.title}`,
        );
      return [`${t} | ${by.get(t)!.name} | ${by.get(t)!.category}${y}`, ...lines].join("\n");
    })
    .join("\n");

  let picks: BasketPick[] = [];
  let final: z.infer<typeof Final> | null = null;
  for (let tries = 0; picks.length < 3 && tries < 2; tries++) {
    final = await ask(claude, {
      model: SONNET,
      effort: "medium",
      system: FINAL,
      content: `Idea: ${idea}\n\nCandidates:\n${brief}${tries ? "\n\nPick at least 3, only from the candidates." : ""}`,
      schema: Final,
    });
    const valid = [
      ...new Map(
        (final?.picks ?? [])
          .filter((p) => by.has(p.ticker) && candidates.includes(p.ticker))
          .map((p) => [p.ticker, p]),
      ).values(),
    ]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6);
    const weights = valid.length >= 3 ? fives(valid) : [];
    picks = valid.slice(0, weights.length).map((p, i) => {
      const n = stories.find((s) => s.id === p.newsId && tickerOf.get(s.mint!) === p.ticker);
      return {
        ticker: p.ticker,
        weight: weights[i]!,
        why: p.why,
        news: n
          ? { id: n.id, title: n.title, source: n.source, url: n.url, publishedAt: n.publishedAt }
          : null,
      };
    });
  }
  if (!final || picks.length < 3) throw new HttpError(409, "no_match");
  return { name: final.name, tagline: final.tagline, bearCase: final.bearCase, shortlist: candidates, picks };
}

export async function buildBasket(env: Env, sql: Sql, user: UserRow, typed: string) {
  const idea = clean(typed);
  const [same] = await aiRepo.recent(sql, user.id, idea, now() - DRAFT_S);
  if (same) return basketDetail(sql, same.id, user.id);
  if ((await aiRepo.countSince(sql, user.id, now() - 86400)) >= DAILY_LIMIT)
    throw new HttpError(429, "daily_limit", { limit: DAILY_LIMIT });
  const g = await generate(env, sql, idea);
  const id = `ai_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await aiRepo.insert(sql, {
    id,
    userId: user.id,
    idea,
    name: g.name,
    tagline: g.tagline,
    bear_case: g.bearCase,
    picks: JSON.stringify(g.picks),
    model: SONNET,
    t: now(),
  });
  return basketDetail(sql, id, user.id);
}

// Prompt tuning: what the model makes of an idea, without saving it or counting against anyone.
export const evalIdea = (env: Env, sql: Sql, typed: string) => generate(env, sql, clean(typed));

export async function myBaskets(sql: Sql, userId: string) {
  return {
    baskets: (await aiRepo.mine(sql, userId, 50)).map((r) => ({
      id: r.id,
      name: r.name,
      tagline: r.tagline,
      idea: r.idea,
      tickers: (JSON.parse(r.picks) as BasketPick[]).map((p) => p.ticker),
      createdAt: Number(r.created_at),
    })),
  };
}

// 4 ideas from today's biggest headlines, for the chips under the input. Falls back to evergreen ones.
export async function ideaChips(env: Env, sql: Sql) {
  const [market, stocks] = await Promise.all([
    news.market(sql, { limit: 20, before: null, minImpact: 2, withImage: false }),
    news.feed(sql, { mints: [], limit: 20, before: null, minImpact: 3, perStock: 1, withImage: false }),
  ]);
  const titles = [...market, ...stocks].map((n) => `- ${n.title}`).join("\n");
  const out = titles
    ? await ask(client(env), {
        model: HAIKU,
        effort: "low",
        system:
          'From today\'s market headlines, write 4 ideas someone might want to invest in, each a theme to buy a basket of stocks for. Each 3 to 6 plain words, sentence case, no tickers, no hype, an upbeat bet rather than a warning, e.g. "AI needs way more power" or "Gold keeps climbing". Cover 4 different themes.',
        content: titles,
        schema: Ideas,
      }).catch(() => null)
    : null;
  const ideas = out?.ideas.filter((x) => x.length <= 60).slice(0, 4) ?? [];
  return { ideas: ideas.length === 4 ? ideas : EXAMPLES, asOf: now() };
}

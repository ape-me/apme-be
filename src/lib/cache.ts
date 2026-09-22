// Edge cache for hot GET responses. Keyed by full URL, TTL in seconds. Reads that change every trade use 2-5s.
export async function cached(req: Request, ttl: number, build: () => Promise<Response>): Promise<Response> {
  const url = new URL(req.url);
  const fresh = url.searchParams.get("fresh") === "1" || /no-cache/i.test(req.headers.get("cache-control") ?? "");
  if (fresh) return build();
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(req.url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (res.ok) {
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", `public, max-age=${ttl}`);
    await cache.put(key, out.clone());
    return out;
  }
  return res;
}

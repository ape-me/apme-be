# apme-be

ApeMe backend. Hono on Cloudflare Workers.

```
bun install
cp .dev.vars.example .dev.vars   # fill in
bun run dev
bun run deploy
```

## Stock overrides (no deploy needed)
Hide, re-categorise or tag a stock with one call. The API reflects it at once; the indexer re-reads `stock_config` on its 10-minute list sync and (un)subscribes.
```bash
# token lives in .admin_token (gitignored) / Worker secret ADMIN_TOKEN
curl -H "Authorization: Bearer $TOKEN" https://apme-be.iamjoey.workers.dev/v1/admin/stocks            # list, excluded first
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -X POST \
  https://apme-be.iamjoey.workers.dev/v1/admin/stocks/<mint> -d '{"excluded":true,"note":"non-PreStocks pre-IPO"}'
# fields: excluded (bool) · category (preipo|stock|etf|crypto|null) · tags ([collection ids]) · note
```

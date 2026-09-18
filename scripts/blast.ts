// Launch-day blast. Sends "ApeMe is live" to every confirmed, not-yet-blasted signup in batches of 100 via Resend,
// stamping blasted_at so a re-run skips rows already sent. Never run automatically.
//
//   RESEND_API_KEY=re_xxx APP_STORE_URL=https://apps.apple.com/... bun run scripts/blast.ts
//
// Talks to D1 through wrangler so it needs the Cloudflare token in the environment (source /root/.cf_token).
import { $ } from "bun";

const apiKey = process.env.RESEND_API_KEY; const url = process.env.APP_STORE_URL;
if (!apiKey || !url) { console.error("need RESEND_API_KEY and APP_STORE_URL"); process.exit(1); }

async function d1<T>(sql: string): Promise<T[]> {
  const out = await $`bunx wrangler d1 execute apeme --remote --json --command ${sql}`.text();
  return (JSON.parse(out)[0]?.results ?? []) as T[];
}

const text = `ApeMe is live.\n\nape memes. ape stonks. now on the App Store:\n${url}\n\nthat's the one email we promised.`;
const html = `<p>ApeMe is live.</p><p>ape memes. ape stonks. now on the App Store:<br><a href="${url}">${url}</a></p><p>that's the one email we promised.</p>`;

let sent = 0;
for (;;) {
  const rows = await d1<{ email: string }>("SELECT email FROM apelist WHERE confirmed_at IS NOT NULL AND blasted_at IS NULL ORDER BY created_at LIMIT 100");
  if (rows.length === 0) break;
  const r = await fetch("https://api.resend.com/emails/batch", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(rows.map(({ email }) => ({ from: "ApeMe <hey@apeme.fun>", to: email, subject: "ApeMe is live", text, html }))),
  });
  if (!r.ok) { console.error("resend batch failed", r.status, await r.text()); process.exit(1); }
  const list = rows.map((x) => `'${x.email.replace(/'/g, "''")}'`).join(",");
  await d1(`UPDATE apelist SET blasted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email IN (${list})`);
  sent += rows.length; console.log(`sent ${sent}`);
}
console.log(`done, ${sent} emails`);

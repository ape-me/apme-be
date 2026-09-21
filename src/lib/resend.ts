// Minimal Resend client: one email, or a batch of up to 100. Throws on non-2xx so callers decide what to do.
type Mail = { from: string; to: string; subject: string; text: string; html?: string };

async function post(apiKey: string, path: string, body: unknown) {
  const r = await fetch(`https://api.resend.com${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`resend ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
export const resend = {
  send: (apiKey: string, mail: Mail) => post(apiKey, "/emails", mail),
  batch: (apiKey: string, mails: Mail[]) => post(apiKey, "/emails/batch", mails),
};

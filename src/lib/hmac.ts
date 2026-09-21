// HMAC-SHA256 over the raw request body. Header: x-signature: <hex>. Constant-time compare.
const enc = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
export async function sign(secret: string, body: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function verify(secret: string, body: string, hex: string | undefined): Promise<boolean> {
  if (!hex || hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return false;
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, enc.encode(body));
}

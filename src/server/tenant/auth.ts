import type { IncomingMessage } from "node:http";

/** Extract a Bearer token from the Authorization header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  const value = Array.isArray(h) ? h[0] : h;
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(value);
  return m ? m[1]!.trim() : null;
}

import { createHash } from "node:crypto";

/** Compute SHA-256 over one or more byte buffers, returning the raw digest. */
export function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** SHA-256 returning lowercase hex. */
export function sha256Hex(...parts: Uint8Array[]): string {
  return sha256(...parts).toString("hex");
}

export function utf8(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

export function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`invalid hex string: ${hex}`);
  }
  return Buffer.from(clean, "hex");
}

export function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** Big-endian unsigned 64-bit integer as 8 bytes, used for counter-based derivation. */
export function u64be(n: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

/**
 * Deterministic JSON canonicalization.
 *
 * A commitment hash is only meaningful if every implementation serializes the
 * same object to the same bytes. We use a JCS-style (RFC 8785) canonical form:
 *
 *   - object keys sorted lexicographically by UTF-16 code unit
 *   - no insignificant whitespace
 *   - strings escaped with the minimal JSON escaping
 *   - integers and safe doubles serialized without exponent where possible
 *
 * We deliberately reject values a giveaway manifest should never contain
 * (undefined, functions, non-finite numbers) rather than silently dropping
 * them, so an ill-formed manifest fails loudly instead of committing to
 * ambiguous bytes.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export function canonicalize(value: Json): string {
  return serialize(value);
}

function serialize(value: Json): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object":
      if (Array.isArray(value)) {
        return "[" + value.map(serialize).join(",") + "]";
      }
      return serializeObject(value as { [k: string]: Json });
    default:
      throw new Error(`cannot canonicalize value of type ${typeof value}`);
  }
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`cannot canonicalize non-finite number: ${n}`);
  }
  // JS `JSON.stringify` already emits ECMAScript's shortest round-trippable
  // form, which is what JCS mandates for the numbers we use.
  return JSON.stringify(n);
}

function serializeString(s: string): string {
  // JSON.stringify produces RFC 8259 escaping, matching JCS's requirements.
  return JSON.stringify(s);
}

function serializeObject(obj: { [k: string]: Json }): string {
  const keys = Object.keys(obj).sort(compareCodeUnits);
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) {
      throw new Error(`cannot canonicalize undefined value at key "${key}"`);
    }
    parts.push(serializeString(key) + ":" + serialize(v));
  }
  return "{" + parts.join(",") + "}";
}

function compareCodeUnits(a: string, b: string): number {
  // Lexicographic by UTF-16 code unit, as RFC 8785 specifies.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

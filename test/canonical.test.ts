import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/protocol/canonical.js";

describe("canonicalize", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("is stable regardless of insertion order (nested)", () => {
    const x = canonicalize({ z: { d: 1, c: 2 }, a: [3, 2, 1] });
    const y = canonicalize({ a: [3, 2, 1], z: { c: 2, d: 1 } });
    expect(x).toBe(y);
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalize({ a: [1, 2], b: "x" })).toBe('{"a":[1,2],"b":"x"}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Infinity as unknown as number)).toThrow();
  });

  it("escapes strings per JSON", () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
  });
});

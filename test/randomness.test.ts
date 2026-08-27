import { describe, it, expect } from "vitest";
import {
  deriveSeed,
  selectWinnerPositions,
  drawWinners,
} from "../src/protocol/randomness.js";

const commitment = "a".repeat(64);
const blockHash = "b".repeat(64);

describe("deriveSeed", () => {
  it("is deterministic and order-sensitive", () => {
    const s1 = deriveSeed(commitment, blockHash);
    const s2 = deriveSeed(commitment, blockHash);
    expect(s1.equals(s2)).toBe(true);
    expect(s1.equals(deriveSeed(blockHash, commitment))).toBe(false);
  });
});

describe("selectWinnerPositions", () => {
  it("returns distinct positions in range", () => {
    const seed = deriveSeed(commitment, blockHash);
    const winners = selectWinnerPositions(seed, 1000, 5);
    expect(new Set(winners).size).toBe(5);
    for (const w of winners) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(1000);
    }
  });

  it("is reproducible for the same seed", () => {
    const seed = deriveSeed(commitment, blockHash);
    expect(selectWinnerPositions(seed, 500, 3)).toEqual(
      selectWinnerPositions(seed, 500, 3),
    );
  });

  it("rejects winnerCount > count", () => {
    const seed = deriveSeed(commitment, blockHash);
    expect(() => selectWinnerPositions(seed, 3, 4)).toThrow();
  });

  it("selecting all yields a full permutation", () => {
    const seed = deriveSeed(commitment, blockHash);
    const perm = selectWinnerPositions(seed, 10, 10);
    expect([...perm].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("is approximately uniform (no gross modulo bias)", () => {
    // First-position distribution over many block hashes should be roughly flat.
    const n = 7; // a modulus that does not divide 2^32 evenly
    const counts = new Array(n).fill(0);
    const trials = 14000;
    for (let i = 0; i < trials; i++) {
      const seed = deriveSeed(commitment, i.toString(16).padStart(64, "0"));
      counts[selectWinnerPositions(seed, n, 1)[0]!]++;
    }
    const expected = trials / n;
    for (const c of counts) {
      // within 12% of expected — loose, but catches a biased mapping
      expect(Math.abs(c - expected) / expected).toBeLessThan(0.12);
    }
  });
});

describe("drawWinners", () => {
  it("produces a reproducible, self-consistent result", () => {
    const r = drawWinners({
      commitmentHash: commitment,
      bitcoinBlockHeight: 912144,
      bitcoinBlockHash: blockHash,
      participantCount: 100,
      winnerCount: 3,
    });
    expect(r.winnerPositions).toHaveLength(3);
    expect(new Set(r.winnerPositions).size).toBe(3);
    expect(r.seed).toBe(deriveSeed(commitment, blockHash).toString("hex"));
  });
});

import { sha256, hexToBytes, bytesToHex, u64be } from "./hash.js";

/**
 * Randomness derivation and winner selection.
 *
 *   seed = SHA256( commitment_hash_bytes || bitcoin_block_hash_bytes )
 *
 * Because the commitment (which fixes the participant set and the block
 * height) is published and OpenTimestamped before the block exists, and the
 * block hash is unknown until mined, no party can steer the seed toward a
 * chosen winner.
 */
export function deriveSeed(
  commitmentHashHex: string,
  bitcoinBlockHashHex: string,
): Buffer {
  return sha256(hexToBytes(commitmentHashHex), hexToBytes(bitcoinBlockHashHex));
}

/**
 * Counter-based deterministic byte stream: block_i = SHA256(seed || u64be(i)).
 * A simple, language-portable CSPRNG expansion of the 32-byte seed.
 */
class SeededStream {
  private readonly seed: Buffer;
  private counter = 0n;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private offset = 0;

  constructor(seed: Buffer) {
    this.seed = seed;
  }

  private refill(): void {
    this.buffer = sha256(this.seed, u64be(this.counter));
    this.counter += 1n;
    this.offset = 0;
  }

  nextUint32(): number {
    if (this.offset + 4 > this.buffer.length) this.refill();
    const v = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  /**
   * Uniform integer in [0, n) with rejection sampling to avoid modulo bias.
   * n must be >= 1 and <= 2^32.
   */
  nextBelow(n: number): number {
    if (n < 1 || n > 0x1_0000_0000) {
      throw new Error(`nextBelow out of supported range: ${n}`);
    }
    if (n === 1) return 0;
    // Largest multiple of n that fits in 2^32; reject values at/above it.
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const v = this.nextUint32();
      if (v < limit) return v % n;
    }
  }
}

/**
 * Select `winnerCount` distinct entry indices out of `count` using a
 * seed-driven partial Fisher–Yates shuffle. Returns 0-based positions in
 * selection order (1st winner first). Guarantees uniqueness.
 */
export function selectWinnerPositions(
  seed: Buffer,
  count: number,
  winnerCount: number,
): number[] {
  if (winnerCount < 1) throw new Error("winnerCount must be >= 1");
  if (winnerCount > count) {
    throw new Error(`winnerCount (${winnerCount}) exceeds count (${count})`);
  }
  const stream = new SeededStream(seed);
  const pool = Array.from({ length: count }, (_, i) => i);
  const winners: number[] = [];
  for (let i = 0; i < winnerCount; i++) {
    // pick from remaining [i, count)
    const j = i + stream.nextBelow(count - i);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
    winners.push(pool[i]!);
  }
  return winners;
}

export interface DrawResult {
  seed: string; // hex
  bitcoinBlockHash: string; // hex
  bitcoinBlockHeight: number;
  /** 0-based positions into the frozen participant list, in selection order. */
  winnerPositions: number[];
}

/** Full deterministic draw from a commitment + fetched block hash. */
export function drawWinners(params: {
  commitmentHash: string;
  bitcoinBlockHeight: number;
  bitcoinBlockHash: string;
  participantCount: number;
  winnerCount: number;
}): DrawResult {
  const seed = deriveSeed(params.commitmentHash, params.bitcoinBlockHash);
  const winnerPositions = selectWinnerPositions(
    seed,
    params.participantCount,
    params.winnerCount,
  );
  return {
    seed: bytesToHex(seed),
    bitcoinBlockHash: params.bitcoinBlockHash,
    bitcoinBlockHeight: params.bitcoinBlockHeight,
    winnerPositions,
  };
}

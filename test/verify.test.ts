import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

// engine (node:crypto-backed)
import { parseCsvParticipants } from "../src/sources/csv.js";
import { buildGiveaway } from "../src/protocol/manifest.js";
import { drawWinners } from "../src/protocol/randomness.js";
import {
  MerkleTree as EngineTree,
} from "../src/protocol/merkle.js";
import { participantLeafPreimage as engineLeaf } from "../src/protocol/participant.js";

// isomorphic verifier (dependency-free sha256)
import { sha256 as pureSha256 } from "../src/verify/sha256.js";
import {
  verifyGiveaway,
  lookupParticipant,
  computeMerkleRoot,
  participantLeafPreimage as verifyLeaf,
  deriveSeed,
  selectWinnerPositions,
  bytesToHex,
} from "../src/verify/core.js";

const CSV = `username
@Alice
bob
CHARLIE
david
erin
frank
grace
`;

describe("pure sha256 matches node:crypto", () => {
  it("agrees on many inputs", () => {
    for (let i = 0; i < 200; i++) {
      const msg = Buffer.from(`msg-${i}-${"x".repeat(i)}`);
      const a = createHash("sha256").update(msg).digest("hex");
      const b = bytesToHex(pureSha256(new Uint8Array(msg)));
      expect(b).toBe(a);
    }
  });
  it("handles empty and 64-byte boundary inputs", () => {
    for (const n of [0, 55, 56, 63, 64, 65, 119, 120]) {
      const msg = Buffer.alloc(n, 7);
      expect(bytesToHex(pureSha256(new Uint8Array(msg)))).toBe(
        createHash("sha256").update(msg).digest("hex"),
      );
    }
  });
});

describe("verifier core agrees with the engine", () => {
  const built = buildGiveaway({
    giveawayId: "giveaway-xcheck",
    participants: parseCsvParticipants(CSV),
    winnerCount: 3,
    selection: { scheduled_at: "2026-09-01T18:00:00+05:30", timezone: "Asia/Kolkata" },
    randomness: { source: "bitcoin", selection_rule: "predetermined-block-height", block_height: 912144 },
  });

  it("computes the same Merkle root", () => {
    const engineRoot = new EngineTree(
      built.participants.map((p) => engineLeaf("giveaway-xcheck", p)),
    ).root;
    const verifyRoot = computeMerkleRoot(
      built.participants.map((p) => verifyLeaf("giveaway-xcheck", p)),
    );
    expect(verifyRoot).toBe(engineRoot);
    expect(verifyRoot).toBe(built.manifest.participant_merkle_root);
  });

  it("derives the same seed and winners", () => {
    const blockHash = "a1b2".repeat(16);
    const engineDraw = drawWinners({
      commitmentHash: built.commitmentHash,
      bitcoinBlockHeight: 912144,
      bitcoinBlockHash: blockHash,
      participantCount: built.manifest.participant_count,
      winnerCount: 3,
    });
    const seed = deriveSeed(built.commitmentHash, blockHash);
    expect(bytesToHex(seed)).toBe(engineDraw.seed);
    const positions = selectWinnerPositions(seed, built.manifest.participant_count, 3);
    expect(positions).toEqual(engineDraw.winnerPositions);
  });
});

describe("verifyGiveaway end-to-end", () => {
  it("passes on good artifacts and reproduces winners", () => {
    const built = buildGiveaway({
      giveawayId: "g1",
      participants: parseCsvParticipants(CSV),
      winnerCount: 2,
      selection: { scheduled_at: "2026-01-01T00:00:00Z", timezone: "UTC" },
      randomness: { source: "bitcoin", selection_rule: "predetermined-block-height", block_height: 5 },
    });
    const blockHash = "f".repeat(64);
    const draw = drawWinners({
      commitmentHash: built.commitmentHash,
      bitcoinBlockHeight: 5,
      bitcoinBlockHash: blockHash,
      participantCount: built.manifest.participant_count,
      winnerCount: 2,
    });
    const winners = draw.winnerPositions.map((pos) => {
      const p = built.participants[pos]!;
      return { entry: p.entry, username: p.username };
    });

    const report = verifyGiveaway({
      manifest: built.manifest,
      participantFileBytes: new Uint8Array(built.participantFileBytes),
      result: { ...draw, winners },
    });
    expect(report.ok).toBe(true);
    expect(report.commitment).toBe(built.commitmentHash);

    // lookup a known winner
    const winnerName = winners[0]!.username;
    const look = lookupParticipant(
      {
        manifest: built.manifest,
        participantFileBytes: new Uint8Array(built.participantFileBytes),
        result: { ...draw, winners },
      },
      "@" + winnerName.toUpperCase(),
    );
    expect(look.found).toBe(true);
    expect(look.proofValid).toBe(true);
    expect(look.isWinner).toBe(true);
    expect(look.winnerRank).toBe(1);
  });

  it("fails when participant bytes are tampered", () => {
    const built = buildGiveaway({
      giveawayId: "g2",
      participants: parseCsvParticipants(CSV),
      winnerCount: 1,
      selection: { scheduled_at: "2026-01-01T00:00:00Z", timezone: "UTC" },
      randomness: { source: "bitcoin", selection_rule: "predetermined-block-height", block_height: 5 },
    });
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(built.participantFileBytes).replace("alice", "xlice"),
    );
    const report = verifyGiveaway({
      manifest: built.manifest,
      participantFileBytes: tampered,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.label.includes("file_sha256"))!.pass).toBe(false);
  });
});

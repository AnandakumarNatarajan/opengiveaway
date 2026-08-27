import { describe, it, expect } from "vitest";
import { parseCsvParticipants } from "../src/sources/csv.js";
import {
  buildGiveaway,
  commitmentHash,
  parseParticipantFile,
} from "../src/protocol/manifest.js";
import { drawWinners } from "../src/protocol/randomness.js";
import { MerkleTree, verifyProof } from "../src/protocol/merkle.js";
import { participantLeafPreimage } from "../src/protocol/participant.js";
import { StaticProvider } from "../src/bitcoin/provider.js";

const CSV = `username
@Alice
bob
CHARLIE
alice
david
erin
`;

describe("end-to-end giveaway", () => {
  it("commits, draws, and verifies deterministically", async () => {
    const raw = parseCsvParticipants(CSV);
    const built = buildGiveaway({
      giveawayId: "giveaway-001",
      participants: raw,
      winnerCount: 2,
      selection: { scheduled_at: "2026-09-01T18:00:00+05:30", timezone: "Asia/Kolkata" },
      randomness: {
        source: "bitcoin",
        selection_rule: "predetermined-block-height",
        block_height: 912144,
      },
    });

    // dedup: alice appears twice -> 5 unique
    expect(built.participants.map((p) => p.username)).toEqual([
      "alice",
      "bob",
      "charlie",
      "david",
      "erin",
    ]);

    // commitment is stable across rebuilds
    expect(commitmentHash(built.manifest)).toBe(built.commitmentHash);

    // draw from a fixed block hash via the offline provider
    const provider = new StaticProvider(
      new Map([[912144, "f".repeat(64)]]),
      912200,
    );
    const blockHash = await provider.getBlockHash(912144);
    const result = drawWinners({
      commitmentHash: built.commitmentHash,
      bitcoinBlockHeight: 912144,
      bitcoinBlockHash: blockHash,
      participantCount: built.manifest.participant_count,
      winnerCount: 2,
    });
    expect(new Set(result.winnerPositions).size).toBe(2);

    // an independent verifier reproduces the identical result
    const redraw = drawWinners({
      commitmentHash: built.commitmentHash,
      bitcoinBlockHeight: 912144,
      bitcoinBlockHash: blockHash,
      participantCount: built.manifest.participant_count,
      winnerCount: 2,
    });
    expect(redraw.winnerPositions).toEqual(result.winnerPositions);

    // inclusion proof for a winner verifies against the committed root
    const { participants } = parseParticipantFile(built.participantFileBytes);
    const tree = new MerkleTree(
      participants.map((p) => participantLeafPreimage("giveaway-001", p)),
    );
    const pos = result.winnerPositions[0]!;
    const proof = tree.proof(pos);
    const preimage = participantLeafPreimage("giveaway-001", participants[pos]!);
    expect(
      verifyProof(preimage, proof, built.manifest.participant_merkle_root),
    ).toBe(true);
  });

  it("rejects winner count exceeding participants", () => {
    expect(() =>
      buildGiveaway({
        giveawayId: "g",
        participants: parseCsvParticipants("username\nonlyone\n"),
        winnerCount: 2,
        selection: { scheduled_at: "2026-01-01T00:00:00Z", timezone: "UTC" },
        randomness: {
          source: "bitcoin",
          selection_rule: "predetermined-block-height",
          block_height: 1,
        },
      }),
    ).toThrow();
  });
});

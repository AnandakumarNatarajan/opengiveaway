import { canonicalize, type Json } from "./canonical.js";
import { sha256Hex, utf8 } from "./hash.js";
import { MerkleTree } from "./merkle.js";
import {
  freezeParticipants,
  participantLeafPreimage,
  type FrozenParticipant,
  type RawParticipant,
} from "./participant.js";

export const PROTOCOL_VERSION = "1.0";

/**
 * How the randomness block is chosen. We commit to a *predetermined block
 * height* rather than "first block at/after time T", because miner-supplied
 * block timestamps are not reliable wall-clock times and a time-based rule
 * leaves wiggle room. The height is fixed in the manifest before the block
 * exists, so the organizer cannot grind on the eventual block hash.
 */
export interface RandomnessSpec {
  source: "bitcoin";
  selection_rule: "predetermined-block-height";
  block_height: number;
}

export interface SelectionSpec {
  /** Human-facing scheduled draw time (informational). */
  scheduled_at: string; // ISO 8601 with offset
  timezone: string; // IANA tz, e.g. "Asia/Kolkata"
}

/** The full committed giveaway configuration. */
export interface GiveawayManifest {
  protocol_version: string;
  giveaway_id: string;
  participant_count: number;
  participant_file_sha256: string;
  participant_merkle_root: string;
  winner_count: number;
  selection: SelectionSpec;
  randomness: RandomnessSpec;
}

export interface BuildManifestInput {
  giveawayId: string;
  participants: RawParticipant[];
  winnerCount: number;
  selection: SelectionSpec;
  randomness: RandomnessSpec;
}

export interface BuiltGiveaway {
  manifest: GiveawayManifest;
  /** Frozen, sorted, entry-numbered participants. */
  participants: FrozenParticipant[];
  /** The exact bytes hashed for participant_file_sha256. */
  participantFileBytes: Buffer;
  /** SHA-256 of the canonical manifest = the commitment. */
  commitmentHash: string;
}

/**
 * Canonical serialization of the frozen participant file. This is the exact
 * artifact whose SHA-256 goes into `participant_file_sha256`; publishing it
 * lets anyone recompute both that hash and the Merkle root.
 */
export function serializeParticipantFile(
  giveawayId: string,
  participants: FrozenParticipant[],
): Buffer {
  const obj: Json = {
    giveaway_id: giveawayId,
    participants: participants.map((p) => ({
      entry: p.entry,
      username: p.username,
      source: p.source,
      source_id: p.source_id,
    })),
  };
  return utf8(canonicalize(obj));
}

/** Parse a canonical participant file back into frozen participants. */
export function parseParticipantFile(bytes: Buffer): {
  giveawayId: string;
  participants: FrozenParticipant[];
} {
  const obj = JSON.parse(bytes.toString("utf8")) as {
    giveaway_id: string;
    participants: {
      entry: number;
      username: string;
      source: string;
      source_id: string;
    }[];
  };
  return {
    giveawayId: obj.giveaway_id,
    participants: obj.participants.map((p) => ({
      entry: p.entry,
      username: p.username,
      source: p.source,
      source_id: p.source_id,
    })),
  };
}

/** SHA-256 hex of the canonical manifest — the value anchored via OpenTimestamps. */
export function commitmentHash(manifest: GiveawayManifest): string {
  return sha256Hex(utf8(canonicalize(manifest as unknown as Json)));
}

export function buildGiveaway(input: BuildManifestInput): BuiltGiveaway {
  if (input.winnerCount < 1) {
    throw new Error("winnerCount must be >= 1");
  }
  const participants = freezeParticipants(input.participants);
  if (participants.length === 0) {
    throw new Error("no participants after normalization/dedup");
  }
  if (input.winnerCount > participants.length) {
    throw new Error(
      `winnerCount (${input.winnerCount}) exceeds participant count (${participants.length})`,
    );
  }

  const participantFileBytes = serializeParticipantFile(
    input.giveawayId,
    participants,
  );

  const tree = new MerkleTree(
    participants.map((p) => participantLeafPreimage(input.giveawayId, p)),
  );

  const manifest: GiveawayManifest = {
    protocol_version: PROTOCOL_VERSION,
    giveaway_id: input.giveawayId,
    participant_count: participants.length,
    participant_file_sha256: sha256Hex(participantFileBytes),
    participant_merkle_root: tree.root,
    winner_count: input.winnerCount,
    selection: input.selection,
    randomness: input.randomness,
  };

  return {
    manifest,
    participants,
    participantFileBytes,
    commitmentHash: commitmentHash(manifest),
  };
}

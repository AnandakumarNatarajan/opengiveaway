import { canonicalize } from "./canonical.js";
import { sha256Hex, utf8 } from "./hash.js";

export const PARTICIPANT_LEAF_DOMAIN = "giveaway-participant-v1";

/** A participant as ingested from a source, before freezing. */
export interface RawParticipant {
  username: string;
  source: string; // e.g. "csv", "instagram"
  source_id: string; // provenance within the source, e.g. "row_42"
}

/** A frozen participant with a deterministic entry index. */
export interface FrozenParticipant extends RawParticipant {
  /** Normalized username used for the leaf and for lookups. */
  username: string;
  /** 1-based entry number, assigned deterministically after sorting. */
  entry: number;
}

/**
 * Normalize a username to a canonical form.
 *
 *   @Alice / alice / ALICE  ->  alice
 *
 * Kept intentionally simple and explicit so the rule is easy to reproduce in
 * any language. Unicode is NFC-normalized so visually identical names collide.
 */
export function normalizeUsername(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

/**
 * Freeze a raw participant list: normalize, drop empties, deduplicate by
 * normalized username (first occurrence wins for provenance), sort
 * deterministically, and assign 1-based entry numbers.
 *
 * The engine must never depend on source ordering (e.g. Instagram API order),
 * so the same dataset always yields the same frozen set.
 */
export function freezeParticipants(raw: RawParticipant[]): FrozenParticipant[] {
  const byUsername = new Map<string, RawParticipant>();
  for (const p of raw) {
    const username = normalizeUsername(p.username);
    if (username === "") continue;
    if (!byUsername.has(username)) {
      byUsername.set(username, { ...p, username });
    }
  }

  const deduped = [...byUsername.values()];
  deduped.sort((a, b) => {
    if (a.username < b.username) return -1;
    if (a.username > b.username) return 1;
    // Stable tie-break (usernames are unique post-dedup, but be explicit).
    if (a.source_id < b.source_id) return -1;
    if (a.source_id > b.source_id) return 1;
    return 0;
  });

  return deduped.map((p, i) => ({ ...p, entry: i + 1 }));
}

/**
 * Deterministic leaf preimage for a participant.
 *
 * We hash the canonical JSON of a domain-tagged object rather than string
 * concatenation, so a delimiter appearing inside a field can never forge a
 * different participant. This preimage is then Merkle-leaf-hashed (0x00 tag).
 */
export function participantLeafPreimage(
  giveawayId: string,
  p: FrozenParticipant,
): Buffer {
  const obj = {
    domain: PARTICIPANT_LEAF_DOMAIN,
    giveaway_id: giveawayId,
    username: p.username,
    source_type: p.source,
    source_id: p.source_id,
  };
  return utf8(canonicalize(obj));
}

/** Convenience: hex SHA-256 of a leaf preimage (not Merkle-tagged). */
export function participantLeafDigest(
  giveawayId: string,
  p: FrozenParticipant,
): string {
  return sha256Hex(participantLeafPreimage(giveawayId, p));
}

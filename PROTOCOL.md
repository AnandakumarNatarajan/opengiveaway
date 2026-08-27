# OpenGiveaway Protocol v1.0

This document freezes the two hardest-to-change parts of the system — the
**canonical participant / Merkle-leaf format** and the **Bitcoin
block-selection rule** — plus the commitment, randomness, and winner-selection
math. An implementation in any language that follows this document will produce
byte-identical commitments and identical winners.

Everything below is defined over **SHA-256** and raw bytes. Hex is always
lowercase.

## 1. Canonical JSON

Any object that is hashed is first serialized with a JCS-style canonical form
(RFC 8785): object keys sorted lexicographically by UTF-16 code unit, no
insignificant whitespace, RFC 8259 string escaping, ECMAScript shortest-form
numbers. Non-finite numbers and `undefined` are rejected. See
`src/protocol/canonical.ts`.

## 2. Participant normalization

```
normalize(u) = lowercase( strip_leading('@', trim( NFC(u) ) ) )
```

Freezing a raw participant list:

1. normalize every username; drop empties
2. deduplicate by normalized username — **first occurrence keeps provenance**
3. sort ascending by `(username, source_id)`
4. assign 1-based `entry` numbers in sorted order

The engine must never depend on source ordering. The same dataset always
freezes to the same set.

## 3. Participant leaf

Each participant's Merkle leaf preimage is the canonical JSON of a
domain-tagged object (hashing the canonical object, not a delimited string, so
no field value can forge another participant):

```json
{
  "domain": "giveaway-participant-v1",
  "giveaway_id": "<id>",
  "source_id": "<provenance>",
  "source_type": "<source>",
  "username": "<normalized>"
}
```

(keys shown unsorted for readability; they are sorted at serialization time.)

## 4. Merkle tree

- Leaf hash: `SHA256(0x00 || leaf_preimage_bytes)`
- Internal node: `SHA256(0x01 || left || right)`
- Distinct `0x00` / `0x01` domain tags prevent second-preimage attacks.
- **Odd node handling: promote the lone node unchanged** to the next level
  (never duplicate the last node — that reintroduces CVE-2012-2459
  malleability).
- Root of a single leaf is that leaf's `0x00`-tagged hash.

An inclusion proof is the ordered list of sibling hashes with each sibling's
side (`left`/`right`). A verifier recomputes the root from a leaf preimage +
proof and compares to the committed root — it never needs the full set.

## 5. Participant file

The published `participants.json` is the canonical JSON of:

```json
{
  "giveaway_id": "<id>",
  "participants": [
    { "entry": 1, "username": "alice", "source": "csv", "source_id": "row_1" }
  ]
}
```

`participant_file_sha256` in the manifest is SHA-256 of these exact bytes.

## 6. Manifest and commitment

The manifest commits to the entire giveaway state:

```json
{
  "protocol_version": "1.0",
  "giveaway_id": "giveaway-001",
  "participant_count": 18342,
  "participant_file_sha256": "…",
  "participant_merkle_root": "…",
  "winner_count": 3,
  "selection": { "scheduled_at": "2026-09-01T18:00:00+05:30", "timezone": "Asia/Kolkata" },
  "randomness": { "source": "bitcoin", "selection_rule": "predetermined-block-height", "block_height": 912144 }
}
```

```
commitment_hash = SHA256( canonical_json(manifest) )   // hex
```

The file hash and the Merkle root are both retained: the file hash proves the
exact snapshot is unchanged; the Merkle root enables per-participant inclusion
proofs.

## 7. OpenTimestamps

The `commitment_hash` (already a SHA-256 digest) is anchored to Bitcoin via
OpenTimestamps, producing `giveaway.ots`. Only the hash is submitted — never
participant data. A fresh proof is *pending* (calendar-backed) and becomes
Bitcoin-attested once mined; `opengiveaway upgrade` refreshes it. This proves
the commitment existed **before** the randomness block.

## 8. Bitcoin block-selection rule — `predetermined-block-height`

The randomness block is fixed as an explicit **block height** in the manifest,
committed before that block exists. We deliberately avoid a time-based rule
("first block at/after time T") because miner-supplied block timestamps are not
reliable wall-clock values, and a time rule leaves the organizer wiggle room.

- `randomness.block_height` is chosen when scheduling (e.g. current tip +
  ~144 blocks ≈ 24h) and committed.
- `scheduled_at` / `timezone` are **human-facing only**; they never feed the
  draw.
- The draw uses the hash of exactly that height — no "pick whichever of these
  blocks I like".

## 9. Randomness

```
seed = SHA256( bytes(commitment_hash) || bytes(bitcoin_block_hash) )
```

Because the commitment is timestamped before the block is mined, and the block
hash is unpredictable, no party can steer the seed toward a chosen winner.

Deterministic byte stream expanding the 32-byte seed:

```
block_i = SHA256( seed || u64be(i) )      // i = 0, 1, 2, …
```

Read big-endian `uint32` values from this stream.

## 10. Winner selection (unique, bias-free)

Uniform integer in `[0, n)` uses **rejection sampling** to avoid modulo bias:
draw a `uint32`, reject any value `>= floor(2^32 / n) * n`, else return
`value % n`.

Winners are the first `winner_count` positions of a seed-driven **partial
Fisher–Yates shuffle** over `[0, participant_count)`, returned in selection
order. This guarantees distinct winners and is fully reproducible.

The 0-based positions map to the frozen participant list (position → `entry`).

## 11. Two independent proofs

- **Eligibility:** participant → leaf → Merkle proof → committed root. *"Alice
  was in the giveaway."*
- **Selection:** commitment + block hash → seed → shuffle → Alice's position.
  *"Alice was selected by the predetermined randomness."*

Both are verifiable from the published `manifest.json`, `participants.json`,
and `giveaway.ots` without trusting the organizer's server.

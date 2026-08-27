# OpenGiveaway

A self-hostable, **cryptographically verifiable** giveaway system.

> Commit the complete giveaway state with a SHA-256 hash + Merkle root, anchor
> that commitment to Bitcoin through OpenTimestamps **before** the draw, then
> use a **predetermined Bitcoin block** as an independent source of public
> randomness to deterministically select winner(s).

A normal picker says *"trust me, I picked @alice."* OpenGiveaway says *"here is
the participant commitment, the timestamp proof, the Bitcoin randomness, and the
deterministic calculation — verify it yourself,"* ideally **without needing the
organizer's server**.

This is the **Phase 1 MVP**: CSV participants, the full protocol core, and a
CLI (`commit → draw → verify`). Instagram and a web UI are later phases; the
protocol engine is deliberately independent of any UI or database so those can
be added without touching it.

## What it answers

1. **Who was eligible?** — the frozen participant set
2. **Was that set committed before the draw?** — OpenTimestamps
3. **Was the winner chosen by unpredictable public randomness?** — a
   predetermined Bitcoin block hash

## Install

```bash
npm install
npm test          # 24 tests: canonicalization, Merkle, randomness, e2e
npm run build     # compiles to dist/  (then `opengiveaway` is runnable)
```

Node ≥ 20. During development, run the CLI with `npm run cli -- <command>`.

## Quickstart

```bash
# 1) COMMIT: freeze participants, build + hash the manifest, OpenTimestamp it.
#    Pick a future Bitcoin block height (≈ current tip + 144 ≈ 24h ahead).
npm run cli -- commit \
  --csv examples/participants.csv \
  --giveaway-id giveaway-001 \
  --winners 3 \
  --block-height 912144 \
  --scheduled-at "2026-09-01T18:00:00+05:30" --timezone Asia/Kolkata \
  --out out

# Publish out/manifest.json, out/participants.json, out/commitment.txt,
# out/giveaway.ots BEFORE the draw. That is your public, tamper-evident record.

# 2) DRAW (after block 912144 is mined): fetch its hash and select winners.
npm run cli -- draw --out out
#   ...or reproduce offline with a known hash:
#   npm run cli -- draw --out out --block-hash <64-hex>

# 3) VERIFY: recompute everything independently.
npm run cli -- verify --out out
```

### Per-participant inclusion proofs

```bash
npm run cli -- prove --username @alice --out out --json alice-proof.json
npm run cli -- check-proof --proof alice-proof.json
```

`check-proof` recomputes the Merkle root from the leaf + proof and compares it
to the committed root — no server, no full participant list required. This is
the same computation a browser verifier would run (Phase 3).

## CSV format

A header row with a `username` column (override with `--username-column`, or
use `--no-header` to take the first column):

```csv
username
@Alice
bob
CHARLIE
```

Usernames are normalized (`@Alice`, `alice`, `ALICE` → `alice`) and
deduplicated before freezing.

## Published artifacts (`out/`)

| File               | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `manifest.json`    | The committed giveaway configuration                       |
| `participants.json`| Canonical frozen participant file (its SHA-256 is committed)|
| `commitment.txt`   | SHA-256 of the canonical manifest                          |
| `giveaway.ots`     | OpenTimestamps proof over the commitment                   |
| `result.json`      | Draw output: block, seed, winners (after `draw`)           |

## How the guarantees fit together

| Mechanism          | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| File SHA-256       | Proves the exact snapshot hasn't changed           |
| Merkle root        | Enables individual participant inclusion proofs    |
| OpenTimestamps     | Proves the commitment existed before the draw      |
| Bitcoin block hash | Provides unpredictable public randomness           |

The exact byte formats and the block-selection rule are frozen in
[`PROTOCOL.md`](./PROTOCOL.md).

## Architecture

```
src/
  protocol/     UI- and DB-independent core (the frozen protocol)
    canonical   deterministic JSON (RFC 8785-style)
    hash        SHA-256 helpers
    merkle      Merkle tree + inclusion proofs
    participant normalization, dedup, freezing, leaf format
    manifest    manifest build + commitment hash
    randomness  seed derivation, bias-free shuffle, winner selection
  sources/csv   CSV participant source (the only source in Phase 1)
  bitcoin/      pluggable block provider (Esplora/mempool.space; offline for tests)
  timestamp/    OpenTimestamps wrapper (optional dependency)
  cli/          commit / draw / verify / prove / check-proof / upgrade
```

## OpenTimestamps note

`opentimestamps` is an **optional** dependency. If it isn't installed (or
`--no-ots` is passed), the rest of the protocol runs and `verify` simply skips
the OTS check. The upstream library pulls older transitive packages, which is
why `npm audit` reports advisories confined to that optional chain; the core
protocol has no such dependencies.

## Status / roadmap

- **Phase 1 (this repo):** CSV → freeze → Merkle → manifest → SHA-256 →
  OpenTimestamps → Bitcoin randomness → winners → verification. ✅
- **Phase 2:** Instagram OAuth/API comment source (same participant pipeline).
- **Phase 3:** Public web verifier, participant lookup page, browser-side Merkle
  verification, standalone CLI verifier package.

## License

MIT

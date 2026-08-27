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

This is **Phases 1 & 3**: CSV participants, the full protocol core, the
organizer CLI (`commit → draw → verify`), **and public verification** — a
dependency-free standalone verifier that runs identically in Node and the
browser, plus a self-contained web page. Instagram (Phase 2) is intentionally
skipped for now; the protocol engine is independent of any UI or database so it
can be added later without touching it.

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

## Self-hosted server (organizer Web UI + API)

The quickest way to run everything — create giveaways, draw them, and hand out
a verifier link — is the built-in server:

```bash
npm run build          # compiles dist/ and builds web/verifier.html
npm run cli -- app --data ./data --port 8080
# open http://localhost:8080
```

- **`/`** — organizer UI: paste or upload a CSV, set winners / block height /
  schedule, optionally OpenTimestamp, then **Commit**. Draw winners with one
  click (fetches the predetermined block hash, or prompts for it offline).
- **`/verify?g=<id>`** — the public verifier, auto-loading that giveaway's
  published artifacts and re-checking everything in the browser. It also shows a
  live **OpenTimestamps status** (attested / pending / present / absent),
  verified server-side, with an Upgrade action for a pending proof. OTS is a
  temporal proof and is reported separately from the cryptographic integrity
  result — a not-yet-mined timestamp never fails verification.
- **`/g/<id>/manifest.json`** (and `participants.json`, `result.json`,
  `giveaway.ots`) — the raw published artifacts, so anyone can download and
  verify with `opengiveaway-verify` or their own tools.

Each giveaway is stored as `./data/<id>/` in exactly the published-artifact
layout. The HTTP layer holds no protocol logic — it calls the same engine the
CLI does.

### Docker

```bash
docker compose up --build     # server on :8080, data in a named volume
# or:
docker build -t opengiveaway .
docker run -p 8080:8080 -v opengiveaway-data:/data opengiveaway
```

## Organizer CLI (scriptable alternative)

Prefer the command line? The same lifecycle without the server:

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
to the committed root — no server, no full participant list required.

## Public verification (Phase 3)

Anyone can re-derive the entire result from the published files — **without
trusting the organizer's server**. Two independent verifiers, both driven by
the same dependency-free `verify/core` (an isomorphic re-implementation of the
protocol that is cross-checked against the engine in the test suite):

### Standalone CLI verifier

```bash
# from a downloaded giveaway directory:
npx opengiveaway-verify ./downloaded-giveaway --username @alice
# or loose files:
npx opengiveaway-verify --manifest manifest.json --participants participants.json --result result.json
```

It recomputes the file hash, Merkle root, commitment, and winners from scratch
using a pure-JS SHA-256 (no `node:crypto`), and — with `--username` — checks a
participant's inclusion proof and winner status. OpenTimestamps is verified too
if the optional `opentimestamps` package is present.

### Self-contained web verifier

`web/verifier.html` (built by `npm run build:web`) is a single file with all
crypto inlined. It runs two ways:

```bash
# 1) Serve it alongside a giveaway directory:
npm run cli -- serve --out out --port 8080
#    open http://localhost:8080 and click "Load from this page's server"

# 2) Fully offline: open web/verifier.html from disk and load the downloaded
#    manifest.json / participants.json / result.json with the file pickers.
```

The page shows the commitment-integrity checks, the winners, and a **"Was I
included?"** lookup that recomputes the Merkle inclusion proof in the browser —
no server is trusted to answer *"yes, Alice participated."*

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
  cli/          commit / draw / verify / prove / check-proof / upgrade / serve / app
  server/       self-hosted HTTP layer: organizer UI + JSON API + artifacts
  verify/       isomorphic, dependency-free verifier (Node + browser)
    sha256      pure-JS SHA-256 (cross-checked against node:crypto)
    core        canonical JSON, Merkle verify, commitment, seed, winners
    cli         standalone `opengiveaway-verify` binary
    browser     bundled into web/verifier.html
web/
  app.html      organizer Web UI (served by `app`)
  verifier.html self-contained public verifier (template + built HTML)
Dockerfile, docker-compose.yml   self-hosted deployment
```

## OpenTimestamps note

`opentimestamps` is an **optional** dependency. If it isn't installed (or
`--no-ots` is passed), the rest of the protocol runs and `verify` simply skips
the OTS check. The upstream library pulls older transitive packages, which is
why `npm audit` reports advisories confined to that optional chain; the core
protocol has no such dependencies.

## Status / roadmap

- **Phase 1:** CSV → freeze → Merkle → manifest → SHA-256 → OpenTimestamps →
  Bitcoin randomness → multiple winners → verification. ✅
- **Phase 3:** Public web verifier, participant lookup with browser-side Merkle
  verification, standalone dependency-free CLI verifier package. ✅
- **Self-hosted app:** organizer Web UI + JSON API + Docker packaging. ✅
- **Phase 2 (deferred):** Instagram OAuth/API comment source feeding the same
  participant pipeline.

## License

MIT

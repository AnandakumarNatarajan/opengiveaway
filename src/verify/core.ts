/**
 * Isomorphic giveaway verifier — runs identically in Node and the browser.
 *
 * Self-contained by design: it depends only on `sha256.ts` (dependency-free)
 * and the standard `TextEncoder`, so the whole module bundles into a single
 * offline HTML page and a single-file CLI. It re-implements canonical JSON,
 * the participant leaf format, Merkle verification, commitment recomputation,
 * seed derivation, and winner selection exactly as specified in PROTOCOL.md.
 *
 * This is an independent second implementation of the protocol: the test suite
 * cross-checks it against the `node:crypto`-backed engine, so agreement between
 * the two is itself evidence the spec is unambiguous.
 */
import { sha256, sha256Concat } from "./sha256.js";

const enc = new TextEncoder();
export const PARTICIPANT_LEAF_DOMAIN = "giveaway-participant-v1";

// --- byte / hex helpers -----------------------------------------------------

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`invalid hex: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(n / 0x100000000));
  view.setUint32(4, n >>> 0);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- canonical JSON (RFC 8785 style, pure) ----------------------------------

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

export function canonicalize(value: Json): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
      const obj = value as { [k: string]: Json };
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return (
        "{" +
        keys
          .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]!))
          .join(",") +
        "}"
      );
    default:
      throw new Error(`cannot canonicalize ${typeof value}`);
  }
}

// --- protocol primitives ----------------------------------------------------

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

export function hashLeaf(preimage: Uint8Array): Uint8Array {
  return sha256Concat(LEAF_PREFIX, preimage);
}

export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256Concat(NODE_PREFIX, left, right);
}

export interface FrozenParticipant {
  entry: number;
  username: string;
  source: string;
  source_id: string;
}

export function normalizeUsername(raw: string): string {
  return raw.normalize("NFC").trim().replace(/^@+/, "").toLowerCase();
}

export function participantLeafPreimage(
  giveawayId: string,
  p: FrozenParticipant,
): Uint8Array {
  return utf8(
    canonicalize({
      domain: PARTICIPANT_LEAF_DOMAIN,
      giveaway_id: giveawayId,
      username: p.username,
      source_type: p.source,
      source_id: p.source_id,
    }),
  );
}

export interface ProofStep {
  hash: string;
  position: "left" | "right";
}
export interface MerkleProof {
  leafIndex: number;
  leaf: string;
  path: ProofStep[];
}

/** Rebuild the Merkle root from all leaves (promote odd nodes). */
export function computeMerkleRoot(preimages: Uint8Array[]): string {
  if (preimages.length === 0) throw new Error("no leaves");
  let level = preimages.map(hashLeaf);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = level[i + 1];
      next.push(r === undefined ? l : hashNode(l, r));
    }
    level = next;
  }
  return bytesToHex(level[0]!);
}

/** Verify a single inclusion proof against a committed root. */
export function verifyProof(
  preimage: Uint8Array,
  proof: MerkleProof,
  expectedRoot: string,
): boolean {
  let running = hashLeaf(preimage);
  if (bytesToHex(running) !== proof.leaf) return false;
  for (const step of proof.path) {
    const sib = hexToBytes(step.hash);
    running =
      step.position === "left" ? hashNode(sib, running) : hashNode(running, sib);
  }
  return bytesToHex(running) === expectedRoot;
}

// --- manifest / commitment --------------------------------------------------

export interface GiveawayManifest {
  protocol_version: string;
  giveaway_id: string;
  participant_count: number;
  participant_file_sha256: string;
  participant_merkle_root: string;
  winner_count: number;
  selection: { scheduled_at: string; timezone: string };
  randomness: {
    source: string;
    selection_rule: string;
    block_height: number;
  };
}

export function commitmentHash(manifest: GiveawayManifest): string {
  return bytesToHex(sha256(utf8(canonicalize(manifest as unknown as Json))));
}

export interface ParticipantFile {
  giveaway_id: string;
  participants: FrozenParticipant[];
}

/** Canonical serialization of the participant file (bytes that are hashed). */
export function serializeParticipantFile(pf: ParticipantFile): Uint8Array {
  return utf8(
    canonicalize({
      giveaway_id: pf.giveaway_id,
      participants: pf.participants.map((p) => ({
        entry: p.entry,
        username: p.username,
        source: p.source,
        source_id: p.source_id,
      })),
    }),
  );
}

// --- randomness / winners ---------------------------------------------------

export function deriveSeed(
  commitmentHashHex: string,
  bitcoinBlockHashHex: string,
): Uint8Array {
  return sha256Concat(
    hexToBytes(commitmentHashHex),
    hexToBytes(bitcoinBlockHashHex),
  );
}

class SeededStream {
  private counter = 0;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private offset = 0;
  private view = new DataView(this.buffer.buffer);
  constructor(private readonly seed: Uint8Array) {}
  private refill() {
    this.buffer = sha256Concat(this.seed, u64be(this.counter));
    this.view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    );
    this.counter += 1;
    this.offset = 0;
  }
  private nextUint32(): number {
    if (this.offset + 4 > this.buffer.length) this.refill();
    const v = this.view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }
  nextBelow(n: number): number {
    if (n === 1) return 0;
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const v = this.nextUint32();
      if (v < limit) return v % n;
    }
  }
}

/** Reproduce the winning positions (0-based, selection order). */
export function selectWinnerPositions(
  seed: Uint8Array,
  count: number,
  winnerCount: number,
): number[] {
  if (winnerCount > count) throw new Error("winnerCount exceeds count");
  const stream = new SeededStream(seed);
  const pool = Array.from({ length: count }, (_, i) => i);
  const winners: number[] = [];
  for (let i = 0; i < winnerCount; i++) {
    const j = i + stream.nextBelow(count - i);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
    winners.push(pool[i]!);
  }
  return winners;
}

// --- top-level verification -------------------------------------------------

export interface CheckLine {
  label: string;
  pass: boolean;
  detail?: string;
}

export interface OtsInput {
  bitcoinVerified: boolean;
  timestamp?: number;
  status: string;
}

export interface DrawFileResult {
  seed: string;
  bitcoinBlockHash: string;
  bitcoinBlockHeight: number;
  winnerPositions: number[];
  winners: { entry: number; username: string }[];
}

export interface VerifyInput {
  manifest: GiveawayManifest;
  /** The raw canonical bytes of participants.json as published. */
  participantFileBytes: Uint8Array;
  /** Optional OTS verification result (computed elsewhere). */
  ots?: OtsInput | null;
  /** Optional draw result to reproduce. */
  result?: DrawFileResult | null;
}

export interface VerifyReport {
  ok: boolean;
  checks: CheckLine[];
  commitment: string;
}

function parseParticipantFile(bytes: Uint8Array): ParticipantFile {
  return JSON.parse(new TextDecoder().decode(bytes)) as ParticipantFile;
}

/**
 * Full independent verification of a giveaway. Recomputes the file hash, the
 * Merkle root, the commitment, and (if a draw result is present) re-derives the
 * seed and winners. Every check is returned as a line so a UI can render them.
 */
export function verifyGiveaway(input: VerifyInput): VerifyReport {
  const { manifest, participantFileBytes } = input;
  const pf = parseParticipantFile(participantFileBytes);
  const checks: CheckLine[] = [];
  const add = (label: string, pass: boolean, detail?: string) =>
    checks.push({ label, pass, detail });

  add("giveaway_id matches", pf.giveaway_id === manifest.giveaway_id);
  add(
    "participant_count matches",
    pf.participants.length === manifest.participant_count,
    String(pf.participants.length),
  );

  const fileHash = bytesToHex(sha256(participantFileBytes));
  add(
    "participant_file_sha256 matches",
    fileHash === manifest.participant_file_sha256,
  );

  const canonical = serializeParticipantFile(pf);
  add("participant file is canonical", bytesEqual(canonical, participantFileBytes));

  const root = computeMerkleRoot(
    pf.participants.map((p) => participantLeafPreimage(pf.giveaway_id, p)),
  );
  add("participant_merkle_root matches", root === manifest.participant_merkle_root);

  const commitment = commitmentHash(manifest);

  if (input.ots) {
    if (input.ots.bitcoinVerified) {
      const when = input.ots.timestamp
        ? new Date(input.ots.timestamp * 1000).toISOString()
        : "?";
      add("OpenTimestamps Bitcoin-attested", true, when);
    } else {
      add("OpenTimestamps Bitcoin-attested", false, input.ots.status);
    }
  }

  if (input.result) {
    const r = input.result;
    const seed = bytesToHex(
      deriveSeed(commitment, r.bitcoinBlockHash),
    );
    add("seed reproduces", seed === r.seed, seed);
    const positions = selectWinnerPositions(
      hexToBytes(seed),
      manifest.participant_count,
      manifest.winner_count,
    );
    add(
      "winner selection reproduces",
      JSON.stringify(positions) === JSON.stringify(r.winnerPositions),
    );
    const winnersMatch = positions.every((pos, i) => {
      const p = pf.participants[pos]!;
      return (
        r.winners[i]?.username === p.username && r.winners[i]?.entry === p.entry
      );
    });
    add("winner list matches", winnersMatch);
  }

  return {
    ok: checks.every((c) => c.pass),
    checks,
    commitment,
  };
}

/** Look up a participant and produce their inclusion result (browser-side). */
export interface LookupResult {
  found: boolean;
  participant?: FrozenParticipant;
  proofValid?: boolean;
  merkleRoot: string;
  isWinner?: boolean;
  winnerRank?: number;
}

export function lookupParticipant(
  input: VerifyInput,
  usernameQuery: string,
): LookupResult {
  const pf = parseParticipantFile(input.participantFileBytes);
  const target = normalizeUsername(usernameQuery);
  const idx = pf.participants.findIndex((p) => p.username === target);
  const merkleRoot = input.manifest.participant_merkle_root;
  if (idx === -1) return { found: false, merkleRoot };

  const p = pf.participants[idx]!;
  // Build the proof and re-verify it against the committed root.
  const preimages = pf.participants.map((pp) =>
    participantLeafPreimage(pf.giveaway_id, pp),
  );
  const proof = buildProof(preimages, idx);
  const proofValid = verifyProof(preimages[idx]!, proof, merkleRoot);

  let isWinner = false;
  let winnerRank: number | undefined;
  if (input.result) {
    const rank = input.result.winnerPositions.indexOf(idx);
    if (rank >= 0) {
      isWinner = true;
      winnerRank = rank + 1;
    }
  }
  return { found: true, participant: p, proofValid, merkleRoot, isWinner, winnerRank };
}

/** Build an inclusion proof for a leaf index (odd nodes promoted). */
export function buildProof(preimages: Uint8Array[], leafIndex: number): MerkleProof {
  const levels: Uint8Array[][] = [preimages.map(hashLeaf)];
  while (levels[levels.length - 1]!.length > 1) {
    const cur = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i]!;
      const r = cur[i + 1];
      next.push(r === undefined ? l : hashNode(l, r));
    }
    levels.push(next);
  }
  const path: ProofStep[] = [];
  let index = leafIndex;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level]!;
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    const sib = nodes[siblingIndex];
    if (sib !== undefined) {
      path.push({ hash: bytesToHex(sib), position: isRight ? "left" : "right" });
    }
    index = Math.floor(index / 2);
  }
  return {
    leafIndex,
    leaf: bytesToHex(levels[0]![leafIndex]!),
    path,
  };
}

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GiveawayManifest } from "../protocol/manifest.js";
import type { DrawResult } from "../protocol/randomness.js";

/**
 * On-disk layout of a giveaway working directory. These are exactly the files
 * an organizer publishes so anyone can verify without the server:
 *
 *   manifest.json      – the committed giveaway configuration
 *   participants.json  – canonical frozen participant file (its SHA-256 is committed)
 *   commitment.txt     – SHA-256 of the canonical manifest
 *   giveaway.ots       – OpenTimestamps proof over the commitment (optional)
 *   result.json        – draw output: block, seed, winners (after `draw`)
 */
export const FILES = {
  manifest: "manifest.json",
  participants: "participants.json",
  commitment: "commitment.txt",
  ots: "giveaway.ots",
  result: "result.json",
} as const;

export interface StoredResult extends DrawResult {
  winners: { entry: number; username: string }[];
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeManifest(dir: string, manifest: GiveawayManifest): void {
  writeFileSync(
    join(dir, FILES.manifest),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

export function readManifest(dir: string): GiveawayManifest {
  return JSON.parse(
    readFileSync(join(dir, FILES.manifest), "utf8"),
  ) as GiveawayManifest;
}

export function writeParticipantFile(dir: string, bytes: Buffer): void {
  // Written verbatim so its SHA-256 matches participant_file_sha256.
  writeFileSync(join(dir, FILES.participants), bytes);
}

export function readParticipantFile(dir: string): Buffer {
  return readFileSync(join(dir, FILES.participants));
}

export function writeCommitment(dir: string, hash: string): void {
  writeFileSync(join(dir, FILES.commitment), hash + "\n");
}

export function writeOts(dir: string, bytes: Buffer): void {
  writeFileSync(join(dir, FILES.ots), bytes);
}

export function readOts(dir: string): Buffer | null {
  const p = join(dir, FILES.ots);
  return existsSync(p) ? readFileSync(p) : null;
}

export function writeResult(dir: string, result: StoredResult): void {
  writeFileSync(
    join(dir, FILES.result),
    JSON.stringify(result, null, 2) + "\n",
  );
}

export function readResult(dir: string): StoredResult | null {
  const p = join(dir, FILES.result);
  return existsSync(p)
    ? (JSON.parse(readFileSync(p, "utf8")) as StoredResult)
    : null;
}

/**
 * OpenTimestamps wrapper.
 *
 * We anchor the *commitment hash* (SHA-256 of the canonical manifest) to
 * Bitcoin via OpenTimestamps calendars. The participant data is never sent —
 * only its hash — so this is privacy-preserving.
 *
 * `opentimestamps` is an optional dependency: if it isn't installed the CLI
 * still runs the rest of the protocol and simply reports OTS as unavailable.
 * A `.ots` proof starts out "pending" (backed by calendar servers) and becomes
 * Bitcoin-attested after the calendars' commitment is mined and upgraded.
 */
import { hexToBytes } from "../protocol/hash.js";

// The library ships no types; treat it structurally.
/* eslint-disable @typescript-eslint/no-explicit-any */
type OtsModule = any;

async function loadOts(): Promise<OtsModule | null> {
  try {
    // Indirect specifier + @vite-ignore so bundlers/test runners don't try to
    // statically resolve this optional dependency.
    const pkg = "opentimestamps";
    const mod = await import(/* @vite-ignore */ pkg);
    return (mod as any).default ?? mod;
  } catch {
    return null;
  }
}

export function otsAvailable(): Promise<boolean> {
  return loadOts().then((m) => m !== null);
}

function detachedFromCommitment(ots: OtsModule, commitmentHashHex: string) {
  const { DetachedTimestampFile, Ops } = ots;
  // The commitment IS a SHA-256 digest, so build the detached file directly
  // from that hash under OpSHA256.
  return DetachedTimestampFile.fromHash(
    new Ops.OpSHA256(),
    hexToBytes(commitmentHashHex),
  );
}

/** Create a `.ots` proof for a commitment hash. Returns the serialized bytes. */
export async function stampCommitment(
  commitmentHashHex: string,
): Promise<Buffer> {
  const ots = await loadOts();
  if (!ots) throw new Error("opentimestamps library is not installed");
  const detached = detachedFromCommitment(ots, commitmentHashHex);
  await ots.stamp(detached);
  return Buffer.from(detached.serializeToBytes());
}

/** Attempt to upgrade a pending `.ots` to include Bitcoin attestation. */
export async function upgradeOts(otsBytes: Uint8Array): Promise<Buffer> {
  const ots = await loadOts();
  if (!ots) throw new Error("opentimestamps library is not installed");
  const { DetachedTimestampFile } = ots;
  const detached = DetachedTimestampFile.deserialize(Buffer.from(otsBytes));
  await ots.upgrade(detached);
  return Buffer.from(detached.serializeToBytes());
}

export interface OtsVerifyResult {
  available: boolean;
  /** True if a Bitcoin attestation was found and verified. */
  bitcoinVerified: boolean;
  /** Unix seconds of the earliest Bitcoin attestation, if any. */
  timestamp?: number;
  /** Human-readable status (e.g. "pending", or an error message). */
  status: string;
}

/** Verify a `.ots` proof against a commitment hash. */
export async function verifyOts(
  commitmentHashHex: string,
  otsBytes: Uint8Array,
): Promise<OtsVerifyResult> {
  const ots = await loadOts();
  if (!ots) {
    return {
      available: false,
      bitcoinVerified: false,
      status: "opentimestamps library not installed",
    };
  }
  const { DetachedTimestampFile } = ots;
  const detachedOts = DetachedTimestampFile.deserialize(Buffer.from(otsBytes));
  const detachedOriginal = detachedFromCommitment(ots, commitmentHashHex);
  try {
    const result = await ots.verify(detachedOts, detachedOriginal);
    // result is a map of chain -> { timestamp, height } or empty when pending.
    const bitcoin = result?.bitcoin ?? result?.["bitcoin"];
    if (bitcoin && typeof bitcoin.timestamp === "number") {
      return {
        available: true,
        bitcoinVerified: true,
        timestamp: bitcoin.timestamp,
        status: "bitcoin-attested",
      };
    }
    return {
      available: true,
      bitcoinVerified: false,
      status: "pending (not yet mined; run `upgrade` later)",
    };
  } catch (err) {
    return {
      available: true,
      bitcoinVerified: false,
      status: `verification error: ${(err as Error).message}`,
    };
  }
}

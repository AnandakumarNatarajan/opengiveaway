/**
 * Browser entry point for the self-contained web verifier.
 *
 * Exposes the isomorphic verifier core on `window.OGV`. The HTML page
 * (web/verifier.html) drives the UI and calls these functions; all crypto runs
 * client-side, so the page verifies a giveaway with no server round-trip.
 */
export {
  verifyGiveaway,
  lookupParticipant,
  commitmentHash,
  normalizeUsername,
  bytesToHex,
} from "./core.js";

export type {
  GiveawayManifest,
  DrawFileResult,
  VerifyReport,
  LookupResult,
  VerifyInput,
} from "./core.js";

/** Decode a text string (file contents) into the byte array we hash. */
export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

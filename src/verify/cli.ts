#!/usr/bin/env node
/**
 * Standalone giveaway verifier.
 *
 * Intentionally minimal: it reads a published giveaway directory (or loose
 * files) and re-derives everything with the isomorphic `verify/core`, which
 * has no runtime dependencies. This is the "you don't need the organizer's
 * server" tool — point it at downloaded artifacts and it recomputes the file
 * hash, Merkle root, commitment, and winners from scratch.
 *
 * OpenTimestamps is checked only if the optional `opentimestamps` package is
 * installed; otherwise the OTS line is reported as skipped.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  verifyGiveaway,
  lookupParticipant,
  type GiveawayManifest,
  type DrawFileResult,
  type OtsInput,
} from "./core.js";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  opengiveaway-verify <dir> [--username <name>]",
      "  opengiveaway-verify --manifest <f> --participants <f> [--result <f>] [--username <name>]",
      "",
      "Verifies a published giveaway from its artifacts, with no server and no",
      "network (unless the optional opentimestamps package is installed).",
    ].join("\n"),
  );
  process.exit(2);
}

interface Args {
  dir?: string;
  manifest?: string;
  participants?: string;
  result?: string;
  ots?: string;
  username?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      args.dir = a;
      continue;
    }
    const val = argv[++i];
    if (val === undefined) usage();
    switch (a) {
      case "--manifest": args.manifest = val; break;
      case "--participants": args.participants = val; break;
      case "--result": args.result = val; break;
      case "--ots": args.ots = val; break;
      case "--username": args.username = val; break;
      default: usage();
    }
  }
  return args;
}

async function tryVerifyOts(
  commitmentHash: string,
  otsPath: string,
): Promise<OtsInput | null> {
  try {
    const pkg = "opentimestamps";
    const mod: any = await import(/* @vite-ignore */ pkg).catch(() => null);
    if (!mod) return { bitcoinVerified: false, status: "opentimestamps not installed (skipped)" };
    const ots = mod.default ?? mod;
    const { DetachedTimestampFile, Ops } = ots;
    const otsBytes = readFileSync(otsPath);
    const detachedOts = DetachedTimestampFile.deserialize(otsBytes);
    const detachedOriginal = DetachedTimestampFile.fromHash(
      new Ops.OpSHA256(),
      Buffer.from(commitmentHash, "hex"),
    );
    const res = await ots.verify(detachedOts, detachedOriginal);
    const bitcoin = res?.bitcoin;
    if (bitcoin && typeof bitcoin.timestamp === "number") {
      return { bitcoinVerified: true, timestamp: bitcoin.timestamp, status: "bitcoin-attested" };
    }
    return { bitcoinVerified: false, status: "pending (not yet mined)" };
  } catch (err) {
    return { bitcoinVerified: false, status: `error: ${(err as Error).message}` };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let manifestPath: string, participantsPath: string;
  let resultPath: string | undefined, otsPath: string | undefined;

  if (args.dir) {
    manifestPath = join(args.dir, "manifest.json");
    participantsPath = join(args.dir, "participants.json");
    resultPath = existsSync(join(args.dir, "result.json")) ? join(args.dir, "result.json") : undefined;
    otsPath = existsSync(join(args.dir, "giveaway.ots")) ? join(args.dir, "giveaway.ots") : undefined;
  } else if (args.manifest && args.participants) {
    manifestPath = args.manifest;
    participantsPath = args.participants;
    resultPath = args.result;
    otsPath = args.ots;
  } else {
    usage();
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as GiveawayManifest;
  const participantFileBytes = new Uint8Array(readFileSync(participantsPath));
  const result: DrawFileResult | null = resultPath
    ? (JSON.parse(readFileSync(resultPath, "utf8")) as DrawFileResult)
    : null;

  // Commitment is needed to verify OTS; compute a preliminary report first.
  const pre = verifyGiveaway({ manifest, participantFileBytes, result });
  const ots = otsPath ? await tryVerifyOts(pre.commitment, otsPath) : null;

  const report = verifyGiveaway({ manifest, participantFileBytes, result, ots });

  console.log(`Giveaway: ${manifest.giveaway_id}`);
  console.log(`Commitment: ${report.commitment}\n`);
  for (const c of report.checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.label}${c.detail ? " — " + c.detail : ""}`);
  }

  // OpenTimestamps is advisory (temporal proof), reported separately.
  if (otsPath) {
    const o = report.ots;
    if (!o) {
      console.log(`  ----  OpenTimestamps: could not evaluate`);
    } else if (o.bitcoinVerified) {
      const when = o.timestamp ? new Date(o.timestamp * 1000).toISOString() : "?";
      console.log(`  OTS   OpenTimestamps: Bitcoin-attested at ${when}`);
    } else {
      console.log(`  OTS   OpenTimestamps: ${o.status}`);
    }
  }

  if (args.username) {
    const look = lookupParticipant({ manifest, participantFileBytes, result }, args.username);
    console.log("");
    if (!look.found) {
      console.log(`  Lookup: @${args.username} NOT in the committed set.`);
    } else {
      const p = look.participant!;
      console.log(
        `  Lookup: @${p.username} (entry #${p.entry}) — inclusion proof ${look.proofValid ? "VALID" : "INVALID"}` +
          (look.isWinner ? `, WINNER #${look.winnerRank}` : ""),
      );
    }
  }

  console.log(`\n${report.ok ? "OK — all checks passed." : "FAILED — see above."}`);
  if (!report.ok) process.exitCode = 1;
}

main();

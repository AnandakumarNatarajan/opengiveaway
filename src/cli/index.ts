#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { readCsvParticipants } from "../sources/csv.js";
import {
  buildGiveaway,
  commitmentHash,
  parseParticipantFile,
  serializeParticipantFile,
  type RandomnessSpec,
  type SelectionSpec,
} from "../protocol/manifest.js";
import { sha256Hex } from "../protocol/hash.js";
import { MerkleTree, verifyProof } from "../protocol/merkle.js";
import {
  participantLeafPreimage,
  normalizeUsername,
} from "../protocol/participant.js";
import { drawWinners } from "../protocol/randomness.js";
import { EsploraProvider, StaticProvider } from "../bitcoin/provider.js";
import {
  stampCommitment,
  verifyOts,
  upgradeOts,
  otsAvailable,
} from "../timestamp/ots.js";
import * as store from "./store.js";

const program = new Command();
program
  .name("opengiveaway")
  .description(
    "Self-hostable, cryptographically verifiable giveaway system (CSV source)",
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------
program
  .command("commit")
  .description(
    "Freeze participants from a CSV, build + hash the manifest, and (optionally) OpenTimestamp it",
  )
  .requiredOption("--csv <path>", "CSV file of participants")
  .requiredOption("--giveaway-id <id>", "unique giveaway identifier")
  .requiredOption("--winners <n>", "number of winners", (v) => parseInt(v, 10))
  .requiredOption(
    "--block-height <n>",
    "predetermined Bitcoin block height whose hash provides randomness",
    (v) => parseInt(v, 10),
  )
  .option("--scheduled-at <iso>", "human-facing scheduled draw time (ISO 8601)")
  .option("--timezone <tz>", "IANA timezone", "UTC")
  .option("--username-column <name>", "CSV username column", "username")
  .option("--no-header", "treat CSV as headerless (first column = username)")
  .option("--out <dir>", "output directory", "out")
  .option("--no-ots", "skip OpenTimestamps stamping")
  .action(async (opts) => {
    const raw = readCsvParticipants(opts.csv, {
      usernameColumn: opts.usernameColumn,
      noHeader: opts.header === false,
    });

    const selection: SelectionSpec = {
      scheduled_at: opts.scheduledAt ?? new Date().toISOString(),
      timezone: opts.timezone,
    };
    const randomness: RandomnessSpec = {
      source: "bitcoin",
      selection_rule: "predetermined-block-height",
      block_height: opts.blockHeight,
    };

    const built = buildGiveaway({
      giveawayId: opts.giveawayId,
      participants: raw,
      winnerCount: opts.winners,
      selection,
      randomness,
    });

    store.ensureDir(opts.out);
    store.writeManifest(opts.out, built.manifest);
    store.writeParticipantFile(opts.out, built.participantFileBytes);
    store.writeCommitment(opts.out, built.commitmentHash);

    console.log(`Participants (frozen): ${built.participants.length}`);
    console.log(`Merkle root:  ${built.manifest.participant_merkle_root}`);
    console.log(`File SHA-256: ${built.manifest.participant_file_sha256}`);
    console.log(`Commitment:   ${built.commitmentHash}`);

    if (opts.ots !== false) {
      if (!(await otsAvailable())) {
        console.warn(
          "OpenTimestamps library unavailable; skipping .ots (install `opentimestamps`).",
        );
      } else {
        try {
          const ots = await stampCommitment(built.commitmentHash);
          store.writeOts(opts.out, ots);
          console.log(
            `OpenTimestamps: stamped -> ${opts.out}/${store.FILES.ots} (pending until mined)`,
          );
        } catch (err) {
          console.warn(`OpenTimestamps stamping failed: ${(err as Error).message}`);
        }
      }
    }
    console.log(`\nWrote commitment artifacts to ${opts.out}/`);
  });

// ---------------------------------------------------------------------------
// draw
// ---------------------------------------------------------------------------
program
  .command("draw")
  .description(
    "Fetch the predetermined Bitcoin block hash and deterministically select winners",
  )
  .option("--out <dir>", "giveaway directory", "out")
  .option(
    "--provider <url>",
    "Esplora API base URL",
    "https://mempool.space/api",
  )
  .option(
    "--block-hash <hex>",
    "supply the block hash directly (offline / reproducibility)",
  )
  .action(async (opts) => {
    const manifest = store.readManifest(opts.out);
    const commitment = commitmentHash(manifest);
    const height = manifest.randomness.block_height;

    let blockHash: string;
    if (opts.blockHash) {
      blockHash = opts.blockHash.toLowerCase();
    } else {
      const provider = new EsploraProvider(opts.provider);
      blockHash = await provider.getBlockHash(height);
    }

    const result = drawWinners({
      commitmentHash: commitment,
      bitcoinBlockHeight: height,
      bitcoinBlockHash: blockHash,
      participantCount: manifest.participant_count,
      winnerCount: manifest.winner_count,
    });

    const { participants } = parseParticipantFile(
      store.readParticipantFile(opts.out),
    );
    const winners = result.winnerPositions.map((pos) => {
      const p = participants[pos]!;
      return { entry: p.entry, username: p.username };
    });

    store.writeResult(opts.out, { ...result, winners });

    console.log(`Bitcoin block #${height}`);
    console.log(`Block hash: ${blockHash}`);
    console.log(`Seed:       ${result.seed}`);
    console.log(`\nWinners:`);
    winners.forEach((w, i) =>
      console.log(`  ${i + 1}. @${w.username} (entry #${w.entry})`),
    );
  });

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------
program
  .command("verify")
  .description(
    "Independently re-verify a giveaway directory: file hash, Merkle root, commitment, OTS, and (if drawn) the winners",
  )
  .option("--out <dir>", "giveaway directory", "out")
  .action(async (opts) => {
    const manifest = store.readManifest(opts.out);
    const fileBytes = store.readParticipantFile(opts.out);
    const { giveawayId, participants } = parseParticipantFile(fileBytes);

    let ok = true;
    const check = (label: string, pass: boolean, detail = "") => {
      ok = ok && pass;
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
    };

    console.log("Commitment integrity:");
    check("giveaway_id matches", giveawayId === manifest.giveaway_id);
    check(
      "participant_count matches",
      participants.length === manifest.participant_count,
      `${participants.length}`,
    );
    const fileHash = sha256Hex(fileBytes);
    check(
      "participant_file_sha256 matches",
      fileHash === manifest.participant_file_sha256,
    );
    const tree = new MerkleTree(
      participants.map((p) => participantLeafPreimage(giveawayId, p)),
    );
    check(
      "participant_merkle_root matches",
      tree.root === manifest.participant_merkle_root,
    );
    // Recompute file bytes from parsed participants to ensure canonical form.
    const recomputed = serializeParticipantFile(giveawayId, participants);
    check(
      "participant file is canonical",
      recomputed.equals(fileBytes),
    );

    console.log("\nOpenTimestamps:");
    const ots = store.readOts(opts.out);
    if (!ots) {
      console.log("  SKIP  no giveaway.ots present");
    } else {
      const res = await verifyOts(commitmentHash(manifest), ots);
      if (!res.available) {
        console.log(`  SKIP  ${res.status}`);
      } else if (res.bitcoinVerified) {
        const when = res.timestamp
          ? new Date(res.timestamp * 1000).toISOString()
          : "?";
        check("Bitcoin-attested commitment", true, `at ${when}`);
      } else {
        console.log(`  WARN  ${res.status}`);
      }
    }

    const result = store.readResult(opts.out);
    if (result) {
      console.log("\nDraw reproducibility:");
      const redraw = drawWinners({
        commitmentHash: commitmentHash(manifest),
        bitcoinBlockHeight: manifest.randomness.block_height,
        bitcoinBlockHash: result.bitcoinBlockHash,
        participantCount: manifest.participant_count,
        winnerCount: manifest.winner_count,
      });
      check("seed reproduces", redraw.seed === result.seed);
      const positionsMatch =
        JSON.stringify(redraw.winnerPositions) ===
        JSON.stringify(result.winnerPositions);
      check("winner selection reproduces", positionsMatch);
      const winnersMatch = redraw.winnerPositions.every((pos, i) => {
        const p = participants[pos]!;
        return (
          result.winners[i]?.username === p.username &&
          result.winners[i]?.entry === p.entry
        );
      });
      check("winner list matches", winnersMatch);
    }

    console.log(`\n${ok ? "OK — all checks passed." : "FAILED — see above."}`);
    if (!ok) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// prove — produce a Merkle inclusion proof for one username
// ---------------------------------------------------------------------------
program
  .command("prove")
  .description("Produce a Merkle inclusion proof for a participant")
  .requiredOption("--username <name>", "participant username")
  .option("--out <dir>", "giveaway directory", "out")
  .option("--json <path>", "write proof JSON to this file")
  .action((opts) => {
    const manifest = store.readManifest(opts.out);
    const { giveawayId, participants } = parseParticipantFile(
      store.readParticipantFile(opts.out),
    );
    const target = normalizeUsername(opts.username);
    const idx = participants.findIndex((p) => p.username === target);
    if (idx === -1) {
      console.error(`Participant @${target} not found.`);
      process.exitCode = 1;
      return;
    }
    const p = participants[idx]!;
    const tree = new MerkleTree(
      participants.map((pp) => participantLeafPreimage(giveawayId, pp)),
    );
    const proof = tree.proof(idx);
    const bundle = {
      giveaway_id: giveawayId,
      username: p.username,
      entry: p.entry,
      source: p.source,
      source_id: p.source_id,
      merkle_root: manifest.participant_merkle_root,
      proof,
    };
    if (opts.json) {
      writeFileSync(opts.json, JSON.stringify(bundle, null, 2) + "\n");
      console.log(`Wrote proof to ${opts.json}`);
    } else {
      console.log(JSON.stringify(bundle, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// check-proof — verify a single inclusion proof offline
// ---------------------------------------------------------------------------
program
  .command("check-proof")
  .description("Verify a Merkle inclusion proof produced by `prove`")
  .requiredOption("--proof <path>", "proof JSON file")
  .action(async (opts) => {
    const { readFileSync } = await import("node:fs");
    const bundle = JSON.parse(readFileSync(opts.proof, "utf8"));
    const preimage = participantLeafPreimage(bundle.giveaway_id, {
      username: bundle.username,
      source: bundle.source,
      source_id: bundle.source_id,
      entry: bundle.entry,
    });
    const valid = verifyProof(preimage, bundle.proof, bundle.merkle_root);
    console.log(
      valid
        ? `PASS — @${bundle.username} (entry #${bundle.entry}) is in the committed set.`
        : `FAIL — proof does not verify.`,
    );
    if (!valid) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// upgrade — refresh a pending OTS proof with Bitcoin attestation
// ---------------------------------------------------------------------------
program
  .command("upgrade")
  .description("Upgrade a pending giveaway.ots once its commitment is mined")
  .option("--out <dir>", "giveaway directory", "out")
  .action(async (opts) => {
    const ots = store.readOts(opts.out);
    if (!ots) {
      console.error("No giveaway.ots present.");
      process.exitCode = 1;
      return;
    }
    try {
      const upgraded = await upgradeOts(ots);
      store.writeOts(opts.out, upgraded);
      console.log("Upgraded giveaway.ots (verify to see attestation status).");
    } catch (err) {
      console.error(`Upgrade failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);

/**
 * Self-hosted giveaway server: organizer Web UI + JSON API + public artifacts.
 *
 * This is the HTTP layer only — every cryptographic operation is delegated to
 * the UI-independent protocol engine (src/protocol) and the on-disk store
 * (src/cli/store), so the server holds no protocol logic of its own. Each
 * giveaway lives in <dataDir>/<giveawayId>/ with exactly the published-artifact
 * layout, which is also what the verifier and CLI consume.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGiveaway,
  commitmentHash,
  parseParticipantFile,
  type RandomnessSpec,
  type SelectionSpec,
} from "../protocol/manifest.js";
import { drawWinners } from "../protocol/randomness.js";
import { parseCsvParticipants } from "../sources/csv.js";
import { EsploraProvider } from "../bitcoin/provider.js";
import { stampCommitment, otsAvailable } from "../timestamp/ots.js";
import * as store from "../cli/store.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../web");
const ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

interface AppOptions {
  dataDir: string;
  providerUrl?: string;
}

// --- tiny helpers -----------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendFile(res: ServerResponse, path: string, type: string): void {
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(path));
}

function readBody(req: IncomingMessage, limitBytes = 25 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// --- domain operations ------------------------------------------------------

function giveawayDir(dataDir: string, id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, "invalid giveaway id");
  return join(dataDir, id);
}

function summarize(dataDir: string, id: string) {
  const dir = giveawayDir(dataDir, id);
  const manifest = store.readManifest(dir);
  const result = store.readResult(dir);
  return {
    giveaway_id: manifest.giveaway_id,
    participant_count: manifest.participant_count,
    winner_count: manifest.winner_count,
    block_height: manifest.randomness.block_height,
    scheduled_at: manifest.selection.scheduled_at,
    timezone: manifest.selection.timezone,
    commitment: commitmentHash(manifest),
    has_ots: existsSync(join(dir, store.FILES.ots)),
    drawn: result !== null,
    winners: result?.winners ?? null,
  };
}

function listGiveaways(dataDir: string) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((name) => {
      if (!ID_RE.test(name)) return false;
      const p = join(dataDir, name);
      return statSync(p).isDirectory() && existsSync(join(p, store.FILES.manifest));
    })
    .map((id) => {
      try {
        return summarize(dataDir, id);
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

interface CreateBody {
  giveaway_id: string;
  csv: string;
  winner_count: number;
  block_height: number;
  scheduled_at?: string;
  timezone?: string;
  username_column?: string;
  no_header?: boolean;
  ots?: boolean;
}

async function createGiveaway(opts: AppOptions, body: CreateBody) {
  const id = body.giveaway_id?.trim();
  if (!id || !ID_RE.test(id)) {
    throw new HttpError(400, "giveaway_id must match [A-Za-z0-9._-] (1-64 chars)");
  }
  const dir = join(opts.dataDir, id);
  if (existsSync(dir)) throw new HttpError(409, `giveaway "${id}" already exists`);
  if (!body.csv || !body.csv.trim()) throw new HttpError(400, "csv is required");
  if (!Number.isInteger(body.winner_count) || body.winner_count < 1) {
    throw new HttpError(400, "winner_count must be a positive integer");
  }
  if (!Number.isInteger(body.block_height) || body.block_height < 1) {
    throw new HttpError(400, "block_height must be a positive integer");
  }

  let raw;
  try {
    raw = parseCsvParticipants(body.csv, {
      usernameColumn: body.username_column ?? "username",
      noHeader: body.no_header ?? false,
    });
  } catch (e) {
    throw new HttpError(400, `CSV parse error: ${(e as Error).message}`);
  }

  const selection: SelectionSpec = {
    scheduled_at: body.scheduled_at?.trim() || new Date().toISOString(),
    timezone: body.timezone?.trim() || "UTC",
  };
  const randomness: RandomnessSpec = {
    source: "bitcoin",
    selection_rule: "predetermined-block-height",
    block_height: body.block_height,
  };

  let built;
  try {
    built = buildGiveaway({
      giveawayId: id,
      participants: raw,
      winnerCount: body.winner_count,
      selection,
      randomness,
    });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }

  store.ensureDir(dir);
  store.writeManifest(dir, built.manifest);
  store.writeParticipantFile(dir, built.participantFileBytes);
  store.writeCommitment(dir, built.commitmentHash);

  let ots = false;
  if (body.ots && (await otsAvailable())) {
    try {
      store.writeOts(dir, await stampCommitment(built.commitmentHash));
      ots = true;
    } catch {
      ots = false;
    }
  }

  return { ...summarize(opts.dataDir, id), ots_stamped: ots };
}

async function drawGiveaway(
  opts: AppOptions,
  id: string,
  body: { block_hash?: string; force?: boolean },
) {
  const dir = giveawayDir(opts.dataDir, id);
  if (!existsSync(join(dir, store.FILES.manifest))) {
    throw new HttpError(404, `giveaway "${id}" not found`);
  }
  const manifest = store.readManifest(dir);
  if (store.readResult(dir) && !body.force) {
    throw new HttpError(409, "giveaway already drawn");
  }
  const height = manifest.randomness.block_height;

  let blockHash: string;
  if (body.block_hash) {
    if (!/^[0-9a-f]{64}$/i.test(body.block_hash.trim())) {
      throw new HttpError(400, "block_hash must be 64 hex chars");
    }
    blockHash = body.block_hash.trim().toLowerCase();
  } else {
    try {
      blockHash = await new EsploraProvider(opts.providerUrl).getBlockHash(height);
    } catch (e) {
      throw new HttpError(
        502,
        `could not fetch block ${height}: ${(e as Error).message}. Provide block_hash manually.`,
      );
    }
  }

  const result = drawWinners({
    commitmentHash: commitmentHash(manifest),
    bitcoinBlockHeight: height,
    bitcoinBlockHash: blockHash,
    participantCount: manifest.participant_count,
    winnerCount: manifest.winner_count,
  });
  const { participants } = parseParticipantFile(store.readParticipantFile(dir));
  const winners = result.winnerPositions.map((pos) => {
    const p = participants[pos]!;
    return { entry: p.entry, username: p.username };
  });
  store.writeResult(dir, { ...result, winners });
  return summarize(opts.dataDir, id);
}

// --- static artifact serving ------------------------------------------------

const ARTIFACTS: Record<string, string> = {
  "manifest.json": "application/json",
  "participants.json": "application/json",
  "result.json": "application/json",
  "commitment.txt": "text/plain; charset=utf-8",
  "giveaway.ots": "application/octet-stream",
};

function serveArtifact(opts: AppOptions, id: string, file: string, res: ServerResponse): void {
  const type = ARTIFACTS[file];
  if (!type) throw new HttpError(404, "not found");
  const path = join(giveawayDir(opts.dataDir, id), file);
  if (!existsSync(path)) throw new HttpError(404, "not found");
  sendFile(res, path, type);
}

// --- router -----------------------------------------------------------------

export function createApp(opts: AppOptions): Server {
  return createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // pages
      if (method === "GET" && (path === "/" || path === "/index.html")) {
        return sendFile(res, join(WEB_DIR, "app.html"), "text/html; charset=utf-8");
      }
      if (method === "GET" && (path === "/verify" || path === "/verifier.html")) {
        return sendFile(res, join(WEB_DIR, "verifier.html"), "text/html; charset=utf-8");
      }

      // API
      if (path === "/api/giveaways" && method === "GET") {
        return sendJson(res, 200, { giveaways: listGiveaways(opts.dataDir) });
      }
      if (path === "/api/giveaways" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as CreateBody;
        return sendJson(res, 201, await createGiveaway(opts, body));
      }
      const detail = path.match(/^\/api\/giveaways\/([^/]+)$/);
      if (detail && method === "GET") {
        const id = decodeURIComponent(detail[1]!);
        if (!existsSync(join(giveawayDir(opts.dataDir, id), store.FILES.manifest))) {
          throw new HttpError(404, "not found");
        }
        return sendJson(res, 200, summarize(opts.dataDir, id));
      }
      const draw = path.match(/^\/api\/giveaways\/([^/]+)\/draw$/);
      if (draw && method === "POST") {
        const id = decodeURIComponent(draw[1]!);
        const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
        return sendJson(res, 200, await drawGiveaway(opts, id, body));
      }

      // public artifacts: /g/<id>/<file>
      const art = path.match(/^\/g\/([^/]+)\/([^/]+)$/);
      if (art && method === "GET") {
        return serveArtifact(opts, decodeURIComponent(art[1]!), art[2]!, res);
      }

      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      return sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

export function startApp(opts: AppOptions & { port: number }): Server {
  const server = createApp(opts);
  server.listen(opts.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `OpenGiveaway server on http://localhost:${opts.port}  (data: ${opts.dataDir})`,
    );
  });
  return server;
}

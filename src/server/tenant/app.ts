/**
 * Multi-tenant OpenGiveaway server (the `host` command).
 *
 * HTTP + orchestration only. All cryptography is delegated to the unchanged
 * protocol/verify engines; identity, data and artifact storage are delegated to
 * Supabase. Tenant isolation is enforced by Postgres RLS: every request runs
 * through a user-scoped Supabase client (the caller's JWT), never service-role.
 *
 * Public verification stays trustless — artifacts live in a public Storage
 * bucket and are streamed through `/g/<space>/<gid>/<file>` with no auth.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGiveaway,
  commitmentHash,
  parseParticipantFile,
  type RandomnessSpec,
  type SelectionSpec,
} from "../../protocol/manifest.js";
import { drawWinners } from "../../protocol/randomness.js";
import { parseCsvParticipants } from "../../sources/csv.js";
import { EsploraProvider } from "../../bitcoin/provider.js";
import {
  stampCommitment,
  otsAvailable,
  verifyOts,
  upgradeOts,
  guardOtsNetworkErrors,
} from "../../timestamp/ots.js";
import { bearerToken } from "./auth.js";
import { makeSupabaseFactory, type ClientFactory, type SupabaseLike } from "./supabase.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../web");
const BUCKET = "giveaways";
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const ARTIFACT_TYPES: Record<string, string> = {
  "manifest.json": "application/json",
  "participants.json": "application/json",
  "result.json": "application/json",
  "giveaway.ots": "application/octet-stream",
};

export interface TenantAppOptions {
  supabaseUrl: string;
  anonKey: string;
  providerUrl?: string;
  /** Injectable for tests; defaults to a real supabase-js factory. */
  clientFactory?: ClientFactory;
  /** Injectable public-artifact reader for tests; defaults to fetching the public Storage URL. */
  readArtifact?: (slug: string, gid: string, file: string) => Promise<Buffer | null>;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// --- helpers ----------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, path: string, type: string): void {
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(path));
}

function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function requireToken(req: IncomingMessage): string {
  const t = bearerToken(req);
  if (!t) throw new HttpError(401, "authentication required");
  return t;
}

// --- domain -----------------------------------------------------------------

interface GiveawayRow {
  space_id: string;
  space_slug: string;
  giveaway_id: string;
  commitment: string;
  participant_count: number;
  winner_count: number;
  participant_file_sha256: string;
  participant_merkle_root: string;
  block_height: number;
  scheduled_at: string | null;
  timezone: string | null;
  has_ots: boolean;
  drawn: boolean;
  seed: string | null;
  bitcoin_block_hash: string | null;
  winners: { entry: number; username: string }[] | null;
}

function summary(row: GiveawayRow) {
  return {
    giveaway_id: row.giveaway_id,
    space_slug: row.space_slug,
    participant_count: row.participant_count,
    winner_count: row.winner_count,
    block_height: row.block_height,
    scheduled_at: row.scheduled_at,
    timezone: row.timezone,
    commitment: row.commitment,
    has_ots: row.has_ots,
    drawn: row.drawn,
    winners: row.winners,
  };
}

class TenantServer {
  private readonly factory: ClientFactory;
  private readonly providerUrl: string;
  constructor(private readonly opts: TenantAppOptions) {
    this.factory =
      opts.clientFactory ?? makeSupabaseFactory(opts.supabaseUrl, opts.anonKey);
    this.providerUrl = opts.providerUrl ?? "https://mempool.space/api";
  }

  private objectPath(slug: string, gid: string, file: string): string {
    return `${slug}/${gid}/${file}`;
  }
  private publicUrl(slug: string, gid: string, file: string): string {
    return `${this.opts.supabaseUrl}/storage/v1/object/public/${BUCKET}/${this.objectPath(slug, gid, file)}`;
  }

  private async upload(
    client: SupabaseLike,
    slug: string,
    gid: string,
    file: string,
    body: Buffer | string,
    contentType: string,
  ): Promise<void> {
    const { error } = await client.storage
      .from(BUCKET)
      .upload(this.objectPath(slug, gid, file), body, { contentType, upsert: true });
    if (error) throw new HttpError(502, `storage upload failed (${file}): ${error.message}`);
  }

  private async fetchArtifact(slug: string, gid: string, file: string): Promise<Buffer | null> {
    if (this.opts.readArtifact) return this.opts.readArtifact(slug, gid, file);
    const r = await fetch(this.publicUrl(slug, gid, file));
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }

  async createGiveaway(token: string, spaceId: string, body: any): Promise<GiveawayRow> {
    const gid = String(body.giveaway_id ?? "").trim();
    if (!ID_RE.test(gid)) throw new HttpError(400, "giveaway_id must match [A-Za-z0-9._-] (1-64 chars)");
    if (!body.csv || !String(body.csv).trim()) throw new HttpError(400, "csv is required");
    if (!Number.isInteger(body.winner_count) || body.winner_count < 1)
      throw new HttpError(400, "winner_count must be a positive integer");
    if (!Number.isInteger(body.block_height) || body.block_height < 1)
      throw new HttpError(400, "block_height must be a positive integer");

    const client = this.factory(token);

    // Resolve the space slug (RLS lets only members read the space).
    const space = await client.from("spaces").select("slug").eq("id", spaceId).maybeSingle();
    if (space.error) throw new HttpError(500, space.error.message);
    if (!space.data) throw new HttpError(403, "space not found or access denied");
    const slug: string = space.data.slug;

    let raw;
    try {
      raw = parseCsvParticipants(String(body.csv));
    } catch (e) {
      throw new HttpError(400, `CSV parse error: ${(e as Error).message}`);
    }

    const selection: SelectionSpec = {
      scheduled_at: (body.scheduled_at && String(body.scheduled_at)) || new Date().toISOString(),
      timezone: (body.timezone && String(body.timezone)) || "UTC",
    };
    const randomness: RandomnessSpec = {
      source: "bitcoin",
      selection_rule: "predetermined-block-height",
      block_height: body.block_height,
    };

    let built;
    try {
      built = buildGiveaway({ giveawayId: gid, participants: raw, winnerCount: body.winner_count, selection, randomness });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }

    // Insert the row first (unique + RLS membership check), then upload artifacts.
    const insert = await client
      .from("giveaways")
      .insert({
        space_id: spaceId,
        space_slug: slug,
        giveaway_id: gid,
        commitment: built.commitmentHash,
        participant_count: built.manifest.participant_count,
        participant_file_sha256: built.manifest.participant_file_sha256,
        participant_merkle_root: built.manifest.participant_merkle_root,
        winner_count: built.manifest.winner_count,
        block_height: built.manifest.randomness.block_height,
        scheduled_at: selection.scheduled_at,
        timezone: selection.timezone,
      })
      .select()
      .single();
    if (insert.error) {
      const msg = insert.error.message || "insert failed";
      if (/duplicate|unique/i.test(msg)) throw new HttpError(409, `giveaway "${gid}" already exists in this space`);
      if (/row-level security|policy/i.test(msg)) throw new HttpError(403, "not a member of this space");
      throw new HttpError(400, msg);
    }

    try {
      await this.upload(client, slug, gid, "manifest.json", JSON.stringify(built.manifest, null, 2), "application/json");
      await this.upload(client, slug, gid, "participants.json", built.participantFileBytes, "application/json");
      let hasOts = false;
      if (body.ots && (await otsAvailable())) {
        try {
          await this.upload(client, slug, gid, "giveaway.ots", await stampCommitment(built.commitmentHash), "application/octet-stream");
          hasOts = true;
        } catch {
          hasOts = false;
        }
      }
      if (hasOts) {
        await client.from("giveaways").update({ has_ots: true }).eq("space_id", spaceId).eq("giveaway_id", gid);
      }
    } catch (e) {
      // Roll back the row so a failed upload doesn't strand metadata.
      await client.from("giveaways").delete().eq("space_id", spaceId).eq("giveaway_id", gid);
      throw e;
    }

    return { ...(insert.data as GiveawayRow), has_ots: (insert.data as GiveawayRow).has_ots || false };
  }

  private async loadRow(client: SupabaseLike, spaceId: string, gid: string): Promise<GiveawayRow> {
    const r = await client.from("giveaways").select("*").eq("space_id", spaceId).eq("giveaway_id", gid).maybeSingle();
    if (r.error) throw new HttpError(500, r.error.message);
    if (!r.data) throw new HttpError(404, "giveaway not found or access denied");
    return r.data as GiveawayRow;
  }

  async drawGiveaway(token: string, spaceId: string, gid: string, body: any): Promise<GiveawayRow> {
    const client = this.factory(token);
    const row = await this.loadRow(client, spaceId, gid);
    if (row.drawn && !body.force) throw new HttpError(409, "giveaway already drawn");

    let blockHash: string;
    if (body.block_hash) {
      if (!/^[0-9a-f]{64}$/i.test(String(body.block_hash).trim()))
        throw new HttpError(400, "block_hash must be 64 hex chars");
      blockHash = String(body.block_hash).trim().toLowerCase();
    } else {
      try {
        blockHash = await new EsploraProvider(this.providerUrl).getBlockHash(row.block_height);
      } catch (e) {
        throw new HttpError(502, `could not fetch block ${row.block_height}: ${(e as Error).message}. Provide block_hash manually.`);
      }
    }

    const result = drawWinners({
      commitmentHash: row.commitment,
      bitcoinBlockHeight: row.block_height,
      bitcoinBlockHash: blockHash,
      participantCount: row.participant_count,
      winnerCount: row.winner_count,
    });

    const pfBytes = await this.fetchArtifact(row.space_slug, gid, "participants.json");
    if (!pfBytes) throw new HttpError(500, "participant file missing from storage");
    const { participants } = parseParticipantFile(pfBytes);
    const winners = result.winnerPositions.map((pos) => {
      const p = participants[pos]!;
      return { entry: p.entry, username: p.username };
    });

    await this.upload(client, row.space_slug, gid, "result.json", JSON.stringify({ ...result, winners }, null, 2), "application/json");

    const upd = await client
      .from("giveaways")
      .update({ drawn: true, seed: result.seed, bitcoin_block_hash: blockHash, winners, drawn_at: new Date().toISOString() })
      .eq("space_id", spaceId)
      .eq("giveaway_id", gid)
      .select()
      .single();
    if (upd.error) throw new HttpError(400, upd.error.message);
    return upd.data as GiveawayRow;
  }

  async otsStatus(token: string, spaceId: string, gid: string) {
    const client = this.factory(token);
    const row = await this.loadRow(client, spaceId, gid);
    if (!row.has_ots) return { state: "absent", status: "no OpenTimestamps proof" };
    const bytes = await this.fetchArtifact(row.space_slug, gid, "giveaway.ots");
    if (!bytes) return { state: "absent", status: "proof missing from storage" };
    const res = await verifyOts(row.commitment, bytes);
    if (!res.available) return { state: "unavailable", status: res.status };
    if (res.bitcoinVerified) return { state: "attested", timestamp: res.timestamp, status: res.status };
    return { state: /pending/i.test(res.status) ? "pending" : "present", status: res.status };
  }

  async otsUpgrade(token: string, spaceId: string, gid: string) {
    const client = this.factory(token);
    const row = await this.loadRow(client, spaceId, gid);
    if (!row.has_ots) throw new HttpError(404, "no OpenTimestamps proof to upgrade");
    const bytes = await this.fetchArtifact(row.space_slug, gid, "giveaway.ots");
    if (!bytes) throw new HttpError(404, "proof missing from storage");
    let upgraded: Buffer;
    try {
      upgraded = await upgradeOts(bytes);
    } catch (e) {
      throw new HttpError(502, `upgrade failed: ${(e as Error).message}`);
    }
    await this.upload(client, row.space_slug, gid, "giveaway.ots", upgraded, "application/octet-stream");
    return this.otsStatus(token, spaceId, gid);
  }

  async publicOtsStatus(slug: string, gid: string) {
    if (!SLUG_RE.test(slug) || !ID_RE.test(gid)) throw new HttpError(404, "not found");
    const otsBytes = await this.fetchArtifact(slug, gid, "giveaway.ots");
    if (!otsBytes) return { state: "absent", status: "no OpenTimestamps proof" };
    const manifestBytes = await this.fetchArtifact(slug, gid, "manifest.json");
    if (!manifestBytes) return { state: "absent", status: "manifest missing" };
    const commitment = commitmentHash(JSON.parse(manifestBytes.toString("utf8")));
    const res = await verifyOts(commitment, otsBytes);
    if (!res.available) return { state: "unavailable", status: res.status };
    if (res.bitcoinVerified) return { state: "attested", timestamp: res.timestamp, status: res.status };
    return { state: /pending/i.test(res.status) ? "pending" : "present", status: res.status };
  }

  async servePublicArtifact(slug: string, gid: string, file: string, res: ServerResponse): Promise<void> {
    const type = ARTIFACT_TYPES[file];
    if (!type || !SLUG_RE.test(slug) || !ID_RE.test(gid)) throw new HttpError(404, "not found");
    const bytes = await this.fetchArtifact(slug, gid, file);
    if (!bytes) throw new HttpError(404, "not found");
    res.writeHead(200, { "content-type": type });
    res.end(bytes);
  }
}

// --- router -----------------------------------------------------------------

export function createTenantApp(opts: TenantAppOptions): Server {
  const app = new TenantServer(opts);
  const configJs =
    `window.OG_CONFIG = ${JSON.stringify({ SUPABASE_URL: opts.supabaseUrl, SUPABASE_ANON_KEY: opts.anonKey })};\n`;

  return createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (method === "GET" && (path === "/" || path === "/index.html"))
        return sendFile(res, join(WEB_DIR, "app.html"), "text/html; charset=utf-8");
      if (method === "GET" && (path === "/verify" || path === "/verifier.html"))
        return sendFile(res, join(WEB_DIR, "verifier.html"), "text/html; charset=utf-8");
      if (method === "GET" && path === "/config.js") {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        return res.end(configJs);
      }
      if (method === "GET" && path === "/vendor/supabase.js") {
        const p = join(WEB_DIR, "vendor", "supabase.js");
        if (!existsSync(p)) throw new HttpError(500, "vendor/supabase.js missing — run `npm run build:web`");
        return sendFile(res, p, "application/javascript; charset=utf-8");
      }
      if (method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });

      let m: RegExpMatchArray | null;
      if ((m = path.match(/^\/api\/spaces\/([^/]+)\/giveaways$/)) && method === "POST") {
        const body = JSON.parse(await readBody(req));
        return sendJson(res, 201, summary(await app.createGiveaway(requireToken(req), decodeURIComponent(m[1]!), body)));
      }
      if ((m = path.match(/^\/api\/spaces\/([^/]+)\/giveaways\/([^/]+)\/draw$/)) && method === "POST") {
        const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
        return sendJson(res, 200, summary(await app.drawGiveaway(requireToken(req), decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), body)));
      }
      if ((m = path.match(/^\/api\/spaces\/([^/]+)\/giveaways\/([^/]+)\/ots$/)) && method === "GET") {
        return sendJson(res, 200, await app.otsStatus(requireToken(req), decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      }
      if ((m = path.match(/^\/api\/spaces\/([^/]+)\/giveaways\/([^/]+)\/ots\/upgrade$/)) && method === "POST") {
        return sendJson(res, 200, await app.otsUpgrade(requireToken(req), decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      }
      if ((m = path.match(/^\/g\/([^/]+)\/([^/]+)\/ots$/)) && method === "GET") {
        return sendJson(res, 200, await app.publicOtsStatus(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      }
      if ((m = path.match(/^\/g\/([^/]+)\/([^/]+)\/([^/]+)$/)) && method === "GET") {
        return await app.servePublicArtifact(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), m[3]!, res);
      }

      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      return sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

export function startTenantApp(opts: TenantAppOptions & { port: number }): Server {
  guardOtsNetworkErrors();
  const server = createTenantApp(opts);
  server.listen(opts.port, () => {
    // eslint-disable-next-line no-console
    console.log(`OpenGiveaway (multi-tenant) on http://localhost:${opts.port}  → ${opts.supabaseUrl}`);
  });
  return server;
}

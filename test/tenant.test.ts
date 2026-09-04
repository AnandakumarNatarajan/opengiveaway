import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createTenantApp } from "../src/server/tenant/app.js";
import { verifyGiveaway } from "../src/verify/core.js";

/**
 * In-memory fake of the tiny supabase-js surface the tenant server uses, with
 * RLS-like membership enforcement keyed by the caller's token. Lets us test the
 * server's routing/auth/validation and a full create→draw→verify round-trip
 * without a live Supabase.
 */
class Store {
  spaces = new Map<string, { id: string; slug: string; name: string }>();
  members = new Map<string, Set<string>>(); // token -> spaceIds
  giveaways = new Map<string, any>(); // `${spaceId}/${gid}` -> row
  objects = new Map<string, Buffer>(); // `${slug}/${gid}/${file}` -> bytes

  isMember(token: string | undefined, spaceId: string) {
    return !!token && (this.members.get(token)?.has(spaceId) ?? false);
  }
  slugMember(token: string | undefined, slug: string) {
    const space = [...this.spaces.values()].find((s) => s.slug === slug);
    return !!space && this.isMember(token, space.id);
  }
}

function toBuffer(body: any): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(body);
}

class QB {
  private action: string | null = null;
  private vals: any = null;
  private filters: Record<string, any> = {};
  private single_ = false;
  constructor(private store: Store, private token: string | undefined, private table: string) {}
  insert(v: any) { this.action = "insert"; this.vals = v; return this; }
  update(v: any) { this.action = "update"; this.vals = v; return this; }
  delete() { this.action = "delete"; return this; }
  select(_c?: string) { if (!this.action) this.action = "select"; return this; }
  eq(c: string, v: any) { this.filters[c] = v; return this; }
  order() { return this; }
  single() { this.single_ = true; return this as any; }
  maybeSingle() { this.single_ = true; return this as any; }
  then(res: (v: any) => any, rej?: (e: any) => any) { return this.run().then(res, rej); }
  private async run(): Promise<any> {
    const s = this.store;
    if (this.table === "spaces") {
      const sp = s.spaces.get(this.filters.id);
      if (sp && s.isMember(this.token, sp.id)) return { data: sp, error: null };
      return { data: null, error: null };
    }
    // giveaways
    const key = `${this.filters.space_id}/${this.filters.giveaway_id}`;
    if (this.action === "insert") {
      if (!s.isMember(this.token, this.vals.space_id))
        return { data: null, error: { message: "new row violates row-level security policy" } };
      const k = `${this.vals.space_id}/${this.vals.giveaway_id}`;
      if (s.giveaways.has(k)) return { data: null, error: { message: "duplicate key value" } };
      const row = { has_ots: false, drawn: false, winners: null, ...this.vals };
      s.giveaways.set(k, row);
      return { data: row, error: null };
    }
    if (this.action === "update") {
      const row = s.giveaways.get(key);
      if (!row) return { data: null, error: null };
      Object.assign(row, this.vals);
      return { data: row, error: null };
    }
    if (this.action === "delete") { s.giveaways.delete(key); return { data: null, error: null }; }
    // select
    const row = s.giveaways.get(key) ?? null;
    return { data: row, error: null };
  }
}

function fakeFactory(store: Store) {
  return (token?: string) => ({
    from: (table: string) => new QB(store, token, table),
    storage: {
      from: (_bucket: string) => ({
        upload: async (path: string, body: any, _opts: any) => {
          const slug = path.split("/")[0]!;
          if (!store.slugMember(token, slug))
            return { data: null, error: { message: "row-level security" } };
          store.objects.set(path, toBuffer(body));
          return { data: { path }, error: null };
        },
      }),
    },
  });
}

let server: Server;
let base: string;
let store: Store;

beforeAll(async () => {
  store = new Store();
  store.spaces.set("sp1", { id: "sp1", slug: "acme", name: "Acme" });
  store.members.set("memberA", new Set(["sp1"]));
  store.members.set("outsider", new Set());

  server = createTenantApp({
    supabaseUrl: "http://supabase.test",
    anonKey: "anon",
    clientFactory: fakeFactory(store),
    readArtifact: async (slug, gid, file) => store.objects.get(`${slug}/${gid}/${file}`) ?? null,
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const CSV = "username\n@Alice\nbob\nCHARLIE\ndavid\nerin\nalice\n";

async function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe("tenant server", () => {
  it("requires authentication for protected routes", async () => {
    const r = await post("/api/spaces/sp1/giveaways", { giveaway_id: "x", csv: CSV, winner_count: 1, block_height: 5 });
    expect(r.status).toBe(401);
  });

  it("validates input before touching the database", async () => {
    expect((await post("/api/spaces/sp1/giveaways", { giveaway_id: "bad id!", csv: CSV, winner_count: 1, block_height: 5 }, "memberA")).status).toBe(400);
    expect((await post("/api/spaces/sp1/giveaways", { giveaway_id: "nocsv", csv: "", winner_count: 1, block_height: 5 }, "memberA")).status).toBe(400);
    expect((await post("/api/spaces/sp1/giveaways", { giveaway_id: "toomany", csv: "username\nonly\n", winner_count: 9, block_height: 5 }, "memberA")).status).toBe(400);
  });

  it("blocks non-members (tenant isolation)", async () => {
    const r = await post("/api/spaces/sp1/giveaways", { giveaway_id: "sneaky", csv: CSV, winner_count: 1, block_height: 5 }, "outsider");
    expect(r.status).toBe(403);
    expect(store.giveaways.has("sp1/sneaky")).toBe(false);
  });

  it("creates, draws, and the public artifacts verify end-to-end", async () => {
    const create = await post("/api/spaces/sp1/giveaways", { giveaway_id: "launch", csv: CSV, winner_count: 2, block_height: 912144, timezone: "UTC" }, "memberA");
    expect(create.status).toBe(201);
    expect(create.json.participant_count).toBe(5); // alice deduped
    expect(create.json.drawn).toBe(false);
    expect(store.objects.has("acme/launch/manifest.json")).toBe(true);
    expect(store.objects.has("acme/launch/participants.json")).toBe(true);

    // public artifact passthrough works with no auth
    const pub = await fetch(base + "/g/acme/launch/manifest.json");
    expect(pub.status).toBe(200);

    // draw with an offline block hash
    const draw = await post("/api/spaces/sp1/giveaways/launch/draw", { block_hash: "f".repeat(64) }, "memberA");
    expect(draw.status).toBe(200);
    expect(draw.json.drawn).toBe(true);
    expect(draw.json.winners).toHaveLength(2);

    // independently verify the published artifacts with the trustless core
    const manifest = JSON.parse(store.objects.get("acme/launch/manifest.json")!.toString("utf8"));
    const participantFileBytes = new Uint8Array(store.objects.get("acme/launch/participants.json")!);
    const result = JSON.parse(store.objects.get("acme/launch/result.json")!.toString("utf8"));
    const report = verifyGiveaway({ manifest, participantFileBytes, result });
    expect(report.ok).toBe(true);
    expect(report.commitment).toBe(create.json.commitment);
  });

  it("rejects a second draw", async () => {
    const again = await post("/api/spaces/sp1/giveaways/launch/draw", { block_hash: "a".repeat(64) }, "memberA");
    expect(again.status).toBe(409);
  });

  it("serves config.js with anon key only", async () => {
    const res = await fetch(base + "/config.js");
    const text = await res.text();
    expect(text).toContain("http://supabase.test");
    expect(text).toContain("OG_CONFIG");
    expect(text).not.toContain("service_role");
  });

  it("404s unknown public artifacts", async () => {
    expect((await fetch(base + "/g/acme/launch/secret.txt")).status).toBe(404);
    expect((await fetch(base + "/g/acme/missing/manifest.json")).status).toBe(404);
  });
});

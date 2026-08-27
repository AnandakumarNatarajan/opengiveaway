import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/server/app.js";

let server: Server;
let base: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ogw-"));
  server = createApp({ dataDir });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const CSV = "username\n@Alice\nbob\nCHARLIE\ndavid\nerin\nalice\n";

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("giveaway server API", () => {
  it("creates, lists, and draws a giveaway; artifacts verify", async () => {
    const create = await post("/api/giveaways", {
      giveaway_id: "t1",
      csv: CSV,
      winner_count: 2,
      block_height: 912144,
      timezone: "UTC",
    });
    expect(create.status).toBe(201);
    expect(create.json.participant_count).toBe(5); // alice deduped
    expect(create.json.drawn).toBe(false);
    expect(create.json.commitment).toMatch(/^[0-9a-f]{64}$/);

    const list = await (await fetch(base + "/api/giveaways")).json();
    expect(list.giveaways.map((g: any) => g.giveaway_id)).toContain("t1");

    const draw = await post("/api/giveaways/t1/draw", {
      block_hash: "f".repeat(64),
    });
    expect(draw.status).toBe(200);
    expect(draw.json.drawn).toBe(true);
    expect(draw.json.winners).toHaveLength(2);
    expect(new Set(draw.json.winners.map((w: any) => w.username)).size).toBe(2);

    // published artifacts are reachable and consistent
    const manifest = await (await fetch(base + "/g/t1/manifest.json")).json();
    expect(manifest.participant_merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.participant_count).toBe(5);
    const result = await (await fetch(base + "/g/t1/result.json")).json();
    expect(result.winners).toHaveLength(2);
    expect(result.winners).toEqual(draw.json.winners);
  });

  it("rejects duplicate ids and double draws", async () => {
    await post("/api/giveaways", { giveaway_id: "dup", csv: CSV, winner_count: 1, block_height: 5 });
    const again = await post("/api/giveaways", { giveaway_id: "dup", csv: CSV, winner_count: 1, block_height: 5 });
    expect(again.status).toBe(409);

    await post("/api/giveaways/dup/draw", { block_hash: "a".repeat(64) });
    const twice = await post("/api/giveaways/dup/draw", { block_hash: "a".repeat(64) });
    expect(twice.status).toBe(409);
  });

  it("validates input", async () => {
    expect((await post("/api/giveaways", { giveaway_id: "bad id!", csv: CSV, winner_count: 1, block_height: 5 })).status).toBe(400);
    expect((await post("/api/giveaways", { giveaway_id: "nocsv", csv: "", winner_count: 1, block_height: 5 })).status).toBe(400);
    expect((await post("/api/giveaways", { giveaway_id: "toomany", csv: "username\nonlyone\n", winner_count: 9, block_height: 5 })).status).toBe(400);
  });

  it("reports OTS as absent when no proof was stamped", async () => {
    await post("/api/giveaways", { giveaway_id: "noots", csv: CSV, winner_count: 1, block_height: 5 });
    const res = await fetch(base + "/api/giveaways/noots/ots");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("absent");
  });

  it("does not serve unknown files or traverse paths", async () => {
    expect((await fetch(base + "/g/t1/secret.txt")).status).toBe(404);
    expect((await fetch(base + "/g/..%2f..%2fpackage.json")).status).toBe(404);
    expect((await fetch(base + "/g/t1/../../package.json")).status).toBe(404);
  });
});

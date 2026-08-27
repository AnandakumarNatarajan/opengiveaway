import { describe, it, expect } from "vitest";
import {
  normalizeUsername,
  freezeParticipants,
} from "../src/protocol/participant.js";

describe("normalizeUsername", () => {
  it("strips @, lowercases, trims", () => {
    expect(normalizeUsername("@Alice")).toBe("alice");
    expect(normalizeUsername("  ALICE ")).toBe("alice");
    expect(normalizeUsername("alice")).toBe("alice");
  });
});

describe("freezeParticipants", () => {
  it("deduplicates by normalized username, first provenance wins", () => {
    const frozen = freezeParticipants([
      { username: "@Alice", source: "csv", source_id: "row_1" },
      { username: "alice", source: "csv", source_id: "row_9" },
      { username: "BOB", source: "csv", source_id: "row_2" },
    ]);
    expect(frozen.map((p) => p.username)).toEqual(["alice", "bob"]);
    expect(frozen[0]!.source_id).toBe("row_1");
  });

  it("assigns deterministic sorted 1-based entries independent of input order", () => {
    const a = freezeParticipants([
      { username: "charlie", source: "csv", source_id: "r1" },
      { username: "alice", source: "csv", source_id: "r2" },
      { username: "bob", source: "csv", source_id: "r3" },
    ]);
    const b = freezeParticipants([
      { username: "bob", source: "csv", source_id: "r3" },
      { username: "charlie", source: "csv", source_id: "r1" },
      { username: "alice", source: "csv", source_id: "r2" },
    ]);
    expect(a).toEqual(b);
    expect(a.map((p) => [p.entry, p.username])).toEqual([
      [1, "alice"],
      [2, "bob"],
      [3, "charlie"],
    ]);
  });

  it("drops empty usernames", () => {
    const frozen = freezeParticipants([
      { username: "  ", source: "csv", source_id: "r1" },
      { username: "@", source: "csv", source_id: "r2" },
      { username: "real", source: "csv", source_id: "r3" },
    ]);
    expect(frozen.map((p) => p.username)).toEqual(["real"]);
  });
});

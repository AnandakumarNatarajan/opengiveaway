import { describe, it, expect } from "vitest";
import { MerkleTree, verifyProof, hashLeaf, hashNode } from "../src/protocol/merkle.js";
import { utf8, bytesToHex } from "../src/protocol/hash.js";

const leaves = (n: number) =>
  Array.from({ length: n }, (_, i) => utf8(`leaf-${i}`));

describe("MerkleTree", () => {
  it("single leaf root equals the tagged leaf hash", () => {
    const tree = new MerkleTree([utf8("only")]);
    expect(tree.root).toBe(bytesToHex(hashLeaf(utf8("only"))));
  });

  it("two-leaf root is node(l0,l1)", () => {
    const l0 = utf8("a");
    const l1 = utf8("b");
    const tree = new MerkleTree([l0, l1]);
    const expected = bytesToHex(hashNode(hashLeaf(l0), hashLeaf(l1)));
    expect(tree.root).toBe(expected);
  });

  it("every leaf has a valid inclusion proof (odd and even counts)", () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 16, 17]) {
      const ls = leaves(n);
      const tree = new MerkleTree(ls);
      for (let i = 0; i < n; i++) {
        const proof = tree.proof(i);
        expect(verifyProof(ls[i]!, proof, tree.root)).toBe(true);
      }
    }
  });

  it("rejects a proof against the wrong leaf", () => {
    const ls = leaves(8);
    const tree = new MerkleTree(ls);
    const proof = tree.proof(3);
    expect(verifyProof(ls[4]!, proof, tree.root)).toBe(false);
  });

  it("rejects a proof against a tampered root", () => {
    const ls = leaves(6);
    const tree = new MerkleTree(ls);
    const proof = tree.proof(2);
    const badRoot = "0".repeat(64);
    expect(verifyProof(ls[2]!, proof, badRoot)).toBe(false);
  });

  it("leaf and node domains differ (second-preimage hardening)", () => {
    const a = utf8("x");
    const b = utf8("y");
    expect(bytesToHex(hashLeaf(Buffer.concat([a, b])))).not.toBe(
      bytesToHex(hashNode(a, b)),
    );
  });
});

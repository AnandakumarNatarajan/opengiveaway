import { sha256, bytesToHex, hexToBytes } from "./hash.js";

/**
 * Merkle tree over pre-computed leaf hashes.
 *
 * Second-preimage hardening: leaves and internal nodes are hashed with
 * distinct domain-separation prefixes (0x00 for leaves, 0x01 for internal
 * nodes). Leaf *hashing* (turning a participant into a leaf digest) is the
 * caller's job — see participant.ts — but we re-tag those digests here with
 * the 0x00 prefix so a 32-byte internal node can never be reinterpreted as a
 * leaf.
 *
 * Odd node handling: instead of duplicating the last node (the well-known
 * CVE-2012-2459 malleability footgun), an odd node is promoted unchanged to
 * the next level.
 */

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export function hashLeaf(leafData: Uint8Array): Buffer {
  return sha256(LEAF_PREFIX, leafData);
}

export function hashNode(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

export interface ProofStep {
  /** Sibling hash, hex-encoded. */
  hash: string;
  /** Which side the sibling is on relative to the running hash. */
  position: "left" | "right";
}

export interface MerkleProof {
  leafIndex: number;
  /** The leaf's own hash (0x00-tagged), hex-encoded. */
  leaf: string;
  path: ProofStep[];
}

export class MerkleTree {
  /** levels[0] = leaf hashes, levels[last] = [root]. */
  private readonly levels: Buffer[][];

  /**
   * @param leaves Raw per-item leaf preimages OR already-tagged leaf hashes.
   *   Pass `alreadyHashed: true` when you provide 32-byte leaf digests that
   *   should still be 0x00-tagged before being placed in the tree.
   */
  constructor(leafPreimages: Uint8Array[]) {
    if (leafPreimages.length === 0) {
      throw new Error("cannot build a Merkle tree over zero leaves");
    }
    const leaves = leafPreimages.map((l) => hashLeaf(l));
    this.levels = [leaves];
    let current = leaves;
    while (current.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i]!;
        const right = current[i + 1];
        if (right === undefined) {
          // odd node: promote unchanged
          next.push(left);
        } else {
          next.push(hashNode(left, right));
        }
      }
      this.levels.push(next);
      current = next;
    }
  }

  get root(): string {
    const top = this.levels[this.levels.length - 1]!;
    return bytesToHex(top[0]!);
  }

  get leafCount(): number {
    return this.levels[0]!.length;
  }

  proof(leafIndex: number): MerkleProof {
    const leaves = this.levels[0]!;
    if (leafIndex < 0 || leafIndex >= leaves.length) {
      throw new Error(`leaf index out of range: ${leafIndex}`);
    }
    const path: ProofStep[] = [];
    let index = leafIndex;
    for (let level = 0; level < this.levels.length - 1; level++) {
      const nodes = this.levels[level]!;
      const isRight = index % 2 === 1;
      const siblingIndex = isRight ? index - 1 : index + 1;
      const sibling = nodes[siblingIndex];
      if (sibling !== undefined) {
        path.push({
          hash: bytesToHex(sibling),
          position: isRight ? "left" : "right",
        });
      }
      // if sibling is undefined the node was promoted; no step recorded.
      index = Math.floor(index / 2);
    }
    return {
      leafIndex,
      leaf: bytesToHex(leaves[leafIndex]!),
      path,
    };
  }
}

/**
 * Recompute a Merkle root from a leaf preimage and its proof, and check it
 * against the committed root. This is the function a third-party verifier
 * (browser or CLI) runs; it never needs the full participant set.
 */
export function verifyProof(
  leafPreimage: Uint8Array,
  proof: MerkleProof,
  expectedRoot: string,
): boolean {
  let running = hashLeaf(leafPreimage);
  if (bytesToHex(running) !== proof.leaf) {
    return false;
  }
  for (const step of proof.path) {
    const sibling = hexToBytes(step.hash);
    running =
      step.position === "left"
        ? hashNode(sibling, running)
        : hashNode(running, sibling);
  }
  return bytesToHex(running) === expectedRoot;
}

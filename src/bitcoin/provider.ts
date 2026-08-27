/**
 * Bitcoin block data provider.
 *
 * The protocol only needs two things: the current tip height (to help an
 * organizer pick a future block height when scheduling) and the block hash at
 * a given height (to run and verify the draw). Kept behind an interface so the
 * randomness source is pluggable and tests can run offline.
 */
export interface BitcoinProvider {
  getTipHeight(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
}

/**
 * Provider backed by an Esplora-compatible HTTP API (mempool.space by
 * default; blockstream.info works too). No API key required.
 */
export class EsploraProvider implements BitcoinProvider {
  constructor(private readonly baseUrl = "https://mempool.space/api") {}

  async getTipHeight(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/blocks/tip/height`);
    if (!res.ok) {
      throw new Error(`tip height request failed: ${res.status}`);
    }
    const text = (await res.text()).trim();
    const height = Number(text);
    if (!Number.isInteger(height)) {
      throw new Error(`unexpected tip height response: ${text}`);
    }
    return height;
  }

  async getBlockHash(height: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/block-height/${height}`);
    if (res.status === 404) {
      throw new Error(`block ${height} does not exist yet`);
    }
    if (!res.ok) {
      throw new Error(`block-hash request failed: ${res.status}`);
    }
    const hash = (await res.text()).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`unexpected block-hash response: ${hash}`);
    }
    return hash;
  }
}

/** Deterministic offline provider for tests and dry runs. */
export class StaticProvider implements BitcoinProvider {
  constructor(
    private readonly hashes: Map<number, string>,
    private readonly tip: number,
  ) {}

  async getTipHeight(): Promise<number> {
    return this.tip;
  }

  async getBlockHash(height: number): Promise<string> {
    const h = this.hashes.get(height);
    if (h === undefined) throw new Error(`block ${height} not available`);
    return h;
  }
}

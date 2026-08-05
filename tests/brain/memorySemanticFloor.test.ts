import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import type { EmbeddingConfig, EmbeddingService } from '../../src/embeddings/embeddingService.js';

/** The operator-tunable relevance floor (Settings → Elowen AI → Runtime). It reaches MemoryService as an
 *  integer per mille of cosine similarity — a float would be rounded to a whole number by the config
 *  clamp and floor nothing at all — so these cover both the conversion and the two paths that apply it:
 *  per-turn recall (`retrieve`) and the manual search box (`searchSemantic`). */

const CONFIG: EmbeddingConfig = { providerId: 'p', model: 'm' };

/** Deterministic embeddings: text → fixed vector, so every cosine in the test is exact. */
class FakeEmbeddings {
  constructor(private table: Record<string, number[]>) {}
  async embed(_cfg: EmbeddingConfig, text: string): Promise<Float32Array> {
    return Float32Array.from(this.table[text] ?? [0, 0, 0]);
  }
  async embedBatch(_cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => Float32Array.from(this.table[t] ?? [0, 0, 0]));
  }
}

// `far` cosines the query at 0.40: above the built-in 0.30 floor, below a configured 0.50 one — the
// single memory whose eligibility the setting decides. `near` (1.0) must survive every floor tested.
const TABLE: Record<string, number[]> = {
  query: [1, 0, 0],
  near: [1, 0, 0],
  far: [0.4, 0.9165, 0],
  // 0.60: above a 0.50 floor, below the 1.0 that rounding would turn that floor into — and far enough
  // from `near` (which is the query itself) that packing does not read it as a paraphrase and drop it.
  mid: [0.6, 0.8, 0],
};

let categories: MemoryCategoryStore;
let globalCategoryId: number;

function serviceWith(store: MemoryStore, floorPerMille?: () => number): MemoryService {
  const embeddings = new FakeEmbeddings(TABLE) as unknown as EmbeddingService;
  return new MemoryService({
    store,
    categories,
    embeddings,
    embeddingConfig: () => CONFIG,
    ...(floorPerMille ? { semanticFloorPerMille: floorPerMille } : {}),
  });
}

function addWithVec(store: MemoryStore, body: string): void {
  const m = store.add(1, { body, importance: 3 }, 'agent', '');
  store.setCategory(1, m.id, globalCategoryId, 'agent', '');
  const v = Float32Array.from(TABLE[body] ?? [0, 0, 0]);
  store.setEmbedding(1, m.id, { provider: 'p', model: 'm', dimensions: v.length, vector: v, contentHash: hashBody(body) });
}

describe('MemoryService — operator-tunable semantic floor', () => {
  let store: MemoryStore;
  beforeEach(() => {
    const db = openDb(':memory:');
    store = new MemoryStore(db);
    categories = new MemoryCategoryStore(db);
    globalCategoryId = categories.create(1, { name: 'Global' }).id;
    addWithVec(store, 'near');
    addWithVec(store, 'far');
  });

  it('recalls a 0.40-cosine memory under the built-in floor and drops it once the operator raises it', async () => {
    const builtIn = await serviceWith(store).retrieve(1, 'query');
    expect(builtIn.memories.map((m) => m.body).sort()).toEqual(['far', 'near']);

    const strict = await serviceWith(store, () => 500).retrieve(1, 'query');
    expect(strict.memories.map((m) => m.body)).toEqual(['near']);
  });

  it('lowering the floor lets a weak hit back in', async () => {
    const lenient = await serviceWith(store, () => 100).retrieve(1, 'query');
    expect(lenient.memories.map((m) => m.body).sort()).toEqual(['far', 'near']);
  });

  it('reads the floor per call, so a settings change applies without a restart', async () => {
    let perMille = 500;
    const svc = serviceWith(store, () => perMille);
    expect((await svc.retrieve(1, 'query')).memories.map((m) => m.body)).toEqual(['near']);
    perMille = 200;
    expect((await svc.retrieve(1, 'query')).memories.map((m) => m.body).sort()).toEqual(['far', 'near']);
  });

  it('applies the same floor to the manual search box', async () => {
    const strict = await serviceWith(store, () => 500).searchSemantic(1, 'query', 10);
    expect(strict.map((m) => m.body)).toEqual(['near']);

    const lenient = await serviceWith(store, () => 300).searchSemantic(1, 'query', 10);
    expect(lenient.map((m) => m.body).sort()).toEqual(['far', 'near']);
  });

  // The per-mille contract: 300 must mean 0.30, not 300 — reading it as a raw cosine would floor every
  // memory out of every recall, which is the failure mode the unit choice exists to prevent.
  it('treats the configured value as per mille, not as a raw cosine', async () => {
    const res = await serviceWith(store, () => 300).retrieve(1, 'query');
    expect(res.memories.map((m) => m.body).sort()).toEqual(['far', 'near']);
  });

  // The conversion has to keep the FRACTION, not just the unit. Every other case here uses cosines
  // (0.40 and 1.0) that sit either side of both 0.50 and a rounded 1.0, so they cannot tell an exact
  // divide from one that rounds the floor to a whole number — a 0.60 hit against a 0.50 floor can:
  // rounding turns that floor into 1.0 and swallows a memory the operator asked to keep.
  it('divides exactly, so a fractional floor keeps a hit that a rounded one would swallow', async () => {
    addWithVec(store, 'mid'); // cosines the query at 0.60
    const res = await serviceWith(store, () => 500).retrieve(1, 'query');
    expect(res.memories.map((m) => m.body).sort()).toEqual(['mid', 'near']);
  });

  it('falls back to the built-in floor when the accessor yields a non-finite value', async () => {
    const res = await serviceWith(store, () => Number.NaN).retrieve(1, 'query');
    expect(res.memories.map((m) => m.body).sort()).toEqual(['far', 'near']);
  });
});

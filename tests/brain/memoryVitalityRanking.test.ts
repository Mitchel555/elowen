import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import type { EmbeddingConfig, EmbeddingService } from '../../src/embeddings/embeddingService.js';
import type { MemoryRetentionConfig } from '../../src/brain/memoryVitality.js';

const CONFIG: EmbeddingConfig = { providerId: 'test', model: 'test' };
const RETENTION: MemoryRetentionConfig = {
  enabled: true,
  graceDays: 14,
  vitalityFloor: 10,
  halfLifeByImportance: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 0 },
};

class FakeEmbeddings {
  constructor(private readonly vectors: Record<string, number[]>) {}

  async embed(_config: EmbeddingConfig, text: string): Promise<Float32Array> {
    return Float32Array.from(this.vectors[text] ?? [0, 0]);
  }

  async embedBatch(_config: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => Float32Array.from(this.vectors[text] ?? [0, 0]));
  }
}

function createService(store: MemoryStore, categories: MemoryCategoryStore, vectors: Record<string, number[]>): MemoryService {
  return new MemoryService({
    store,
    categories,
    embeddings: new FakeEmbeddings(vectors) as EmbeddingService,
    embeddingConfig: () => CONFIG,
    retention: () => RETENTION,
  });
}

function addEmbedded(
  store: MemoryStore,
  categoryId: number,
  body: string,
  vector: number[],
): number {
  const memory = store.add(1, { body, importance: 3 }, 'test', '');
  store.setCategory(1, memory.id, categoryId, 'test', '');
  store.setEmbedding(1, memory.id, {
    provider: 'test',
    model: 'test',
    dimensions: vector.length,
    vector: Float32Array.from(vector),
    contentHash: hashBody(body),
  });
  return memory.id;
}

describe('MemoryService vitality ranking', () => {
  it('ranks a fresh memory above an equally semantic but stale, heavily used memory', async () => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    const categoryId = categories.create(1, { name: 'Global' }).id;
    const vectors = {
      query: [1, 0],
      stale: [0.8, 0.6],
      fresh: [0.8, -0.6],
    };
    const staleId = addEmbedded(store, categoryId, 'stale', vectors.stale);
    const freshId = addEmbedded(store, categoryId, 'fresh', vectors.fresh);
    db.prepare("UPDATE memories SET use_count = 100, last_used_at = datetime('now', '-5 days') WHERE id = ?").run(staleId);

    const service = createService(store, categories, vectors);
    const stale = store.get(1, staleId);
    const fresh = store.get(1, freshId);
    expect(stale).toBeDefined();
    expect(fresh).toBeDefined();
    if (!stale || !fresh) throw new Error('Test memories were not persisted');
    expect(service.vitalityOf(fresh)).toBeGreaterThan(service.vitalityOf(stale));

    const result = await service.retrieve(1, 'query', {
      maxCount: 2,
      markUsed: false,
    });

    expect(result.memories.map((memory) => memory.id)).toEqual([freshId, staleId]);
  });

  it('keeps a memory below the semantic floor out of vector recall', async () => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    const categoryId = categories.create(1, { name: 'Global' }).id;
    const vectors = {
      query: [1, 0],
      eligible: [0.8, 0.6],
      belowFloor: [0.2, 0.98],
    };
    const eligibleId = addEmbedded(store, categoryId, 'eligible', vectors.eligible);
    addEmbedded(store, categoryId, 'belowFloor', vectors.belowFloor);
    const service = createService(store, categories, vectors);

    const result = await service.retrieve(1, 'query', { markUsed: false });

    expect(result.memories.map((memory) => memory.id)).toEqual([eligibleId]);
  });

  it('does not bump usage counters when retrieval is inspection-only', async () => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    const categoryId = categories.create(1, { name: 'Global' }).id;
    const vectors = { query: [1, 0], hit: [1, 0] };
    const id = addEmbedded(store, categoryId, 'hit', vectors.hit);
    const service = createService(store, categories, vectors);

    const result = await service.retrieve(1, 'query', { markUsed: false });

    expect(result.memories.map((memory) => memory.id)).toEqual([id]);
    const stored = store.get(1, id);
    expect(stored).toBeDefined();
    if (!stored) throw new Error('Test memory was not persisted');
    expect(stored.use_count).toBe(0);
    expect(stored.last_used_at).toBeNull();
  });
});

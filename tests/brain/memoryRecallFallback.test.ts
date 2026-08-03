import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import type { EmbeddingConfig, EmbeddingService } from '../../src/embeddings/embeddingService.js';

/** Per-turn recall used to return NOTHING whenever the embedding call succeeded but every candidate sat
 *  below the relevance floor. That is not the same as "no memory is relevant": a thin query like "fix it"
 *  cannot reach the floor against any body, however on-topic — measured against production data it peaks
 *  at 0.12 cosine and admits 0 of 53 memories. The manual search box already fell through to keyword
 *  search for this exact reason; recall did not, which is where "it forgot again" came from. */

const CONFIG: EmbeddingConfig = { providerId: 'p', model: 'm' };

/** Deterministic embeddings. Every vector here is orthogonal to the query, so the vector path always
 *  scores 0 and the floor always rejects — isolating the fallback as the only thing that can answer. */
class OrthogonalEmbeddings {
  async embed(_cfg: EmbeddingConfig, _text: string): Promise<Float32Array> {
    return Float32Array.from([0, 1, 0]);
  }
  async embedBatch(_cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([0, 1, 0]));
  }
}

class ThrowingEmbeddings {
  async embed(): Promise<Float32Array> { throw new Error('embedding endpoint down'); }
  async embedBatch(): Promise<Float32Array[]> { throw new Error('embedding endpoint down'); }
}

function serviceWith(store: MemoryStore, embeddings: unknown): MemoryService {
  return new MemoryService({
    store,
    embeddings: embeddings as EmbeddingService,
    embeddingConfig: () => CONFIG,
  });
}

/** Store a memory whose vector is orthogonal to whatever the query embeds to. */
function addOrthogonal(store: MemoryStore, body: string): void {
  const m = store.add(1, { body, importance: 3 }, 'agent', '');
  const v = Float32Array.from([1, 0, 0]);
  store.setEmbedding(1, m.id, { provider: 'p', model: 'm', dimensions: v.length, vector: v, contentHash: hashBody(body) });
}

describe('MemoryService — recall falls back to keyword when the vector path clears nothing', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(openDb(':memory:'));
    addOrthogonal(store, 'Deployment of the daemon runs through release.sh');
    addOrthogonal(store, 'Something entirely unrelated about hair colouring');
  });

  it('returns the keyword match instead of nothing when every candidate is below the floor', async () => {
    const res = await serviceWith(store, new OrthogonalEmbeddings()).retrieve(1, 'deployment');

    expect(res.memories.map((m) => m.body)).toEqual(['Deployment of the daemon runs through release.sh']);
    // The caller must be able to tell WHICH path answered, otherwise the debug panel would report a
    // semantic hit that never happened.
    expect(res.debug.fallback).toBe(true);
  });

  it('keeps the cosine scores so the debug panel can explain what the floor rejected', async () => {
    // The point of the fallback was that a thin query cannot clear the floor. A debug record that says
    // only "fallback" cannot show how close the best candidate came, which is the one number an operator
    // needs to decide whether the floor is set wrong.
    const res = await serviceWith(store, new OrthogonalEmbeddings()).retrieve(1, 'deployment');

    expect(res.debug.fallback).toBe(true);
    expect(res.debug.candidates).toBe(2);
    expect(res.debug.scores.length).toBeGreaterThan(0);
  });

  it('still prefers the vector result whenever one clears the floor', async () => {
    // Same query, but now the embeddings agree with the stored vector, so the semantic path answers and
    // the fallback must not run — a keyword pass here would quietly widen every successful recall.
    class AlignedEmbeddings {
      async embed(): Promise<Float32Array> { return Float32Array.from([1, 0, 0]); }
      async embedBatch(texts: string[]): Promise<Float32Array[]> { return texts.map(() => Float32Array.from([1, 0, 0])); }
    }
    const res = await serviceWith(store, new AlignedEmbeddings()).retrieve(1, 'deployment');

    expect(res.debug.fallback).toBe(false);
    expect(res.memories.length).toBeGreaterThan(0);
  });

  it('keeps falling back when the embedding call itself throws — and there recency still counts', async () => {
    const res = await serviceWith(store, new ThrowingEmbeddings()).retrieve(1, 'deployment');

    expect(res.debug.fallback).toBe(true);
    // A dead embedding endpoint leaves NO relevance signal, so padding with recent memories is the right
    // last resort and is deliberately kept. The keyword hit must still rank first.
    expect(res.memories[0]?.body).toBe('Deployment of the daemon runs through release.sh');
    expect(res.memories.length).toBeGreaterThan(1);
  });

  it('returns nothing when the query matches neither semantically nor by keyword', async () => {
    // The fallback must not become "return something regardless" — an unrelated query still yields an
    // empty recall rather than dragging in whatever was stored most recently.
    const res = await serviceWith(store, new OrthogonalEmbeddings()).retrieve(1, 'quantum chromodynamics');
    expect(res.memories).toEqual([]);
  });
});

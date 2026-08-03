import type { MemoryRow } from '../shared/wireContract.js';
import { parseDbTs } from '../shared/time.js';

export interface MemoryRetentionConfig {
  enabled: boolean;
  graceDays: number;
  vitalityFloor: number;
  halfLifeByImportance: Record<number, number>;
}

export const DEFAULT_MEMORY_RETENTION: MemoryRetentionConfig = {
  enabled: true,
  graceDays: 14,
  vitalityFloor: 10,
  halfLifeByImportance: {
    1: 15,
    2: 30,
    3: 60,
    4: 90,
    5: 0,
  },
};

export const USAGE_K = 5;
const USAGE_BASE = 0.5;
export const PIN_IMPORTANCE = 5;

const DAY_MS = 86_400_000;

export type VitalityMemory = Pick<MemoryRow, 'importance' | 'use_count' | 'last_used_at' | 'created_at'>;

function clampVitality(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function vitality(memory: VitalityMemory, retention: MemoryRetentionConfig, now: number): number {
  const lastUsedAt = parseDbTs(memory.last_used_at);
  const createdAt = parseDbTs(memory.created_at);
  const referenceAt = lastUsedAt || createdAt || now;
  const ageDays = Math.max(0, (now - referenceAt) / DAY_MS);
  const halfLife = retention.halfLifeByImportance[memory.importance] ?? 0;
  const decay = memory.importance === PIN_IMPORTANCE || halfLife === 0
    ? 1
    : 0.5 ** (ageDays / halfLife);
  const useCount = Math.max(0, memory.use_count);
  const usageSaturation = useCount / (useCount + USAGE_K);

  return clampVitality(100 * decay * (USAGE_BASE + (1 - USAGE_BASE) * usageSaturation));
}

export function isEvictable(memory: VitalityMemory, retention: MemoryRetentionConfig, now: number): boolean {
  const createdAt = parseDbTs(memory.created_at);
  const isPastGracePeriod = createdAt > 0 && now - createdAt > retention.graceDays * DAY_MS;

  const halfLife = retention.halfLifeByImportance[memory.importance] ?? 0;

  return retention.enabled
    && memory.importance < PIN_IMPORTANCE
    && halfLife !== 0
    && isPastGracePeriod
    && vitality(memory, retention, now) < retention.vitalityFloor;
}

import type { ShardIdentity } from './types.js';

export type Position = Pick<ShardIdentity, 'index' | 'count'>;

export function parseShard(value: string): Position {
  if (!/^\d+\/\d+$/.test(value)) throw new Error('shard must be index/count');
  const [index, count] = value.split('/').map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index! < 1 || count! < index!) {
    throw new Error('invalid shard index/count');
  }
  return { index: index!, count: count! };
}

export function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
}

/** Stable round-robin partition, including empty shards. */
export function partition<T>(items: readonly T[], shard: Position): T[] {
  parseShard(`${shard.index}/${shard.count}`);
  return items.filter((_, index) => index % shard.count === shard.index - 1);
}

/** How many of `total` globally indexed units (flake runs, mutants) this round-robin shard owns. */
export function shardRunCount(total: number, shard: Position): number {
  parseShard(`${shard.index}/${shard.count}`);
  requireCount(total, 'configured runs');
  return Math.max(0, Math.ceil((total - shard.index + 1) / shard.count));
}

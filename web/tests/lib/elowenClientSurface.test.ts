import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { elowenClient } from '../../lib/elowenClient';
import { QUERY_KEYS } from '../../lib/queries';

/** The API client and the SSE cache bridge are pure plumbing: nothing about them fails at runtime when a
 *  piece stops being used, so a wrapper for a route no component calls — or an invalidation for a query
 *  key no component registers — sits there looking load-bearing and silently rots. Both are checked here
 *  against the real source tree, because both are only detectable by looking for the missing consumer. */

const WEB_ROOT = resolve(process.cwd());
const SOURCE_DIRS = ['app', 'components', 'lib', 'modules'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const read = (path: string): string => readFileSync(path, 'utf8');
const files = SOURCE_DIRS.flatMap((dir) => walk(join(WEB_ROOT, dir)));
const CLIENT = join(WEB_ROOT, 'lib', 'elowenClient.ts');
const BRIDGE = join(WEB_ROOT, 'lib', 'useElowenEvents.ts');

describe('elowenClient surface', () => {
  // A method nothing calls is a dead route wrapper: it keeps a removed feature's endpoint and DTOs alive
  // across the whole web bundle. Tests are deliberately NOT scanned — a wrapper exercised only by its own
  // transport test still has no product consumer.
  it('has no method that no web source calls', () => {
    const consumers = files.filter((f) => f !== CLIENT).map(read).join('\n');
    const unused = Object.keys(elowenClient).filter((name) => !new RegExp(`\\b${name}\\b`).test(consumers));
    expect(unused).toEqual([]);
  });
});

describe('SSE cache invalidation', () => {
  // react-query silently no-ops an invalidation whose key matches no registered query, so a stale key
  // survives the removal of the query it belonged to and reads like the cache is still being refreshed.
  it('invalidates only query keys that some query actually registers', () => {
    const invalidated = [...read(BRIDGE).matchAll(/invalidateQueries\(\{ queryKey: \['([a-z-]+)'/g)].map((m) => m[1]!);
    expect(invalidated.length).toBeGreaterThan(0); // the extraction itself must not silently match nothing

    // Only true registrations count: an invalidation elsewhere in the tree cannot vouch for a key.
    const registrationLines = files.flatMap((f) => read(f).split('\n')).filter((line) => !line.includes('invalidateQueries'));
    const registered = new Set<string>([
      ...Object.values(QUERY_KEYS).map((key) => key[0] as string),
      ...registrationLines.flatMap((line) => [...line.matchAll(/queryKey: \['([a-z-]+)'/g)].map((m) => m[1]!)),
    ]);
    expect(invalidated.filter((key) => !registered.has(key))).toEqual([]);
  });
});

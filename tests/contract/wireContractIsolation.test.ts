import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/shared/wireContract.ts is the one file both toolchains compile: the daemon under NodeNext and the
// standalone web bundle under a bundler resolver. That only works while it stays a leaf — the moment it
// imports anything, it drags a module graph resolved by two different sets of rules into the web build,
// and `.js` specifiers the web resolver treats differently are exactly how that breaks.
//
// The isolation is load-bearing but was previously unguarded: adding an import passed typecheck, lint and
// every suite, because a type-only import is erased before the web bundle is ever produced and a runtime
// one simply had no test that looked. This pins the property directly rather than hoping a build notices.
const contractPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/shared/wireContract.ts');
const source = readFileSync(contractPath, 'utf8');

/** Strip comments and string literals so a mention of "import" in prose or in a type name cannot count. */
function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('wireContract stays importless so both toolchains can compile it', () => {
  const code = stripCommentsAndStrings(source);

  it('declares no import of any kind — including type-only ones', () => {
    // `import type` is erased for the web, so it cannot break the bundle. It is rejected anyway: it still
    // ties the shared contract to a daemon path, and the next person copies the pattern for a value.
    const imports = code.match(/\bimport\b\s*(?:type\b)?[^;]*from\s*['"`]/g) ?? [];
    expect(imports).toEqual([]);
  });

  it('uses no dynamic import, require, or export-from re-export', () => {
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bexport\b[^;]*\bfrom\s*['"`]/);
  });

  it('exports only types, never a runtime value', () => {
    // A runtime export would make the web bundle actually execute this module rather than erase it.
    expect(code).not.toMatch(/\bexport\s+(?:default|const|let|var|function|class|enum)\b/);
  });
});

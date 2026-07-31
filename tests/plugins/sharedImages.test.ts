import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs plugin module, no types
import { resolveImageFiles } from '../../plugins/_shared/images.mjs';

describe('shared plugin image resolution', () => {
  let root: string;
  let genDir: string;
  let editDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'elowen-images-'));
    genDir = join(root, 'image-gen');
    editDir = join(root, 'image-edit');
    mkdirSync(genDir);
    mkdirSync(editDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('loads each named file as a name/data pair, in the order asked for', () => {
    writeFileSync(join(genDir, 'a.png'), 'AAA');
    writeFileSync(join(editDir, 'b.png'), 'BBB');
    const files = resolveImageFiles([genDir, editDir], ['b.png', 'a.png'], 10);
    expect(files.map((f: { name: string }) => f.name)).toEqual(['b.png', 'a.png']);
    expect(files[0].data.toString()).toBe('BBB');
    expect(files[1].data.toString()).toBe('AAA');
  });

  it('takes the first directory that holds the name (the dirs are searched in order)', () => {
    writeFileSync(join(genDir, 'dup.png'), 'FIRST');
    writeFileSync(join(editDir, 'dup.png'), 'SECOND');
    expect(resolveImageFiles([genDir, editDir], ['dup.png'], 10)[0].data.toString()).toBe('FIRST');
    expect(resolveImageFiles([editDir, genDir], ['dup.png'], 10)[0].data.toString()).toBe('SECOND');
  });

  it('caps how many names it reads, keeping the first ones', () => {
    for (const n of ['a.png', 'b.png', 'c.png']) writeFileSync(join(genDir, n), n);
    expect(resolveImageFiles([genDir], ['a.png', 'b.png', 'c.png'], 2).map((f: { name: string }) => f.name))
      .toEqual(['a.png', 'b.png']);
    expect(resolveImageFiles([genDir], ['a.png'], 0)).toEqual([]);
  });

  it('skips a missing name silently so the text still goes out without it', () => {
    writeFileSync(join(genDir, 'there.png'), 'X');
    const files = resolveImageFiles([genDir, editDir], ['gone.png', 'there.png'], 10);
    expect(files.map((f: { name: string }) => f.name)).toEqual(['there.png']);
    expect(resolveImageFiles([], ['there.png'], 10)).toEqual([]);
  });

  it('skips an unreadable name rather than throwing mid-send, and does not fall through to the next dir', () => {
    // A directory under the name exists but cannot be read as a file (EISDIR).
    mkdirSync(join(genDir, 'odd.png'));
    writeFileSync(join(editDir, 'odd.png'), 'SHADOWED');
    let files: { name: string }[] = [];
    expect(() => { files = resolveImageFiles([genDir, editDir], ['odd.png'], 10); }).not.toThrow();
    // The first directory holding the name wins even when reading it fails — no silent second-dir fallback.
    expect(files).toEqual([]);
  });
});

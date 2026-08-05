import { describe, it, expect } from 'vitest';
import { buildTree, langOf, parentDir, joinPath, copyName, isImage, isMarkdown } from '../../../modules/projects/editor/helpers';
import { baseName, extOf } from '../../../lib/filePath';

describe('editor helpers', () => {
  it('builds a nested tree with dirs before files, alpha within', () => {
    const tree = buildTree([
      { path: 'src', type: 'dir' },
      { path: 'src/b.ts', type: 'file' },
      { path: 'src/a.ts', type: 'file' },
      { path: 'README.md', type: 'file' },
      { path: 'docs', type: 'dir' },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['docs', 'src', 'README.md']); // dirs first, then files
    const src = tree.find((n) => n.name === 'src')!;
    expect(src.children.map((c) => c.name)).toEqual(['a.ts', 'b.ts']);
  });

  it('maps extensions to Monaco languages', () => {
    expect(langOf('a.ts')).toBe('typescript');
    expect(langOf('style.css')).toBe('css');
    expect(langOf('x.unknown')).toBe('plaintext');
  });

  it('derives path parts', () => {
    expect(baseName('a/b/c.ts')).toBe('c.ts');
    expect(parentDir('a/b/c.ts')).toBe('a/b');
    expect(parentDir('top.ts')).toBe('');
    expect(joinPath('a/b', 'c.ts')).toBe('a/b/c.ts');
    expect(joinPath('', 'c.ts')).toBe('c.ts');
  });

  it('suggests a copy name next to the original', () => {
    expect(copyName('src/index.ts')).toBe('src/index copy.ts');
    expect(copyName('LICENSE')).toBe('LICENSE copy');
    expect(copyName('.gitignore')).toBe('.gitignore copy'); // leading dot is not an extension
  });

  it('classifies images and markdown', () => {
    expect(isImage('logo.PNG')).toBe(true);
    expect(isImage('a.ts')).toBe(false);
    expect(isMarkdown('README.md')).toBe(true);
    expect(isMarkdown('notes.markdown')).toBe(true);
    expect(isMarkdown('a.txt')).toBe(false);
  });

  it('reads the extension from the file name only, never from a dotted directory', () => {
    // Regression: the old `p.split('.').pop()` took the segment after the LAST dot of the whole
    // path, so a dot in a directory (`config.v2`) hijacked the extension and language/type
    // detection fell back to plaintext/generic.
    expect(extOf('src/config.v2/soubor')).toBe('soubor'); // not the nonsense 'v2/soubor'
    expect(extOf('src/config.v2/app.ts')).toBe('ts');
    expect(langOf('src/config.v2/ts')).toBe('typescript');
    expect(isImage('assets.v1/png')).toBe(true);
    expect(isMarkdown('docs.v2/md')).toBe(true);
  });
});

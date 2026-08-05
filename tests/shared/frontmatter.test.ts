import { describe, it, expect } from 'vitest';
import { splitFrontmatter } from '../../src/shared/frontmatter.js';

describe('splitFrontmatter', () => {
  it('splits a plain LF frontmatter block from the body', () => {
    expect(splitFrontmatter('---\nname: x\n---\nBody\n'))
      .toEqual({ frontmatter: 'name: x', body: 'Body\n' });
  });

  it('splits a CRLF file and does not leak the carriage returns into the parts', () => {
    expect(splitFrontmatter('---\r\nname: x\r\n---\r\nBody\r\n'))
      .toEqual({ frontmatter: 'name: x', body: 'Body\r\n' });
  });

  it('tolerates a leading BOM', () => {
    expect(splitFrontmatter('\uFEFF---\nname: x\n---\nBody\n'))
      .toEqual({ frontmatter: 'name: x', body: 'Body\n' });
  });

  it('allows whitespace after the opening and closing markers', () => {
    expect(splitFrontmatter('---   \nname: x\n---  \nBody\n'))
      .toEqual({ frontmatter: 'name: x', body: 'Body\n' });
  });

  it('returns an empty frontmatter and the whole source when there is no frontmatter', () => {
    expect(splitFrontmatter('just text\n')).toEqual({ frontmatter: '', body: 'just text\n' });
    expect(splitFrontmatter('')).toEqual({ frontmatter: '', body: '' });
    expect(splitFrontmatter('---\nnever closed\n')).toEqual({ frontmatter: '', body: '---\nnever closed\n' });
  });

  it('ends the block at the FIRST closing --- line, so a --- in the body stays body', () => {
    expect(splitFrontmatter('---\nname: x\n---\nBody one\n\n---\n\nBody two\n'))
      .toEqual({ frontmatter: 'name: x', body: 'Body one\n\n---\n\nBody two\n' });
  });

  it('does not treat a same-line ---junk as a closing marker', () => {
    expect(splitFrontmatter('---\na\n---junk\nBody')).toEqual({ frontmatter: '', body: '---\na\n---junk\nBody' });
  });
});

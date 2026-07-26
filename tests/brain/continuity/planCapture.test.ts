import { describe, it, expect } from 'vitest';
import { extractProposedPlan, proposedPlanMatcher, proposedPlanOpenMatcher } from '../../../src/brain/continuity/planCapture.js';

describe('continuity/planCapture', () => {
  it('extracts the body of a complete block, trimmed', () => {
    const text = 'Here you go.\n\n<proposed_plan>\n# Ship it\n\nStep one.\n</proposed_plan>';
    expect(extractProposedPlan(text)).toBe('# Ship it\n\nStep one.');
  });

  it('returns null when the turn proposed no plan', () => {
    expect(extractProposedPlan('Just an ordinary answer.')).toBeNull();
  });

  // A turn that revises itself mid-answer means the later plan.
  it('takes the last complete block when several are present', () => {
    const text = '<proposed_plan>first</proposed_plan> then <proposed_plan>second</proposed_plan>';
    expect(extractProposedPlan(text)).toBe('second');
  });

  // Half a plan reads as a whole one in the next prompt, which is worse than having none.
  it('ignores an unterminated block', () => {
    expect(extractProposedPlan('<proposed_plan>\n# Half a plan, still streaming')).toBeNull();
  });

  it('ignores a complete but empty block', () => {
    expect(extractProposedPlan('<proposed_plan>   </proposed_plan>')).toBeNull();
  });

  it('keeps an earlier complete block when a later one is unterminated', () => {
    expect(extractProposedPlan('<proposed_plan>done</proposed_plan> more <proposed_plan>partial'))
      .toBe('done');
  });

  it('matches case-insensitively, as the renderer does', () => {
    expect(extractProposedPlan('<PROPOSED_PLAN>shouty</PROPOSED_PLAN>')).toBe('shouty');
  });

  it('preserves markdown inside the block verbatim', () => {
    const body = '## Tasks\n\n- [ ] one\n- [ ] two\n\n```ts\nconst a = 1;\n```';
    expect(extractProposedPlan(`<proposed_plan>\n${body}\n</proposed_plan>`)).toBe(body);
  });

  // The whole reason the pattern is a factory: a shared /g/ instance carries lastIndex between
  // callers, so the CLI's render loop and the daemon's extractor would corrupt each other's scan.
  it('hands out a fresh matcher each call so callers cannot share scan state', () => {
    const first = proposedPlanMatcher();
    first.exec('<proposed_plan>a</proposed_plan>');
    expect(first.lastIndex).toBeGreaterThan(0);
    expect(proposedPlanMatcher().lastIndex).toBe(0);
    expect(proposedPlanMatcher().exec('<proposed_plan>a</proposed_plan>')?.[1]).toBe('a');
  });

  it('detects a bare opening tag for a block still being streamed', () => {
    expect(proposedPlanOpenMatcher().test('<proposed_plan>half')).toBe(true);
    expect(proposedPlanOpenMatcher().test('no plan here')).toBe(false);
  });
});

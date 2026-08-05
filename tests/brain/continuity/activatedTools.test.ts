import { describe, it, expect } from 'vitest';
import { rollupActivatedTools } from '../../../src/brain/continuity/activatedTools.js';

/** A persisted ToolSearch toolResult row as the store holds it: the whole PI message in `content`. */
const searchRow = (matched: string[], isError = false) => ({
  content: JSON.stringify({ role: 'toolResult', toolName: 'ToolSearch', isError, details: { matched } }),
});

/** An earlier compaction divider, as this compaction would find it among the rows it is dropping. */
const dividerRow = (activatedTools: string[]) => ({
  content: JSON.stringify({ role: 'compactionSummary', content: 'summary', activatedTools }),
});

describe('continuity/activatedTools', () => {
  it('reports nothing when no dropped row activated a tool', () => {
    expect(rollupActivatedTools([])).toBeNull();
    expect(rollupActivatedTools([{ content: JSON.stringify({ role: 'assistant', content: 'hi' }) }])).toBeNull();
  });

  it('collects the names a ToolSearch result recorded', () => {
    expect(rollupActivatedTools([searchRow(['mcp__a__one', 'mcp__a__two'])]))
      .toEqual(['mcp__a__one', 'mcp__a__two']);
  });

  it('de-duplicates a tool activated more than once', () => {
    expect(rollupActivatedTools([searchRow(['mcp__a__one']), searchRow(['mcp__a__one'])]))
      .toEqual(['mcp__a__one']);
  });

  // A failed activation never put the tool in the active slice, so preserving it would re-advertise
  // something the model cannot actually call.
  it('ignores a failed ToolSearch result', () => {
    expect(rollupActivatedTools([searchRow(['mcp__a__one'], true)])).toBeNull();
  });

  // The case that makes this a chain rather than a snapshot: without it the SECOND compaction of a long
  // conversation erases everything the first one preserved, and the tool silently disappears.
  it('carries forward the names an earlier compaction divider already rolled up', () => {
    expect(rollupActivatedTools([dividerRow(['mcp__a__one']), searchRow(['mcp__b__two'])]))
      .toEqual(['mcp__a__one', 'mcp__b__two']);
  });

  it('survives a corrupt row without losing the rest', () => {
    expect(rollupActivatedTools([{ content: '{not json' }, searchRow(['mcp__a__one'])]))
      .toEqual(['mcp__a__one']);
  });

  it('ignores a result whose matched field is not a list of names', () => {
    const bad = { content: JSON.stringify({ role: 'toolResult', toolName: 'ToolSearch', details: { matched: 'one' } }) };
    expect(rollupActivatedTools([bad])).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { fromHistory, reduce, emptyView } from '../../lib/transcript';
import type { BrainMessage } from '../../lib/types';

// An attachment must look the same whether the bubble was drawn from the live stream or rebuilt from
// stored history after a reload — that equality IS the feature. These pin both sides of it.

const IMAGE = { url: '/brain/chat-images/1e2d3c4b-5a69-4788-9aab-bbccddeeff00.png', mimeType: 'image/png' };

describe('a user turn carries its attachments', () => {
  it('keeps them when the transcript is rebuilt from history', () => {
    const msgs: BrainMessage[] = [{ id: 'm1', role: 'user', text: 'mrkni', images: [IMAGE] }];
    const [turn] = fromHistory(msgs).turns;
    expect(turn).toMatchObject({ role: 'you', text: 'mrkni', images: [IMAGE] });
  });

  it('keeps them when the bubble arrives on the stream', () => {
    const view = reduce(emptyView(), { type: 'user', text: 'mrkni', durableId: 'm1', images: [IMAGE] });
    expect(view.turns[0]).toMatchObject({ role: 'you', text: 'mrkni', images: [IMAGE] });
  });

  it('renders the same turn either way, so a reload changes nothing on screen', () => {
    const live = reduce(emptyView(), { type: 'user', text: 'mrkni', durableId: 'm1', images: [IMAGE] }).turns[0];
    const reloaded = fromHistory([{ id: 'm1', role: 'user', text: 'mrkni', images: [IMAGE] }]).turns[0];
    expect(reloaded).toEqual(live);
  });

  it('keeps an attachment-only bubble, which has no text left to hold it', () => {
    const [turn] = fromHistory([{ id: 'm1', role: 'user', text: '', images: [IMAGE] }]).turns;
    expect(turn).toMatchObject({ role: 'you', images: [IMAGE] });
  });

  it('still drops a genuinely empty user row', () => {
    expect(fromHistory([{ id: 'm1', role: 'user', text: '   ' }]).turns).toEqual([]);
  });

  it('leaves a turn without attachments free of the field', () => {
    const [turn] = fromHistory([{ id: 'm1', role: 'user', text: 'jen text' }]).turns;
    expect(turn).toEqual({ role: 'you', text: 'jen text', id: 'm1' });
  });
});

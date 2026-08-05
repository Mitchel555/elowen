import { describe, it, expect } from 'vitest';
import {
  HISTORY_IMAGE_PLACEHOLDER,
  installHistoryImageStripping,
  stripHistoricalImages,
  type PiAgentMessage,
} from '../../../src/brain/session/historyImageStripping.js';

const user = (text: string, timestamp = 1): PiAgentMessage => ({
  role: 'user', content: [{ type: 'text', text }], timestamp,
});

const assistantToolCall = (name: string): PiAgentMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'call-1', name, arguments: {} }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'test-model',
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'toolUse', timestamp: 2,
});

type ToolResultContent = Extract<PiAgentMessage, { role: 'toolResult' }>['content'];
const toolResult = (
  toolName: string,
  content: ToolResultContent,
  timestamp = 3,
  toolCallId = 'call-1',
): PiAgentMessage => ({
  role: 'toolResult', toolCallId, toolName, content, isError: false, timestamp,
});

const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' } as const;
const placeholder = { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER };

describe('stripHistoricalImages', () => {
  it('replaces image blocks before the last user message, leaving text blocks untouched', () => {
    const messages: PiAgentMessage[] = [
      user('look at foo.png'),
      assistantToolCall('Read'),
      toolResult('Read', [{ type: 'text', text: 'Read image file [image/png]' }, image]),
      user('next'),
    ];
    const result = stripHistoricalImages(messages);
    expect(result[2]).toEqual({
      ...messages[2],
      content: [{ type: 'text', text: 'Read image file [image/png]' }, placeholder],
    });
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[3]).toBe(messages[3]);
  });

  it('keeps the real image for the current run (tool result after the last user message)', () => {
    // Turn 1's context: the freshly-read image follows the last user message → the model still sees it.
    const turn1: PiAgentMessage[] = [
      user('look at foo.png'),
      assistantToolCall('Read'),
      toolResult('Read', [{ type: 'text', text: 'Read image file [image/png]' }, image]),
    ];
    expect(stripHistoricalImages(turn1)).toBe(turn1);
    // The SAME tool result becomes a placeholder once a newer user turn exists (turn 3's context).
    const turn3 = stripHistoricalImages([...turn1, user('next')]);
    expect(turn3[2]).toEqual({ ...turn1[2], content: [{ type: 'text', text: 'Read image file [image/png]' }, placeholder] });
  });

  it('keeps a current image when a recalled-memory meta message follows the user turn', () => {
    const recalled = { ...user('recalled memory'), isMeta: true };
    const messages: PiAgentMessage[] = [
      user('look at foo.png'),
      assistantToolCall('Read'),
      toolResult('Read', [{ type: 'text', text: 'Read image file [image/png]' }, image]),
      recalled,
    ];

    const result = stripHistoricalImages(messages);
    expect(result).toBe(messages);
  });

  it('strips historical images from ANY source — a tool unknown to any shipped plugin', () => {
    // The global net: nothing here is MCP- or files-specific; a future plugin's image lands in a
    // toolResult content array exactly like this and is stripped the same way.
    const messages: PiAgentMessage[] = [
      user('run the gadget'),
      assistantToolCall('SomeFuturePluginTool'),
      toolResult('SomeFuturePluginTool', [{ type: 'image', data: 'BBBB', mimeType: 'image/webp' }]),
      user('and now?'),
    ];
    const result = stripHistoricalImages(messages);
    expect(result[2]).toEqual({ ...messages[2], content: [placeholder] });
  });

  it('strips images from historical user messages and collapses consecutive placeholders', () => {
    const messages: PiAgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'two shots' }, image, image], timestamp: 1 },
      user('next'),
    ];
    const result = stripHistoricalImages(messages);
    expect(result[0]).toEqual({ ...messages[0], content: [{ type: 'text', text: 'two shots' }, placeholder] });
  });

  it('is idempotent and does not mutate its input', () => {
    const original: PiAgentMessage[] = [
      user('look'),
      assistantToolCall('Read'),
      toolResult('Read', [image]),
      user('next'),
    ];
    const snapshot = structuredClone(original);
    const once = stripHistoricalImages(original);
    expect(original).toEqual(snapshot); // inputs untouched
    const twice = stripHistoricalImages(once);
    expect(twice).toBe(once); // second pass is a no-op returning the same reference
  });

  it('returns the input array unchanged when nothing needs stripping', () => {
    const messages: PiAgentMessage[] = [user('hello'), user('again')];
    expect(stripHistoricalImages(messages)).toBe(messages);
  });
});

describe('installHistoryImageStripping', () => {
  it('keeps historical images byte-identical while the cache is warm', async () => {
    const session: { agent: { transformContext?: (m: PiAgentMessage[]) => Promise<PiAgentMessage[]> } } = { agent: {} };
    installHistoryImageStripping(session, { idleMs: 60_000, now: () => 5_000 });
    const input: PiAgentMessage[] = [
      user('look', 1_000),
      toolResult('Read', [image], 2_000),
      user('next', 3_000),
    ];

    const transform = session.agent.transformContext;
    expect(transform).toBeDefined();
    const result = transform ? await transform(input) : [];
    expect(result).toBe(input);
    expect(result[1]).toBe(input[1]);
  });

  it('latches only images stripped on a cold turn and preserves the whole warm prefix', async () => {
    const session: { agent: { transformContext?: (m: PiAgentMessage[]) => Promise<PiAgentMessage[]> } } = { agent: {} };
    const idleMs = 60_000;
    installHistoryImageStripping(session, { idleMs, now: () => 100_000 });
    const laterImage = { type: 'image', data: 'BBBB', mimeType: 'image/png' } as const;
    const cold: PiAgentMessage[] = [
      user('one', 1_000),
      toolResult('Read', [image], 2_000, 'call-1'),
      user('two', 2_000 + idleMs + 1),
      toolResult('Read', [laterImage], 2_000 + idleMs + 2, 'call-2'),
    ];

    const transform = session.agent.transformContext;
    expect(transform).toBeDefined();
    const first = transform ? await transform(cold) : [];
    expect(first[1]).toEqual({ ...cold[1], content: [placeholder] });
    expect(first[3]).toBe(cold[3]);

    const warm = [...cold, user('three', 2_000 + idleMs + 3)];
    const second = transform ? await transform(warm) : [];
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(second[3]).toBe(cold[3]);
  });

  // A provider that refuses an image poisons the conversation: the image sits in the live history and
  // goes out with EVERY later request, so the turn fails forever. Waiting for the cold-cache gate means
  // waiting 61 minutes on the daemon's default long retention — an actively used conversation never gets
  // there. The rejection mark opens the gate on a warm turn instead, at the cost of one cache break.
  it('strips a refused image on a WARM turn once the provider has rejected one', async () => {
    const session: { agent: { transformContext?: (m: PiAgentMessage[]) => Promise<PiAgentMessage[]> } } = { agent: {} };
    installHistoryImageStripping(session, { idleMs: 60_000, now: () => 5_000, rejected: () => true });
    // Identical warm history to the test above (gap 1_000 ms ≪ idleMs), which is left untouched there.
    const input: PiAgentMessage[] = [
      user('look', 1_000),
      toolResult('Read', [image], 2_000),
      user('next', 3_000),
    ];

    const result = session.agent.transformContext ? await session.agent.transformContext(input) : [];
    expect(result[1]).toEqual({ ...input[1], content: [placeholder] });
  });

  // The mark must not make the conversation permanently image-blind: a NEW image attached after the
  // failure belongs to the current run and still has to reach the model.
  it('still delivers the current turn\'s fresh image after a rejection', async () => {
    const session: { agent: { transformContext?: (m: PiAgentMessage[]) => Promise<PiAgentMessage[]> } } = { agent: {} };
    installHistoryImageStripping(session, { idleMs: 60_000, now: () => 5_000, rejected: () => true });
    const fresh = { type: 'image', data: 'CCCC', mimeType: 'image/png' } as const;
    const input: PiAgentMessage[] = [
      user('look', 1_000),
      toolResult('Read', [image], 2_000),
      { role: 'user', content: [{ type: 'text', text: 'here is a good one' }, fresh], timestamp: 3_000 },
    ];

    const result = session.agent.transformContext ? await session.agent.transformContext(input) : [];
    expect(result[1]).toEqual({ ...input[1], content: [placeholder] }); // the poisoned one is gone
    expect(result[2]).toBe(input[2]);                                   // the fresh one still ships
  });

  it('composes with a pre-existing transformContext: previous hook runs first, then stripping', async () => {
    const calls: string[] = [];
    const injected = user('injected-by-previous-hook', 100);
    const session = {
      agent: {
        transformContext: async (messages: PiAgentMessage[]): Promise<PiAgentMessage[]> => {
          calls.push('previous');
          return [...messages, injected];
        },
      },
    };
    installHistoryImageStripping(session, { idleMs: 10, now: () => 100 });
    const input: PiAgentMessage[] = [user('look'), toolResult('Read', [image])];
    const result = await session.agent.transformContext(input);
    expect(calls).toEqual(['previous']);
    // The previous hook's appended user message is present (not clobbered) AND makes the tool result
    // historical, so its image is stripped from the composed output.
    expect(result[2]).toBe(injected);
    expect(result[1]).toEqual({ ...input[1], content: [placeholder] });
  });

  it('works when no previous transformContext exists', async () => {
    const session: { agent: { transformContext?: (m: PiAgentMessage[], s?: AbortSignal) => Promise<PiAgentMessage[]> } } = { agent: {} };
    installHistoryImageStripping(session, { idleMs: 10, now: () => 100 });
    const input: PiAgentMessage[] = [user('look'), toolResult('Read', [image]), user('next', 100)];
    const result = await session.agent.transformContext!(input);
    expect(result[1]).toEqual({ ...input[1], content: [placeholder] });
  });
});

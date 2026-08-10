import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
// Not on pi-ai's exports map, so reached by file path (a relative path bypasses the map). The adjacent
// .d.ts keeps this typed.
import { splitDeferredTools } from '../../../node_modules/@earendil-works/pi-ai/dist/utils/deferred-tools.js';
import type { Api, Context, Model, Tool, Usage } from '@earendil-works/pi-ai';
import { buildBrainRegistry, inMemoryModelRuntime, resolveBrainModel, type BrainRuntimeConfig } from '../../../src/brain/providers.js';

/** GPT-5.6 wire regression for native deferred-tool loading (OpenAI Tool Search).
 *
 *  pi-ai's openai-codex-responses adapter keeps a ToolSearch-activated deferred tool OUT of the top-level
 *  `tools` array and instead replays it into the request input as a `tool_search_call` +
 *  `tool_search_output` pair whose schema carries `defer_loading: true` — which is what keeps the cached
 *  tool prefix byte-stable across activations. Without `compat.supportsToolSearch` the same activation
 *  falls back to appending the schema to top-level `tools` (a cache-hostile prefix rewrite). Both branches
 *  are pinned here through pi-ai's REAL conversion path — the exact exported functions buildRequestBody
 *  composes — not a reimplementation; a source assertion below ties the mirrored call shape to the
 *  adapter so a pi-ai upgrade that changes the glue fails this file instead of silently drifting. */

const PI_AI_DIST = fileURLToPath(new URL('../../../node_modules/@earendil-works/pi-ai/dist/', import.meta.url));

/** Same value as the adapter's CODEX_TOOL_CALL_PROVIDERS (not exported; pinned by the source assertion). */
const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);

const zeroUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: Type.Object({ query: Type.String() }),
});

/** A conversation in which the model already activated the deferred `DiscordApi` via ToolSearch: the
 *  toolResult carries PI's recorded `addedToolNames`, the load point both native paths read. */
function contextAfterActivation(model: Model<Api>): Context {
  return {
    systemPrompt: 'sys',
    tools: [tool('ToolSearch'), tool('Read'), tool('DiscordApi')],
    messages: [
      { role: 'user', content: 'list the channels', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1|fc_1', name: 'ToolSearch', arguments: { query: 'select:DiscordApi' } }],
        api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage, stopReason: 'toolUse', timestamp: 2,
      },
      {
        role: 'toolResult', toolCallId: 'call_1|fc_1', toolName: 'ToolSearch',
        content: [{ type: 'text', text: 'Activated 1 tool(s): DiscordApi.' }],
        addedToolNames: ['DiscordApi'], isError: false, timestamp: 3,
      },
    ],
  };
}

/** The exact composition buildRequestBody performs for tools + input (openai-codex-responses.js:365):
 *  split on `model.compat.supportsToolSearch`, convert messages with the deferred map, convert only the
 *  immediate tools to the top level. */
function buildWirePlacement(model: Model<Api>, context: Context) {
  const compat = model.compat as { supportsToolSearch?: boolean; supportsStrictMode?: boolean } | undefined;
  const placement = splitDeferredTools(context, compat?.supportsToolSearch ?? false);
  const input = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    deferredTools: placement.deferred,
    toolOptions: { strict: null, supportsStrictMode: compat?.supportsStrictMode ?? true },
  }) as unknown as Record<string, unknown>[];
  const tools = convertResponsesTools(placement.immediate, {
    strict: null, supportsStrictMode: compat?.supportsStrictMode ?? true,
  }) as unknown as Record<string, unknown>[];
  return { input, tools };
}

const itemsOf = (input: Record<string, unknown>[], type: string) => input.filter((item) => item.type === type);
const toolNames = (tools: Record<string, unknown>[]) => tools.map((t) => t.name);

describe('openai-codex-responses deferred-tool wire (GPT-5.6)', () => {
  let model: Model<Api>;
  beforeAll(async () => {
    const cfg: BrainRuntimeConfig = { providers: [{
      id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '', models: ['gpt-5.6-sol'], apiKey: null,
    }] };
    const registry = buildBrainRegistry(cfg, await inMemoryModelRuntime());
    model = resolveBrainModel(registry, cfg, { provider: 'codex', model: 'gpt-5.6-sol' });
  });

  it('ships gpt-5.6 descriptors with compat.supportsToolSearch in the pinned catalog', () => {
    expect(model.api).toBe('openai-codex-responses');
    expect((model.compat as { supportsToolSearch?: boolean }).supportsToolSearch).toBe(true);
  });

  it('keeps an activated deferred tool OUT of top-level tools and replays it as tool_search items', () => {
    const { input, tools } = buildWirePlacement(model, contextAfterActivation(model));

    // (a) the activated tool is not in the top-level tools array — the cached tool prefix is unchanged.
    expect(toolNames(tools)).toEqual(expect.arrayContaining(['ToolSearch', 'Read']));
    expect(toolNames(tools)).not.toContain('DiscordApi');

    // (b) the request input carries the native tool_search_call/tool_search_output pair instead.
    const calls = itemsOf(input, 'tool_search_call');
    const outputs = itemsOf(input, 'tool_search_output');
    expect(calls).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(calls[0]?.call_id).toBe(outputs[0]?.call_id);

    // …appended AFTER the ToolSearch function_call_output, i.e. at the end of the context, where it does
    // not disturb any earlier cached span.
    const searchIndex = input.findIndex((item) => item.type === 'tool_search_call');
    const resultIndex = input.findIndex((item) => item.type === 'function_call_output');
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(searchIndex).toBeGreaterThan(resultIndex);

    // (c) the loaded schema itself is marked defer_loading so the API keeps it out of the cached prefix.
    const loaded = outputs[0]?.tools as Record<string, unknown>[];
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe('DiscordApi');
    expect(loaded[0]?.defer_loading).toBe(true);
  });

  it('falls back to top-level tools when the model lacks compat.supportsToolSearch', () => {
    const withoutFlag = {
      ...model,
      compat: { ...(model.compat as Record<string, unknown>), supportsToolSearch: undefined },
    } as Model<Api>;
    const { input, tools } = buildWirePlacement(withoutFlag, contextAfterActivation(withoutFlag));

    // (d) the activated tool lands in top-level tools — the cache-hostile branch the supportsToolSearch
    // warning in providers.ts exists to surface.
    expect(toolNames(tools)).toContain('DiscordApi');
    expect(itemsOf(input, 'tool_search_call')).toHaveLength(0);
    expect(itemsOf(input, 'tool_search_output')).toHaveLength(0);
    expect(tools.some((t) => t.defer_loading === true)).toBe(false);
  });

  it('mirrors the adapter glue it re-composes (source pin against pi-ai drift)', () => {
    const adapter = readFileSync(`${PI_AI_DIST}api/openai-codex-responses.js`, 'utf8');
    // buildRequestBody feeds the compat flag into the split and the deferred map into the conversion; if
    // either moves in a pi-ai upgrade, the placement mirrored above no longer matches what ships on the
    // wire and this file must be revisited.
    expect(adapter).toContain('splitDeferredTools(context, model.compat?.supportsToolSearch ?? false)');
    expect(adapter).toContain('deferredTools: toolPlacement.deferred');
    expect(adapter).toContain('CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"])');
  });
});

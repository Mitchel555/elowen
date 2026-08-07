#!/usr/bin/env node
// How much MAIN-THREAD work one provider request costs the daemon's prompt-cache monitor.
//
// Why this is measured separately from the fan-out harness: `createCachePayloadMonitor` is installed for
// ANTHROPIC sessions only (src/brain/session/factory.ts:306), and the harness drives an OpenAI-compatible
// scripted model — so nothing in the matrix exercises this path, while production's owner session does on
// every single request. The incident log has this exact subsystem (`brain-cache`) firing 60 s before the
// stall warning, so its cost has to be quantified rather than assumed.
//
// It calls the REAL built code through the real extension seam: `before_provider_request` with a payload
// of a given size, timed. No reimplementation.
//
//   node scripts/tests/subagent-load/cachewatch-cost.mjs

import { createCachePayloadMonitor } from '../../../dist/brain/session/cacheWatch.js';

/** A message array of roughly `targetBytes` of JSON, shaped like a real transcript: mostly big
 *  tool_result blocks with assistant text between them. */
function transcript(targetBytes) {
  const chunk = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(40);
  const messages = [];
  let bytes = 0;
  let i = 0;
  while (bytes < targetBytes) {
    i += 1;
    const big = i % 2 === 0;
    const text = big ? chunk.repeat(8) : `step ${i}: proceeding.`;
    messages.push(big
      ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text }] }] }
      : { role: 'assistant', content: [{ type: 'text', text }] });
    bytes += text.length + 120;
  }
  return { messages, bytes };
}

function tools(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `Tool${i}`,
    description: 'a tool description of roughly realistic length '.repeat(6),
    input_schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
  }));
}

function measure(label, payloadBytes, toolCount) {
  const { messages, bytes } = transcript(payloadBytes);
  const payload = { system: 'a system prompt '.repeat(500), tools: tools(toolCount), messages };
  const monitor = createCachePayloadMonitor();
  let fire = null;
  monitor.extension({ on: (name, fn) => { if (name === 'before_provider_request') fire = fn; } });
  if (!fire) throw new Error('the monitor did not register before_provider_request');

  fire({ payload }); // warm up V8 and the JSON path
  const runs = [];
  for (let i = 0; i < 12; i += 1) {
    const t0 = performance.now();
    fire({ payload });
    runs.push(performance.now() - t0);
    monitor.clearPending();
  }
  runs.sort((a, b) => a - b);
  console.log(`${label.padEnd(28)} messages=${String(messages.length).padStart(5)}  payload≈${(bytes / 1048576).toFixed(2)}MB  tools=${toolCount}  →  median ${runs[6].toFixed(1)}ms   worst ${runs.at(-1).toFixed(1)}ms`);
}

console.log('\nCost of ONE before_provider_request snapshot (main thread, synchronous):\n');
measure('small session', 64 * 1024, 60);
measure('~200k tokens (≈0.8MB)', 800 * 1024, 60);
measure('~200k tokens, 120 tools', 800 * 1024, 120);
measure('3MB transcript', 3 * 1024 * 1024, 60);
measure('8MB transcript', 8 * 1024 * 1024, 60);
console.log('\nNote: the monitor tracks at most 512 history segments and 256 tool segments, but `toolsHash`');
console.log('and `systemHash` hash the FULL arrays, and every tracked message is JSON.stringify-ed + SHA-256-ed.\n');

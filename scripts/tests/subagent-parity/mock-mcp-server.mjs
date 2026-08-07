#!/usr/bin/env node
// A scripted MCP server for the sub-agent parity harness — stdio transport, two tools, nothing else.
//
// Why hand-rolled instead of the MCP SDK's Server: the harness's whole point is to pin what the daemon
// bridges, so the fixture must not move when the SDK's defaults do. This speaks the two requests the
// `mcp` plugin actually issues (`initialize`, `tools/list`) plus `tools/call`, framed as the MCP stdio
// spec requires — one JSON-RPC message per line — and answers a fixed, hand-written tool list.
//
// Deterministic and offline by construction: no clock, no randomness, no network, no filesystem.

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';

// Non-trivial input schemas on purpose: the fingerprint exists to catch drift in what the model is shown,
// and an empty `{}` schema would still look identical after a schema-carrying refactor broke it.
const BASE_TOOLS = [
  {
    name: 'echo_text',
    title: 'Echo text',
    description: 'Echo a string back, optionally upper-cased. Deterministic parity fixture.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to echo back.' },
        upper: { type: 'boolean', description: 'Upper-case the echoed text.', default: false },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'sum_numbers',
    title: 'Sum numbers',
    description: 'Add a list of numbers and return the total. Deterministic parity fixture.',
    inputSchema: {
      type: 'object',
      properties: {
        numbers: { type: 'array', items: { type: 'number' }, description: 'Numbers to add together.' },
        label: { type: 'string', description: 'Optional label echoed with the result.' },
      },
      required: ['numbers'],
      additionalProperties: false,
    },
  },
];

// `--many` adds ten more tools, taking the server past the deferral threshold (11 deferrable tools;
// see src/brain/toolSearch/deferralPolicy.ts). PRODUCTION is this case — chrome-devtools alone bridges 29
// tools — and a deferred tool never reaches the wire `tools` array at all: it is advertised by name in the
// system prompt instead. Without a fixture above the threshold, the whole deferred path is untested.
// Generated from a fixed template rather than hand-written: they exist to be COUNTED, and ten
// copy-pasted blocks would only invite one of them to drift.
const PROBE_TOOLS = Array.from({ length: 10 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return {
    name: `probe_${n}`,
    title: `Probe ${n}`,
    description: `Return probe ${n}'s marker. Deterministic parity fixture for the deferred-tool path.`,
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: `Optional note echoed by probe ${n}.` } },
      additionalProperties: false,
    },
  };
});

const TOOLS = process.argv.includes('--many') ? [...BASE_TOOLS, ...PROBE_TOOLS] : BASE_TOOLS;

const text = (t) => ({ content: [{ type: 'text', text: t }], isError: false });

function callTool(name, args) {
  if (name === 'echo_text') {
    const value = String(args?.text ?? '');
    return text(args?.upper ? value.toUpperCase() : value);
  }
  if (name === 'sum_numbers') {
    const numbers = Array.isArray(args?.numbers) ? args.numbers.map(Number) : [];
    const total = numbers.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    return text(args?.label ? `${args.label}: ${total}` : String(total));
  }
  const probe = /^probe_(\d{2})$/.exec(String(name ?? ''));
  if (probe) return text(args?.note ? `probe ${probe[1]}: ${args.note}` : `probe ${probe[1]}`);
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
}

function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'parity-mock-mcp', version: '1.0.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(msg.params?.name, msg.params?.arguments ?? {});
    case 'ping':
      return {};
    default:
      return null; // unsupported → JSON-RPC "method not found", which the plugin treats as "not offered"
  }
}

const send = (payload) => { process.stdout.write(`${JSON.stringify(payload)}\n`); };

createInterface({ input: process.stdin }).on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  // A notification (no `id`, e.g. `notifications/initialized`) must never be answered.
  if (msg.id === undefined || msg.id === null) return;
  const result = handle(msg);
  if (result === null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  else send({ jsonrpc: '2.0', id: msg.id, result });
});

// The parent kills this process group on reload/teardown; nothing here should keep it alive on its own.
process.on('SIGTERM', () => process.exit(0));

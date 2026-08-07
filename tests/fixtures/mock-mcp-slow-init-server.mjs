// A scripted MCP stdio server whose `initialize` reply is delayed by $INIT_DELAY_MS — so a client is
// observably MID-HANDSHAKE for a controllable window. That window is what makes the bridge's single-flight
// lazy connect testable: without it, a second concurrent caller would be handed a client that has not
// finished initializing, and the SDK refuses `tools/call` until it knows the server's capabilities.
//
// Hand-rolled (not the SDK's Server) for the same reason as the parity fixture: it must not move when the
// SDK's defaults do. It speaks exactly what the `mcp` plugin issues — initialize, tools/list, tools/call.
//
// $SERVER_START_LOG, when set, gets ONE APPENDED LINE PER START, so a test can count launches.

import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const PROTOCOL_VERSION = '2024-11-05';
const initDelayMs = Math.max(0, Number(process.env.INIT_DELAY_MS) || 0);

const startLog = process.env.SERVER_START_LOG;
if (startLog) appendFileSync(startLog, `${process.pid}\n`);

const TOOLS = [{
  name: 'echo',
  title: 'Echo',
  description: 'Echo the text back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}];

const send = (payload) => { process.stdout.write(`${JSON.stringify(payload)}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      await sleep(initDelayMs);
      return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'slow-init-mcp', version: '1.0.0' } };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return { content: [{ type: 'text', text: String(msg.params?.arguments?.text ?? '') }], isError: false };
    case 'ping':
      return {};
    default:
      return null; // unsupported → JSON-RPC "method not found"
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // a notification is never answered
  void handle(msg).then((result) => {
    if (result === null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    else send({ jsonrpc: '2.0', id: msg.id, result });
  });
});

process.on('SIGTERM', () => process.exit(0));

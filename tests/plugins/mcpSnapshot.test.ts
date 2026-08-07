import { describe, it, expect } from 'vitest';
import { parseMcpBridgeSnapshot } from '../../src/plugins/mcpSnapshot.js';

/** The snapshot is what lets a forked sub-agent runner DECLARE the daemon's bridged MCP tools without
 *  connecting a single server. It crosses a process boundary, so it is parsed like every other frame in
 *  that protocol: refused when malformed, never coerced. A half-parsed snapshot would register a half tool
 *  set — and the tool set is the prompt-cache key, so that failure is silent and expensive. */
describe('parseMcpBridgeSnapshot', () => {
  it('carries exactly the four fields registerBridgedTool reads, schema verbatim', () => {
    const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
    expect(parseMcpBridgeSnapshot([
      { serverName: 'parity', tools: [{ name: 'echo_text', title: 'Echo', description: 'Echo it', inputSchema: schema }] },
    ])).toEqual([
      { serverName: 'parity', tools: [{ name: 'echo_text', title: 'Echo', description: 'Echo it', inputSchema: schema }] },
    ]);
  });

  it('drops nothing and adds nothing when the optional fields are absent', () => {
    // `description: undefined` and `description: ''` are NOT the same to registerBridgedTool: the first
    // falls back to the tool name, the second renders an empty description. Absent must stay absent.
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: [{ name: 't' }] }]))
      .toEqual([{ serverName: 's', tools: [{ name: 't' }] }]);
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: [{ name: 't', description: '' }] }]))
      .toEqual([{ serverName: 's', tools: [{ name: 't', description: '' }] }]);
  });

  it('accepts an empty snapshot — "this daemon bridges nothing" is a real answer', () => {
    expect(parseMcpBridgeSnapshot([])).toEqual([]);
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: [] }])).toEqual([{ serverName: 's', tools: [] }]);
  });

  it('refuses the WHOLE snapshot when any part of it is malformed', () => {
    expect(parseMcpBridgeSnapshot(undefined)).toBeUndefined();
    expect(parseMcpBridgeSnapshot({ serverName: 's', tools: [] })).toBeUndefined(); // not an array
    expect(parseMcpBridgeSnapshot([{ tools: [] }])).toBeUndefined(); // no server name
    expect(parseMcpBridgeSnapshot([{ serverName: '', tools: [] }])).toBeUndefined(); // empty server name
    expect(parseMcpBridgeSnapshot([{ serverName: 's' }])).toBeUndefined(); // no tool array
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: {} }])).toBeUndefined();
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: [{ title: 'no name' }] }])).toBeUndefined();
    // One bad tool rejects the lot rather than registering the good ones — a PARTIAL tool set is exactly
    // the silent drift this parser exists to prevent.
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: [{ name: 'ok' }, { name: 7 }] }])).toBeUndefined();
  });

  it('ignores fields of the wrong type instead of handing them to defineTool', () => {
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: [{ name: 't', title: 5, description: [], inputSchema: 'x' }] }]))
      .toEqual([{ serverName: 's', tools: [{ name: 't' }] }]);
    // An array is an object in JS but never a JSON Schema — it must not reach Type.Unsafe.
    expect(parseMcpBridgeSnapshot([{ serverName: 's', tools: [{ name: 't', inputSchema: [1, 2] }] }]))
      .toEqual([{ serverName: 's', tools: [{ name: 't' }] }]);
  });
});

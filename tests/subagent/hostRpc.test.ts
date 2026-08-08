import { afterEach, describe, expect, it } from 'vitest';
import { HostRpcClient, WORKFLOW_ADD_NODES_RPC } from '../../src/subagent/hostRpc.js';

const originalTimeout = process.env.ELOWEN_SUBAGENT_HOST_RPC_TIMEOUT_MS;
afterEach(() => {
  if (originalTimeout === undefined) delete process.env.ELOWEN_SUBAGENT_HOST_RPC_TIMEOUT_MS;
  else process.env.ELOWEN_SUBAGENT_HOST_RPC_TIMEOUT_MS = originalTimeout;
});

const request = { method: WORKFLOW_ADD_NODES_RPC, workflowId: 'wf-1', nodes: [] } as const;

describe('HostRpcClient', () => {
  it('correlates out-of-order answers and rejects every pending call when the daemon channel dies', async () => {
    const sent: { callId: string }[] = [];
    let nextId = 0;
    const client = new HostRpcClient((message) => { sent.push(message); return true; }, () => `rpc-${++nextId}`, 1_000);
    const first = client.call('turn-1', request);
    const second = client.call('turn-2', request);

    client.settle('rpc-2', { added: ['second'] });
    await expect(second).resolves.toEqual({ added: ['second'] });
    client.close('daemon gone');
    await expect(first).rejects.toThrow('daemon gone');
    expect(sent.map((message) => message.callId)).toEqual(['rpc-1', 'rpc-2']);
  });

  it('rejects immediately when the IPC send cannot be made', async () => {
    const client = new HostRpcClient(() => false, () => 'rpc-closed', 1_000);
    await expect(client.call('turn-1', request)).rejects.toThrow('closed before the host RPC was sent');
  });

  it('times out with real time when a live daemon never answers', async () => {
    process.env.ELOWEN_SUBAGENT_HOST_RPC_TIMEOUT_MS = '15';
    const client = new HostRpcClient(() => true, () => 'rpc-timeout');
    await expect(client.call('turn-1', request)).rejects.toThrow('within 15ms');
  });
});

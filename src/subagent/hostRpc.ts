export const WORKFLOW_ADD_NODES_RPC = 'workflow.addNodes' as const;

/** The workflow node declaration stays opaque at the transport boundary. The daemon-side workflow engine
 * owns normalization, cycle checks and every field-level diagnostic; accepting only an array here prevents
 * malformed IPC from escaping the RPC envelope without turning the runner into a second validator. */
interface WorkflowAddNodesRpcRequest {
  method: typeof WORKFLOW_ADD_NODES_RPC;
  workflowId: string;
  nodes: unknown[];
}

export interface WorkflowAddNodesRpcResult { added: string[] }

export type HostRpcRequest = WorkflowAddNodesRpcRequest;
export type HostRpcResult = WorkflowAddNodesRpcResult;
export type HostRpcMethod = HostRpcRequest['method'];

export interface WorkflowExpansionRpc {
  addNodes(input: { workflowId: string; nodes: unknown[] }): Promise<WorkflowAddNodesRpcResult>;
}

/** Authorization facts the daemon derives from its own pending-turn table. None comes from the runner's
 * RPC payload. `isActive` must be rechecked after any async lookup and immediately before mutation. */
interface HostRpcCaller {
  sessionId: string;
  access: import('../brain/delegatedScope.js').DelegatedExecutionScope;
  model?: { provider?: string; model?: string; thinkingLevel?: string };
  isActive(): boolean;
}

export type HostRpcHandler = (caller: HostRpcCaller, request: HostRpcRequest) => Promise<HostRpcResult>;

export function parseHostRpcRequest(raw: unknown): HostRpcRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.method !== WORKFLOW_ADD_NODES_RPC || typeof value.workflowId !== 'string' || !value.workflowId || !Array.isArray(value.nodes)) {
    return undefined;
  }
  return { method: WORKFLOW_ADD_NODES_RPC, workflowId: value.workflowId, nodes: value.nodes };
}

export function parseHostRpcResult(raw: unknown): HostRpcResult | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.added) || value.added.some((id) => typeof id !== 'string')) return undefined;
  return { added: value.added as string[] };
}

interface PendingCall {
  resolve: (result: HostRpcResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_HOST_RPC_TIMEOUT_MS = 15_000;

function hostRpcTimeoutMs(): number {
  const configured = Number(process.env.ELOWEN_SUBAGENT_HOST_RPC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_HOST_RPC_TIMEOUT_MS;
}

/** Correlates runner→daemon requests exactly once and gives every request a terminal path. The caller owns
 * the wire parser; this class owns only request ids, timeout and channel-close settlement. */
export class HostRpcClient {
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly send: (message: { type: 'hostCall'; callId: string; turnId: string; request: HostRpcRequest }) => boolean,
    private readonly makeId: () => string,
    private readonly timeoutMs = hostRpcTimeoutMs(),
  ) {}

  call(turnId: string, request: HostRpcRequest): Promise<HostRpcResult> {
    const callId = this.makeId();
    return new Promise<HostRpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`the daemon did not answer the sub-agent host RPC within ${this.timeoutMs}ms; the outcome is unknown, inspect WorkflowStatus before retrying`));
      }, this.timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
      if (!this.send({ type: 'hostCall', callId, turnId, request })) {
        this.settleError(callId, 'the daemon IPC channel closed before the host RPC was sent');
      }
    });
  }

  settle(callId: string, result: HostRpcResult): void {
    const call = this.pending.get(callId);
    if (!call) return;
    this.pending.delete(callId);
    clearTimeout(call.timer);
    call.resolve(result);
  }

  settleError(callId: string, message: string): void {
    const call = this.pending.get(callId);
    if (!call) return;
    this.pending.delete(callId);
    clearTimeout(call.timer);
    call.reject(new Error(message));
  }

  close(message = 'the daemon IPC channel closed during the host RPC'): void {
    for (const callId of [...this.pending.keys()]) this.settleError(callId, message);
  }
}

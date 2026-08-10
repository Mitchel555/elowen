import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { PermissionApprovalService } from '../../src/brain/service/permissionApproval.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-recovery';
const TOOL_CALL = 'call-recovery';

function harness() {
  const store = new BrainStore(openDb(':memory:'));
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const elicitation = new ElicitationRegistry();
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    goals: { cancelGoalContinuation: () => {} } as unknown as ConstructorParameters<typeof ConversationLifecycle>[0]['goals'],
    spawn: () => Promise.reject(new Error('no spawn in this harness')),
    selectionAllowed: () => true,
  });
  const status = new BrainStatusService({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    cards: new CardRegistry(),
    lifecycle,
    permissions: new PermissionApprovalService({ elicitation }),
    config: undefined,
    runtime: undefined as unknown as ConstructorParameters<typeof BrainStatusService>[0]['runtime'],
  });
  store.createSession({ id: PARENT, userId: 1, model: 'm' });
  store.createSession({
    id: CHILD,
    userId: 1,
    model: 'm',
    parentSessionId: PARENT,
    delegatedAccess: { admin: true, owner: true, projectIds: [], permissionBoundary: null },
  });
  store.appendMessage({
    id: 'assistant-delegate',
    sessionId: PARENT,
    parentId: null,
    role: 'assistant',
    content: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: TOOL_CALL, name: 'Delegate', arguments: { task: 'recover me' } }],
    },
  });
  return { store, sessions, status };
}

function projectedSubagent(status: BrainStatusService) {
  const assistant = status.messagesOf(1, PARENT).find((message) => message.role === 'assistant');
  const tool = assistant?.segments?.find((segment) => segment.kind === 'tool');
  return tool?.kind === 'tool' ? tool.sub : undefined;
}

describe('sub-agent recovery status projection', () => {
  it('shows a boot-claimed recovery as running before its child turn registers live', () => {
    const { store, status } = harness();
    store.setDelegationBootId('boot-old');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL,
      sessionId: CHILD,
      status: 'running',
      task: 'recover me',
      tools: 2,
      seconds: 10,
      background: true,
      autoDeliver: true,
    })).toBe(true);

    store.setDelegationBootId('boot-new');
    expect(store.claimRecoverableRuns(30_000)).toHaveLength(1);

    expect(projectedSubagent(status)).toMatchObject({ sessionId: CHILD, status: 'running', task: 'recover me' });
  });

  it('still hides an unclaimed stale running row with no live child', () => {
    const { store, status } = harness();
    store.setDelegationBootId('boot-current');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL,
      sessionId: CHILD,
      status: 'running',
      task: 'stale',
      tools: 0,
      seconds: 1,
    })).toBe(true);

    expect(projectedSubagent(status)).toBeUndefined();
  });
});

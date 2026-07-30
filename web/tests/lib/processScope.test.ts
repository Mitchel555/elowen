import { describe, it, expect } from 'vitest';
import { ownedSessionIds, isOwnProcess } from '../../lib/processScope';
import type { ProcessInfo } from '../../lib/types';
import type { SubagentState } from '../../lib/transcript';

const proc = (sessionId: string | null): ProcessInfo => ({
  id: 'p', command: 'npm run dev', cwd: '/w', startedAt: '2026-01-01T00:00:00Z', sessionId, running: true, exitCode: null,
});
const agent = (sessionId: string): SubagentState => ({ sessionId, status: 'running', task: 'build', tools: 0, seconds: 1 });

describe('processScope', () => {
  it('owns the job a delegated sub-agent started, not just the conversation own', () => {
    const owned = ownedSessionIds('brain-1', [agent('brain-ch-subagent-sub-dlg-9')]);

    // The child runs under its own session id, but the work is the parent conversation's.
    expect(isOwnProcess(proc('brain-ch-subagent-sub-dlg-9'), owned)).toBe(true);
    expect(isOwnProcess(proc('brain-1'), owned)).toBe(true);
  });

  it('does not own another conversation or a channel session', () => {
    const owned = ownedSessionIds('brain-1', [agent('brain-ch-subagent-sub-dlg-9')]);

    expect(isOwnProcess(proc('brain-7'), owned)).toBe(false);
    expect(isOwnProcess(proc('brain-ch-discord-42'), owned)).toBe(false);
    // A sub-agent of a DIFFERENT conversation is not ours either.
    expect(isOwnProcess(proc('brain-ch-subagent-sub-dlg-1'), owned)).toBe(false);
  });

  it('never owns a session-less process, even with no conversation open', () => {
    // Guards the regression a plain `p.sessionId === activeSessionId` comparison would reintroduce:
    // null === null would make every owner-wide orphan look local to a conversation that has no session.
    const owned = ownedSessionIds(null, []);

    expect(isOwnProcess(proc(null), owned)).toBe(false);
    expect(isOwnProcess(proc(null), ownedSessionIds('brain-1', []))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSubagentSession, isChannelSession, subagentSessionId, SUBAGENT_PLATFORM } from '../../src/brain/sessionId.js';

/** The daemon decides what a session IS from its id prefix — live memory recall is gated on it
 *  (`liveRecallAllowed`), the delegation listing filters on it, and a pool would route on it. But the
 *  channelId half of that id is minted inside the subagent plugin, which cannot import from src/. So the
 *  invariant "everything the plugin mints is recognised as a sub-agent session" has no compiler holding
 *  it up, and a rename on either side would fail silently rather than loudly.
 *
 *  These tests read the plugin's own source and check the shapes it mints against the daemon predicate,
 *  the same way lifecycleMessageParity and cronParity pin their two sides together. */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
const delegate = read('../../plugins/subagent/index.mjs');
const workflow = read('../../plugins/subagent/lib/workflow.mjs');

describe('sub-agent session id parity', () => {
  it('registers the platform under exactly the name the prefix is derived from', () => {
    // `keyOf` builds `<platform>-<channelId>`, so the platform name IS half the prefix.
    expect(delegate).toContain(`name: '${SUBAGENT_PLATFORM}'`);
    expect(delegate).toContain(`platform: '${SUBAGENT_PLATFORM}'`);
    expect(workflow).toContain(`platform: '${SUBAGENT_PLATFORM}'`);
  });

  it('mints delegate channel ids the daemon recognises as sub-agent sessions', () => {
    const minted = /const channelId = `([^`]+)`/.exec(delegate);
    expect(minted, 'delegate channelId minting moved — update this parity test with it').toBeTruthy();
    // Substitute the template holes with a realistic value; the PREFIX is what the predicate reads.
    const channelId = minted![1].replace(/\$\{[^}]+\}/g, 'dlg-1e2d3c4b-0000-4000-8000-000000000000');
    expect(isSubagentSession(subagentSessionId(channelId))).toBe(true);
  });

  it('mints workflow node channel ids the daemon recognises as sub-agent sessions', () => {
    const minted = /const channelId = ns\.channelId \|\| `([^`]+)`/.exec(workflow);
    expect(minted, 'workflow channelId minting moved — update this parity test with it').toBeTruthy();
    const channelId = minted![1].replace(/\$\{[^}]+\}/g, 'wfnode');
    expect(isSubagentSession(subagentSessionId(channelId))).toBe(true);
  });

  it('keeps sub-agent sessions inside the channel family, so channel-wide gates still cover them', () => {
    const id = subagentSessionId('sub-dlg-1');
    expect(isChannelSession(id)).toBe(true);
    // A plain channel session must NOT be mistaken for a delegated one.
    expect(isSubagentSession('brain-ch-discord-123')).toBe(false);
  });
});

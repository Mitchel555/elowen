import { describe, it, expect } from 'vitest';
import { cliEnvFor } from '../../src/cli/index.js';
import { NeedsLogin, resolveToken, type TokenIo } from '../../src/cli/chat/token.js';

// Every task verb authenticates with ONE credential, resolved env-then-cache. Reading only the env is why
// `elowen ls|ready|api` answered a bare 401 to a human who had signed in long ago: the token `elowen login`
// cached was never consulted outside the chat path.

/** A cache holding `token`, or an empty one when it is null. Nothing here touches the real filesystem. */
function fakeIo(token: string | null): TokenIo {
  return {
    read: () => (token === null ? null : JSON.stringify({ token })),
    write: () => {},
    remove: () => {},
  };
}

const viaCache = (token: string | null) => (e: NodeJS.ProcessEnv) => resolveToken(e, fakeIo(token));

describe('cliEnvFor', () => {
  it('hands a task verb the cached token when the env carries none', () => {
    const env = cliEnvFor('ls', {} as NodeJS.ProcessEnv, viaCache('cached-tok'));
    expect(env.ELOWEN_TOKEN).toBe('cached-tok');
  });

  it('leaves a spawned agent on the token the daemon injected', () => {
    // The agent path must not change: env wins over the cache, so an agent keeps its own credential
    // (post-0.27.79 that token is scoped to its task — falling back to a cached admin token would hand
    // it strictly more authority than it was spawned with).
    const env = cliEnvFor('close', { ELOWEN_TOKEN: 'agent-tok' } as NodeJS.ProcessEnv, viaCache('cached-tok'));
    expect(env.ELOWEN_TOKEN).toBe('agent-tok');
  });

  it('reports that a signed-out human must log in, instead of letting them meet a 401', () => {
    expect(() => cliEnvFor('api', {} as NodeJS.ProcessEnv, viaCache(null))).toThrow(NeedsLogin);
    expect(() => cliEnvFor('api', {} as NodeJS.ProcessEnv, viaCache(null))).toThrow(/elowen login/);
  });

  it('never blocks `login` on already having a token', () => {
    // login is itself an API command, so gating it on a resolved credential would make the one command
    // that OBTAINS a credential impossible to run without one.
    const env = cliEnvFor('login', {} as NodeJS.ProcessEnv, () => { throw new NeedsLogin(); });
    expect(env.ELOWEN_TOKEN).toBeUndefined();
  });

  it('leaves `chat` to its own token flow', () => {
    const env = cliEnvFor('chat', {} as NodeJS.ProcessEnv, () => { throw new NeedsLogin(); });
    expect(env.ELOWEN_TOKEN).toBeUndefined();
  });

  it('does not mutate the caller-supplied env', () => {
    const original = {} as NodeJS.ProcessEnv;
    cliEnvFor('ready', original, viaCache('cached-tok'));
    expect(original.ELOWEN_TOKEN).toBeUndefined();
  });
});

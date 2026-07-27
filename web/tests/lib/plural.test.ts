import { describe, it, expect } from 'vitest';
import { plural } from '../../lib/i18n/plural';
import { cs } from '../../lib/i18n/dictionaries/cs';
import { sk } from '../../lib/i18n/dictionaries/sk';
import { en } from '../../lib/i18n/dictionaries/en';

describe('plural', () => {
  it('picks the Czech one/few/many forms', () => {
    expect(plural(cs.agents.link, 1)).toBe('agent');
    expect(plural(cs.agents.link, 2)).toBe('agenti');
    expect(plural(cs.agents.link, 4)).toBe('agenti');
    expect(plural(cs.agents.link, 5)).toBe('agentů');
    expect(plural(cs.agents.link, 0)).toBe('agentů');
  });

  it('picks the Slovak forms', () => {
    expect(plural(sk.agents.link, 1)).toBe('agent');
    expect(plural(sk.agents.link, 3)).toBe('agenti');
    expect(plural(sk.agents.link, 9)).toBe('agentov');
    expect(plural(sk.agents.link, 0)).toBe('agentov');
  });

  it('collapses to the single English plural', () => {
    expect(plural(en.agents.link, 1)).toBe('agent');
    expect(plural(en.agents.link, 2)).toBe('agents');
    expect(plural(en.agents.link, 7)).toBe('agents');
    expect(plural(en.agents.link, 0)).toBe('agents');
  });
});

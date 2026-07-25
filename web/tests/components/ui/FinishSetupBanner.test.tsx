import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FinishSetupBanner } from '../../../components/ui/FinishSetupBanner';
import type { SystemReadiness } from '../../../lib/types';
import { createWrapper } from '../../test-utils';

function mount(readiness: unknown, isAdmin = true) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: isAdmin } });
  if (readiness !== undefined) client.setQueryData(['system-readiness'], readiness);
  return render(<Wrapper><FinishSetupBanner /></Wrapper>);
}

const withChat = (ok: boolean): SystemReadiness => ({
  checks: [{ id: 'chat', label: 'Chat', ok, detail: ok ? 'ready' : 'no provider' }],
});

describe('FinishSetupBanner', () => {
  it('nudges the owner once readiness reports chat is not ready', () => {
    mount(withChat(false));
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('stays away once chat is ready', () => {
    mount(withChat(true));
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('stays away while readiness is still unknown', () => {
    mount(undefined);
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  // A readiness answer that does not carry the array at all — an older or misconfigured daemon, a proxy
  // error body, a stub that answers 200 with something else. The nudge is optional; the page it lives on
  // is not, so an unexpected shape must leave the banner silent rather than take the dashboard down.
  it('survives a readiness payload with no checks at all', () => {
    expect(() => mount([])).not.toThrow();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('is not shown to non-admins, who cannot act on it', () => {
    mount(withChat(false), false);
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });
});

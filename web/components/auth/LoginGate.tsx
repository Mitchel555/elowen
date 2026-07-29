'use client';
// Auth gate. The session lives in an httpOnly cookie the browser JS can't read, so we probe it with
// `me()` on mount: it succeeds → open the shell; a 401 → no/invalid session, fall through to
// setup-or-login. ANY later 401 fires AUTH_CLEARED_EVENT, which flips us straight to the login form
// and drops cached data — so a stale/expired/deleted-user session can't strand the user in a broken shell.
//
// While the session query is in flight the children (the app shell) ALREADY render: their queries race
// it instead of waiting for it, so the dashboard fills progressively rather than in a two-stage waterfall.
// That is safe because a child only ever renders data its own authenticated fetch returned — an
// unauthenticated visitor sees chrome and skeletons for a beat, every child query 401s, and the first
// 401 flips the gate to the login form (the same end state the probe would reach).
//
// The gate reads the session through the SAME useMe() query the rest of the app uses, rather than
// fetching /auth/me itself and seeding the result. Seeding cannot win the race now that children mount
// immediately: their useMe() fires on the same tick as the gate's own probe, so the app would ask twice.
// Sharing one query key makes the duplicate structurally impossible instead of merely unlikely.
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_CLEARED_EVENT } from '../../lib/token';
import { elowenClient, ElowenApiError } from '../../lib/elowenClient';
import { useMe } from '../../lib/queries';
import { EventBridge } from '../../app/providers';
import { LoginForm } from './LoginForm';

type Gate = 'checking' | 'login' | 'open';

export function LoginGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>('checking');
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const me = useMe();
  const meSettled = !me.isPending;
  const meFailed = me.error;

  useEffect(() => {
    if (!meSettled) return;
    // The session query answers the gate: data means the httpOnly cookie is a valid session → open the
    // shell. A 401 means no/invalid session → a brand-new install (no users yet) shows onboarding without
    // a login, otherwise the login form. A transient/network error is treated as "not authed" so we show
    // login rather than a blank gate.
    if (!meFailed) { setGate('open'); return; }
    const status = meFailed instanceof ElowenApiError ? meFailed.status : undefined;
    if (status !== 401) { setGate('login'); return; }
    let alive = true;
    elowenClient.setupStatus()
      .then((s) => {
        if (!alive) return;
        if (s.needsSetup) { setGate('open'); if (pathname !== '/onboarding') router.replace('/onboarding'); }
        else setGate('login');
      })
      .catch(() => { if (alive) setGate('login'); });
    return () => { alive = false; };
  }, [meSettled, meFailed, pathname, router]);

  // Token dropped (stale-token validation 401, mid-session 401, or explicit logout): go to login with
  // no reload, and clear the cache so a re-login can never flash the previous user's data.
  useEffect(() => {
    const onCleared = () => { qc.clear(); setGate('login'); };
    window.addEventListener(AUTH_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(AUTH_CLEARED_EVENT, onCleared);
  }, [qc]);

  // The login form REPLACES the shell (an unauthenticated visitor must not reach the app), but the
  // 'checking' state renders children so the shell and its query fan-out start immediately.
  if (gate === 'login') return <LoginForm onAuthed={() => setGate('open')} />;

  return (
    <>
      {/* The SSE bridge stays gated on a confirmed session: mounted tokenless it would 401 once and
          EventSource has no hook to reconnect after login. */}
      {gate === 'open' ? <EventBridge /> : null}
      {children}
    </>
  );
}

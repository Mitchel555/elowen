'use client';
import { useEffect, useState } from 'react';
import { BASE } from './elowenClient';
import { createReconnectController } from './reconnect';
import { subscribeRevive, STALE_HIDE_MS } from './useRevive';

// Dedupe seam: identical idle frames must not churn React state (the backend
// resends full snapshots on an interval). Returns the previous reference when
// the next frame equals it, so setState is a no-op.
export function nextPane(prev: string, next: string): string {
  return prev === next ? prev : next;
}

export function useSessionStream(name: string): string {
  const [pane, setPane] = useState('');
  useEffect(() => {
    let es: EventSource | null = null;
    const onPane = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as { pane: string };
        setPane((prev) => nextPane(prev, parsed.pane));
      } catch { /* malformed frame — skip, keep the stream alive */ }
    };
    // Same-origin SSE through the /api proxy; the httpOnly session cookie rides along via credentials.
    // Every frame is a FULL pane snapshot that replaces the previous one, so reopening the stream can
    // never duplicate content — the first frame of the new connection is the whole truth again.
    function connect(): void {
      es?.close();
      es = new EventSource(`${BASE}/sessions/${encodeURIComponent(name)}/stream`, { withCredentials: true });
      es.addEventListener('pane', onPane as EventListener);
      es.onopen = () => reconnect.succeeded();
      // On a terminal failure (readyState CLOSED) close and retry with backoff — do NOT clear the auth
      // token here. The EventSource API can't distinguish a 401 from a benign drop (proxy/SSE timeout,
      // daemon restart, hard-reload race), so clearing it would log the user out spuriously. Real auth
      // expiry is handled by the regular request path; the backoff is what avoids a retry storm.
      es.onerror = () => {
        if (!es || es.readyState !== EventSource.CLOSED) return;
        es.close();
        reconnect.retry();
      };
    }

    const reconnect = createReconnectController(connect);
    connect();
    const offRevive = subscribeRevive(({ hiddenMs }) => {
      if (es?.readyState === EventSource.OPEN && hiddenMs <= STALE_HIDE_MS) return;
      reconnect.now();
    });
    return () => { offRevive(); reconnect.stop(); es?.close(); };
  }, [name]);
  return pane;
}

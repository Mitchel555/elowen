'use client';
import { useEffect, useRef, useState } from 'react';
import { elowenClient, terminalWsUrl } from './elowenClient';
import { createReconnectController } from './reconnect';
import { subscribeRevive, STALE_HIDE_MS } from './useRevive';

type StreamStatus = 'connecting' | 'open' | 'unsupported' | 'reconnecting';

/** Close code the daemon uses to say "no PTY stream — fall back to snapshot" (bad ticket or node-pty
 *  missing). Must match `UNSUPPORTED_CLOSE` in `src/terminal/wsHandler.ts`. */
const UNSUPPORTED_CLOSE = 4001;

/** The WS reachability config is stable per deployment, so fetch it once and share the promise across
 *  every terminal. A failed fetch degrades to same-origin (directPort null) — the proxy/localhost path. */
let wsConfigPromise: Promise<{ directPort: number | null }> | null = null;
function getWsConfig(): Promise<{ directPort: number | null }> {
  if (!wsConfigPromise) wsConfigPromise = elowenClient.wsConfig().catch(() => ({ directPort: null }));
  return wsConfigPromise;
}

export interface TerminalStream {
  status: StreamStatus;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

/** Open a terminal PTY stream over a WebSocket: mint a single-use ticket via the BFF, connect straight
 *  to the daemon's `/ws/terminal`, and push raw bytes to `onData`. A socket that never reached `open` —
 *  bad ticket, the 4001 close, no WS-capable proxy in front of the daemon — flips the status to
 *  `unsupported` so the caller can render the snapshot fallback. A socket that dies AFTER a healthy open
 *  is a dropped connection, not a broken deployment, so it is reconnected with backoff (a fresh ticket
 *  each time — they are single use). `onData` is held in a ref so changing it never reconnects. */
export function useTerminalStream(name: string, enabled: boolean, onData: (bytes: string) => void): TerminalStream {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let everOpen = false;
    const unsupported = (): void => { setStatus('unsupported'); reconnect.stop(); };

    function connect(): Promise<void> {
      // Drop the previous socket's handlers before replacing it, or its late `close` would report the
      // successor as broken.
      if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); }
      return Promise.all([elowenClient.wsTicket(name), getWsConfig()])
        .then(([{ ticket }, { directPort }]) => {
          if (cancelled) return;
          ws = new WebSocket(terminalWsUrl(ticket, directPort));
          wsRef.current = ws;
          ws.onopen = () => {
            if (cancelled) return;
            everOpen = true;
            reconnect.succeeded();
            setStatus('open');
          };
          ws.onmessage = (e: MessageEvent) => { if (typeof e.data === 'string') onDataRef.current(e.data); };
          // `error` carries no detail; the `close` that always follows it does, so decide there.
          ws.onerror = () => { if (!cancelled && !everOpen) unsupported(); };
          ws.onclose = (e: CloseEvent) => {
            if (cancelled) return;
            if (e.code === UNSUPPORTED_CLOSE || !everOpen) { unsupported(); return; }
            setStatus('reconnecting');
            reconnect.retry();
          };
        })
        .catch(() => {
          if (cancelled) return;
          // Before the first successful open, a failed mint means there is no usable stream here at all.
          // Afterwards it is just the daemon being briefly away — rethrow so the controller backs off.
          if (!everOpen) { unsupported(); return; }
          setStatus('reconnecting');
          throw new Error('terminal ticket unavailable');
        });
    }

    const reconnect = createReconnectController(connect);
    setStatus('connecting');
    void connect();
    const offRevive = subscribeRevive(({ hiddenMs }) => {
      if (cancelled) return;
      if (ws?.readyState === WebSocket.OPEN && hiddenMs <= STALE_HIDE_MS) return;
      reconnect.now();
    });

    return () => { cancelled = true; offRevive(); reconnect.stop(); ws?.close(); wsRef.current = null; };
  }, [name, enabled]);

  const send = (data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  const resize = (cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  };
  return { status, send, resize };
}

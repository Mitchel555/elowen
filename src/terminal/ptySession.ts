import type { PtyModule, IPty } from './ptyLoader.js';

/** A live PTY attached to a tmux session. The browser's xterm bytes flow in via `write`, the pane's
 *  raw output flows out via `onData` — a true terminal, cursor and all, not a capture-pane snapshot. */
export interface PtySession {
  onData(cb: (d: string) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** A UTF-8 character map for the attached pane, whatever the daemon happened to be launched with.
 *  Nothing declares a locale for the service — the unit sets only ELOWEN_* and PATH — so today's
 *  LANG=C.UTF-8 arrives by inheritance from systemd's default environment. Where that is absent the
 *  pane falls back to the ASCII map, and every accented character is stripped or escaped before it
 *  reaches the browser. A session that already has a UTF-8 locale keeps it, national ones included:
 *  only a non-UTF-8 map is corrected, and LC_ALL/LC_CTYPE have to go with it because either one
 *  outranks LANG. */
function utf8Locale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isUtf8 = (v: string | undefined): boolean => /utf-?8$/i.test(v ?? '');
  if (isUtf8(env.LC_ALL) || (env.LC_ALL === undefined && isUtf8(env.LC_CTYPE))
    || (env.LC_ALL === undefined && env.LC_CTYPE === undefined && isUtf8(env.LANG))) return env;
  const { LC_ALL: _all, LC_CTYPE: _ctype, ...rest } = env;
  return { ...rest, LANG: 'C.UTF-8' };
}

/** Attach a PTY to an existing tmux session via `tmux attach`. The caller already passed the ownership
 *  gate when minting the ticket, so the attach is fully interactive (keystrokes reach the pane). */
export function attachPty(
  pty: PtyModule,
  opts: { session: string; cols: number; rows: number },
): PtySession {
  // `=name` pins an EXACT session match: a bare `-t name` would let tmux prefix-match a different live
  // session if this one already exited, attaching the viewer to someone else's pane.
  const proc: IPty = pty.spawn('tmux', ['attach', '-t', `=${opts.session}`], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    env: { ...utf8Locale(process.env), TERM: 'xterm-256color' },
  });
  return {
    onData: (cb) => proc.onData(cb),
    write: (d) => proc.write(d),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
  };
}

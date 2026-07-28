import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxDriver, SpawnOpts, ArgvSpawnOpts } from './types.js';
const run = promisify(execFile);

/** Force an EXACT session match for a `-t` target. Bare `-t name` lets tmux fall back to prefix (then
 *  fnmatch) matching, so an operation on a session that has already exited silently retargets a different
 *  live session whose name merely extends it — e.g. `elowen-advisor-1` → `elowen-advisor-10`, killing it,
 *  injecting keystrokes into it, or reading its scrollback (a cross-user hazard, since our session names
 *  carry `<userId>`/`<missionId>` suffixes). The leading `=` pins exact match; the trailing `:` keeps the
 *  same form valid for pane/window targets (send-keys, capture-pane) as well as sessions. */
const exact = (session: string): string => `=${session}:`;

/** tmux reports "there are no sessions" as a FAILURE: the server exits with its last session, so
 *  `list-sessions` then can't connect at all. These two shapes are the only ones that mean "nothing is
 *  running"; every other failure (tmux missing, socket permissions, a server fault) is a real fault. */
const NO_SERVER = /no server running|error connecting to/i;
/** tmux's message when the target session is already gone (the server itself is up). */
const NO_SESSION = /can't find session|session not found/i;

/** execFile rejects with an Error carrying tmux's `stderr`; the message alone omits it on some paths,
 *  so classify against both. */
function tmuxError(e: unknown): string {
  if (typeof e !== 'object' || e === null) return String(e);
  const err = e as { stderr?: unknown; message?: unknown };
  return `${typeof err.stderr === 'string' ? err.stderr : ''}\n${typeof err.message === 'string' ? err.message : ''}`;
}

export class RealTmuxDriver implements TmuxDriver {
  async spawn(session: string, opts: SpawnOpts) {
    // Session env via `-e KEY=VAL` (tmux >= 3.0): the pane shell inherits it, so a token the command needs
    // (e.g. ELOWEN_TOKEN for the agent's `elowen close`) reaches the process WITHOUT being typed as an
    // `export …` line that capturePane could surface. Keys are validated (same invariant as spawnArgv).
    const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env var name: ${JSON.stringify(k)}`);
      return ['-e', `${k}=${v}`];
    });
    await run('tmux', ['new-session', '-d', '-s', session, '-x', String(opts.width ?? 200), '-y', String(opts.height ?? 50), '-c', opts.cwd, ...envArgs]);
    // Pin the window size so detached TUIs (opencode etc.) keep our requested dimensions
    // instead of collapsing to tmux's 80×24 default.
    await run('tmux', ['set-option', '-t', exact(session), 'window-size', 'manual']).catch(() => { /* older tmux — best effort */ });
    try {
      await run('tmux', ['send-keys', '-t', exact(session), opts.command, 'Enter']);
    } catch (e) {
      // The pane shell is already up but never received its command. Leaving it behind would idle
      // forever AND make the caller's retry fail with "duplicate session", so the whole spawn must be
      // all-or-nothing: tear the session down, then report the original failure.
      await this.kill(session).catch(() => { /* nothing further we can do about the orphan */ });
      throw e;
    }
  }
  /** Launch directly with `new-session -- <argv>` and `-e KEY=VAL` session env — no shell, no `send-keys`.
   *  The command AND its environment (which may carry a token) therefore never enter the pane scrollback,
   *  so capturePane can't surface them. tmux `-e` requires tmux >= 3.0; an older tmux fails the
   *  new-session call itself (the caller cleans up its durable row on the throw). */
  async spawnArgv(session: string, opts: ArgvSpawnOpts) {
    const envArgs = Object.entries(opts.env).flatMap(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env var name: ${JSON.stringify(k)}`);
      return ['-e', `${k}=${v}`];
    });
    await run('tmux', [
      'new-session', '-d', '-s', session,
      '-x', String(opts.width ?? 200), '-y', String(opts.height ?? 50),
      '-c', opts.cwd, ...envArgs, '--', ...opts.argv,
    ]);
    await run('tmux', ['set-option', '-t', exact(session), 'window-size', 'manual']).catch(() => { /* older tmux — best effort */ });
  }
  /** Resize the session's window so the running agent (esp. full-screen TUIs) redraws to match
   *  the viewer's terminal width — otherwise wide TUI output wraps and looks garbled. */
  async resize(session: string, cols: number, rows: number) {
    const x = Math.max(20, Math.min(500, Math.floor(cols)));
    const y = Math.max(5, Math.min(200, Math.floor(rows)));
    try { await run('tmux', ['resize-window', '-t', exact(session), '-x', String(x), '-y', String(y)]); }
    catch { /* session gone or tmux too old — ignore */ }
  }
  async sendKeys(session: string, keys: string[]) {
    // Defense in depth (the API validates first): a non-string element would make execFile throw an
    // opaque TypeError, and a flag-shaped token (`-t …`) could redirect keys into another session.
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string' && !k.startsWith('-'))) throw new Error('sendKeys: keys must be a non-empty array of non-flag strings');
    await run('tmux', ['send-keys', '-t', exact(session), ...keys]);
  }
  /** Forward raw terminal bytes (xterm onData) to the pane verbatim. `-l` disables key-name lookup
   *  so control chars / ESC sequences pass through exactly as a real terminal would deliver them;
   *  `--` stops option parsing so `data` can safely begin with '-'. Powers the interactive advisor. */
  async sendRaw(session: string, data: string) {
    if (typeof data !== 'string' || data.length === 0) return;
    await run('tmux', ['send-keys', '-t', exact(session), '-l', '--', data]);
  }
  async capturePane(session: string, tailLines: number) {
    try {
      const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', exact(session), '-S', `-${tailLines}`], { maxBuffer: 512 * 1024 });
      return stdout;
    } catch { return ''; } // dead/missing session → empty (mirror capturePaneAnsi); the deriver sweep must not break on a vanished session
  }
  async capturePaneAnsi(session: string, tailLines: number) {
    try {
      const { stdout } = await run('tmux', ['capture-pane', '-e', '-p', '-t', exact(session), '-S', `-${tailLines}`], { maxBuffer: 512 * 1024 });
      return stdout;
    } catch { return ''; } // dead/missing session → empty frame, stream stays alive (spec §6)
  }
  /** Live session names. An empty list means "tmux is up and nothing is running" — NOT "the lookup
   *  failed": callers treat a missing session as a dead agent and revert/reap its work, so a transient
   *  tmux fault reported as an empty list would declare every running agent dead. Real faults throw. */
  async list() {
    try { const { stdout } = await run('tmux', ['list-sessions', '-F', '#{session_name}']); return stdout.split('\n').map(s => s.trim()).filter(Boolean); }
    catch (e) {
      if (NO_SERVER.test(tmuxError(e))) return []; // no server ⇒ genuinely no sessions
      throw e;
    }
  }
  /** Kill a session. Resolves when it was already gone (the desired state is reached either way), but a
   *  real failure throws: callers proceed as if the process were terminated, so swallowing one leaves a
   *  live agent behind a "killed" task. */
  async kill(session: string) {
    try { await run('tmux', ['kill-session', '-t', exact(session)]); }
    catch (e) {
      const text = tmuxError(e);
      if (NO_SESSION.test(text) || NO_SERVER.test(text)) return; // already gone
      throw e;
    }
  }
}

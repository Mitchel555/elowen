import { homedir } from 'node:os';
import { join } from 'node:path';

/** Single source of truth for where a globally-installed elowen keeps its state. Everything persistent
 *  lives OUTSIDE the npm package (which `npm update` overwrites): the SQLite DB, logs and the run
 *  file all sit under `~/.config/elowen` so an update never touches user data. Each resolver takes the
 *  process env so it stays pure and testable; the daemon's own default (src/daemon/index.ts) matches. */
/** `||`, not `??`: an env var set to the empty string must fall back too. `HOME=''` (and an unset HOME
 *  under some service managers) made this join a RELATIVE '.config/elowen', which resolves against the
 *  process cwd — scattering the DB, the logs and the run file into whatever directory elowen happened to
 *  start in. That is the exact failure the "state lives outside the package" rule above exists to stop.
 *  The final '/' is not decoration: homedir() consults $HOME itself, so an EMPTY HOME leaves it empty
 *  too and the fallback would be circular. An unwritable /.config/elowen fails loudly on first use,
 *  which is strictly better than silently filling the working directory. */
export function dataDir(env: NodeJS.ProcessEnv): string {
  return join(env.HOME || homedir() || '/', '.config', 'elowen');
}

export function dbPath(env: NodeJS.ProcessEnv): string {
  return env.ELOWEN_DB || join(dataDir(env), 'elowen.db');
}

export function logDir(env: NodeJS.ProcessEnv): string {
  return env.ELOWEN_LOG_DIR || join(dataDir(env), 'logs');
}

export function runFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'run.json');
}

/** One id segment made safe for a single path component: URI-encoded, so separators, '%' and control
 *  chars can never escape the parent directory, and empty/dot-segment results get a '%' prefix — a
 *  char no legitimate encoding produces, keeping the mapping injective even at that boundary. */
export function fsSafeSegment(id: string): string {
  const encoded = encodeURIComponent(id);
  return encoded === '' || encoded === '.' || encoded === '..' ? `%${encoded}` : encoded;
}

/** Where a session's cleared tool results are spilled before the context placeholder replaces them.
 *  One directory per session, so pathGuard can scope read access to the OWNING session and session
 *  deletion can remove the whole directory. The id goes through fsSafeSegment: it becomes a
 *  filesystem path in a security check, so a future platform minting `/`, `%` or `..` into its
 *  channel ids must not smuggle the allowance outside `tool-results/`. */
export function toolResultSpillDir(env: NodeJS.ProcessEnv, sessionId: string): string {
  return join(dataDir(env), 'tool-results', fsSafeSegment(sessionId));
}

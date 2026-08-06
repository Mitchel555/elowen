import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import { createRouteContext, type ElowenApp } from './context.js';
import { registerRoutes } from './routes/index.js';
import { bodyLimitBytes, formatZodError } from './validation.js';
import type { ServerDeps } from './deps.js';
import { ELOWEN_VERSION } from './version.js';
import { startLoopLagMonitor, watchLoopLag } from '../shared/eventLoopLag.js';

export type { ServerDeps };

/** A login body is a username and a password — anything larger is not a login attempt. Capped here
 *  because `/auth/login` is public: without a hard pre-parse limit an unauthenticated caller can make
 *  the daemon buffer an unbounded chunked body before the schema ever rejects it. */
const MAX_LOGIN_BODY_BYTES = 16 * 1024;

/** Build the daemon's REST app: wire the global error handler and the two public probes (`/health`,
 *  `/setup`), then register every route family through {@link registerRoutes} (which installs the
 *  auth/tenancy guards first). All per-server state and access helpers live on the shared route
 *  context; the families themselves are in src/api/routes/*. */
export function createServer(d: ServerDeps): ElowenApp {
  const ctx = createRouteContext(d);
  const { log } = ctx;
  const loopLag = startLoopLagMonitor();
  watchLoopLag(loopLag, log);
  const app: ElowenApp = new Hono();
  app.use('*', cors());
  app.use('/auth/login', bodyLimitBytes(MAX_LOGIN_BODY_BYTES));
  // Single source of truth for malformed-body handling: most POST/PATCH routes call `c.req.json()`
  // without a per-route catch, and Hono throws a SyntaxError on invalid JSON. Convert that to a clean
  // 400 instead of leaking a default 500 with no useful body.
  app.onError((err, c) => {
    if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400);
    // A failed `parseBody` schema validation — the single source of truth for malformed request bodies.
    if (err instanceof ZodError) return c.json({ error: formatZodError(err) }, 400);
    log.error('unhandled route error', err);
    return c.json({ error: 'internal error' }, 500);
  });
  // Event loop percentiles ride along on the probe that already exists, because the question "is the
  // daemon keeping up" has no other answer from outside: a starved loop and a slow provider look
  // identical in every other signal, and CPU graphs show a single core busy either way. Reading the
  // histogram is a few arithmetic ops, so the probe stays the ~1 ms round-trip it is today.
  app.get('/health', c => c.json({ ok: true, version: ELOWEN_VERSION, eventLoop: loopLag.lag() }));
  // Public: lets the web decide whether to show onboarding (no users yet) or the login form.
  app.get('/setup', c => c.json({ needsSetup: d.users ? d.users.count() === 0 : false }));

  registerRoutes(app, ctx);
  return app;
}

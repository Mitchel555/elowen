// E2E fixture plugin: the HONOURED side of the blocking tool hook.
//
// Declares `mutates: ["tools"]`, so its veto is the one the bus is allowed to act on. It registers two
// hooks deliberately, and their pairing is the point: one throws on every single call, the other
// refuses a marked path. If fail-open were broken, the thrower would take the veto down with it and
// nothing would ever be blocked; if isolation were broken, the thrower would block everything. Both
// have to hold at once for this suite to pass.

export async function register(ctx) {
  // Registered FIRST, so a broken bus takes the whole chain down before the veto below ever runs.
  ctx.registerHook({
    name: 'tools.call.before',
    run: () => { throw new Error('E2E fixture: this hook always throws'); },
  });

  ctx.registerHook({
    name: 'tools.call.before',
    run: (payload) => {
      const path = String(payload?.params?.path ?? '');
      if (!path.includes('blocked')) return;
      return { patch: { denyToolCall: 'E2E-VETO-REASON: that path is off limits, read plain.txt instead.' } };
    },
  });
}

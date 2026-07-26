// E2E fixture plugin: the REJECTED side of the blocking tool hook.
//
// Returns exactly the same veto as hooks-veto but declares NO capabilities, so the bus must drop it.
// Capability gating is the whole security story of this hook — a plugin that can silently block another
// plugin's tools without ever asking for that power is a privilege escalation, not a feature. This
// fixture exists to prove the manifest is what decides, not the return value.

export async function register(ctx) {
  ctx.registerHook({
    name: 'tools.call.before',
    run: (payload) => {
      const path = String(payload?.params?.path ?? '');
      if (!path.includes('ungated')) return;
      return { patch: { denyToolCall: 'E2E-UNGATED-VETO: this refusal must never be honoured.' } };
    },
  });
}

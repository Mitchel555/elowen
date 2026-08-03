import { describe, it, expect } from 'vitest';
import { liveRecallAllowed } from '../../src/brain/service/spawner.js';

/** The leak boundary for mid-turn recall. A shared channel serves several senders, so surfacing one
 *  person's private memories there would show them to everyone else in the channel — the single worst
 *  thing this feature could do. Asserted directly rather than inferred from the spawn wiring, because a
 *  condition that only exists inline inside a 200-line object literal is one refactor away from being
 *  quietly widened. */
describe('liveRecallAllowed — who may have memories injected mid-turn', () => {
  it('allows an owner conversation', () => {
    expect(liveRecallAllowed('brain-1', 1)).toBe(true);
    expect(liveRecallAllowed('brain-42', 42)).toBe(true);
  });

  it('refuses every shared channel session', () => {
    // A Discord/WhatsApp/Telegram channel is read by whoever is in it.
    expect(liveRecallAllowed('brain-ch-discord-1503660194109063210', 1)).toBe(false);
    expect(liveRecallAllowed('brain-ch-whatsapp-420123456789', 1)).toBe(false);
    expect(liveRecallAllowed('brain-ch-telegram-99', 1)).toBe(false);
  });

  it('refuses a sub-agent session even though it has a real owner', () => {
    // Sub-agents are channel-keyed. They run with delegated access and their transcript is relayed
    // onward, so the owner's private memories must not ride along.
    expect(liveRecallAllowed('brain-ch-subagent-sub-dlg-abc', 1)).toBe(false);
  });

  it('refuses an ownerless session', () => {
    // Task/worker sessions carry ownerUserId 0 — there is no one whose memory it would even be.
    expect(liveRecallAllowed('brain-0', 0)).toBe(false);
    expect(liveRecallAllowed('brain-task-7', 0)).toBe(false);
  });

  it('refuses a negative or non-integer owner id rather than trusting the caller', () => {
    expect(liveRecallAllowed('brain-1', -1)).toBe(false);
  });
});

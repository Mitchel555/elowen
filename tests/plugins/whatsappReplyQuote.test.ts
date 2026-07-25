import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const log = { info() {}, warn() {}, error() {} };
const CHAT = '420123456789@s.whatsapp.net';
const US = '420999888777@s.whatsapp.net';

// Regression: a reply quotes the original verbatim, so our own runtime footer (`_model · n %_`) rode back
// into the prompt on every reply to the bot. Shown that line as the house style, the model starts writing
// it itself, inventing a model name it never ran on — and the forged line then rides the NEXT quote.
describe('whatsapp reply quote', () => {
  const makeAdapter = async () => {
    const { WhatsAppAdapter } = await import(join(repoRoot, 'plugins/whatsapp/lib/adapter.mjs')) as {
      WhatsAppAdapter: new (...args: unknown[]) => {
        meId: string | null;
        sock: unknown;
        listen: (h: (src: unknown, text: string) => Promise<string>) => void;
        onMessage: (m: unknown) => Promise<void>;
      };
    };
    const state = { get: () => ({}), patch: () => {} };
    const adapter = new WhatsAppAdapter(
      { language: 'en', senderPolicies: [{ roleId: CHAT }], streaming: false, reactions: false },
      log, state, async () => [], [], '', '', () => false, () => [],
    );
    adapter.meId = US;
    adapter.sock = { sendPresenceUpdate: async () => {} };
    const seen: string[] = [];
    adapter.listen(async (_src: unknown, text: string) => { seen.push(text); return ''; });
    return { adapter, seen };
  };

  const turn = (quotedAuthor: string, quoted: string) => ({
    key: { remoteJid: CHAT, fromMe: false, id: 'M1' },
    pushName: 'Anna',
    message: {
      extendedTextMessage: {
        text: 'a proč?',
        contextInfo: { participant: quotedAuthor, quotedMessage: { conversation: quoted } },
      },
    },
  });

  it('drops the footer when quoting our own message', async () => {
    const { adapter, seen } = await makeAdapter();
    await adapter.onMessage(turn(US, 'Hotovo.\n\n_qwen3.8-max-preview · 4 %_'));
    expect(seen[0]).toBe('[Replying to 420999888777: "Hotovo."]\n[Anna] a proč?');
  });

  it('keeps a person\'s own trailing italic line verbatim', async () => {
    const { adapter, seen } = await makeAdapter();
    await adapter.onMessage(turn(CHAT, 'tohle\n_můj vlastní řádek_'));
    expect(seen[0]).toBe('[Replying to 420123456789: "tohle\n_můj vlastní řádek_"]\n[Anna] a proč?');
  });
});

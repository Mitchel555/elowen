// Voice plumbing shared by the adapters that support spoken turns (Discord, Telegram): resolving the
// configured voice provider's credentials and posting an audio buffer to its Whisper-compatible endpoint.
// Acquiring the buffer stays per-adapter (a Discord CDN download versus a Telegram getFile), and so does
// speakReply — the surfaces want different containers (mp3 versus OGG/Opus).

/** Resolve the voice provider's credentials (a central brain provider chosen in config) → { apiKey,
 *  baseUrl }, or null when unset/keyless. baseUrl carries the audio endpoints (e.g. …/v1). */
export function voiceCreds(cfg, resolveProvider) {
  const id = typeof cfg.voiceProvider === 'string' ? cfg.voiceProvider.trim() : '';
  if (!id) return null;
  const p = resolveProvider(id);
  if (!p?.apiKey || !p.baseUrl) return null;
  return { apiKey: p.apiKey, baseUrl: String(p.baseUrl).replace(/\/+$/, '') };
}

/** Transcribe one audio buffer: multipart it to the provider's /audio/transcriptions. Returns the trimmed
 *  text, or null when the provider answers with nothing usable. Throws on a non-OK response so the caller
 *  can log the failure and fall back to a note. */
export async function transcribeBuffer(creds, buf, { name, type, model } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: type || 'audio/ogg' }), name || 'audio.ogg');
  form.append('model', String(model || 'whisper-1'));
  const res = await fetch(`${creds.baseUrl}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${creds.apiKey}` }, body: form,
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const t = typeof j?.text === 'string' ? j.text.trim() : '';
  return t || null;
}

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainMessageImage } from '../shared/wireContract.js';

/** An image attached to a user message, kept on disk so the conversation still shows it after a reload.
 *  Raw base64 deliberately never reaches `brain_messages` (see persistence.ts) — the row carries this
 *  reference instead, and the bytes live next to the database like avatars do. */
export interface StoredChatImage {
  /** File name inside the chat-images dir; also the path segment the read route accepts. */
  file: string;
  mimeType: string;
}

/** The four types the send schema admits (src/api/schemas/brain.ts) mapped to the extension on disk.
 *  Anything else never gets here, and is dropped rather than guessed at. */
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** A stored name is exactly `<uuid>.<ext>` — no separators, no traversal, nothing the caller chose. */
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

/** Write a turn's attachments to disk and return the references to persist on the user row. Best-effort
 *  per image: one that cannot be written is skipped rather than failing the turn, because the message
 *  itself (and the copy the model sees) is unaffected — only its thumbnail after a reload is. */
export function storeChatImages(dir: string, images: readonly { data: string; mimeType: string }[]): StoredChatImage[] {
  const stored: StoredChatImage[] = [];
  for (const image of images) {
    const ext = EXTENSION[image.mimeType];
    if (!ext) continue;
    const file = `${randomUUID()}.${ext}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), Buffer.from(image.data, 'base64'));
      stored.push({ file, mimeType: image.mimeType });
    } catch { /* keep the turn; the attachment just won't survive a reload */ }
  }
  return stored;
}

/** Read a stored image back. Returns null for an unknown or malformed name, so the route answers 404
 *  without distinguishing "never existed" from "swept away". */
export function readChatImage(dir: string, file: string): { body: Buffer; mimeType: string } | null {
  if (!STORED_NAME.test(file)) return null;
  const mimeType = MIME_BY_EXTENSION[file.slice(file.lastIndexOf('.') + 1)];
  if (!mimeType) return null;
  try {
    return { body: readFileSync(join(dir, file)), mimeType };
  } catch {
    return null;
  }
}

/** What a persisted user row says instead of carrying the image bytes. It is the model's only trace of
 *  the attachment after the turn, so it stays in the stored text even when the files survive. */
export function attachmentMarker(count: number): string {
  return `\n[📎 ${count}× image]`;
}

const MARKER = /\n?\[📎 \d+× image\]$/u;

/** Drop the marker for a client that renders the attachments themselves. View-only — never write the
 *  result back to the store, or the model loses the trace. */
export function stripAttachmentMarker(text: string): string {
  return text.replace(MARKER, '');
}

/** The daemon path a client loads a stored image from. Kept next to the route that serves it so the live
 *  echo and the history DTO cannot drift apart; the web surface prefixes its own `/api` proxy base. */
function chatImageUrl(file: string): string {
  return `/brain/chat-images/${file}`;
}

/** Shape stored references into the wire form both the `user` event and a history row carry. */
export function toMessageImages(stored: readonly StoredChatImage[]): BrainMessageImage[] {
  return stored.map((image) => ({ url: chatImageUrl(image.file), mimeType: image.mimeType }));
}

/** Delete stored images no message references any more — a turn discarded before it produced output, or
 *  a conversation that was deleted. Files younger than `graceMs` are always kept: a turn writes its files
 *  before the row that references them is committed, so a sweep racing an admission would otherwise delete
 *  an attachment that is about to become live. Returns how many files were removed. */
export function sweepChatImages(dir: string, referenced: ReadonlySet<string>, graceMs: number, now = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // nothing written yet
  }
  for (const file of entries) {
    if (!STORED_NAME.test(file) || referenced.has(file)) continue;
    const path = join(dir, file);
    try {
      if (now - statSync(path).mtimeMs < graceMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch { /* vanished or unreadable — nothing to reclaim */ }
  }
  return removed;
}

/** Parse the `images` field off a persisted user row. The column is free-form JSON written by older
 *  builds too, so every shape that isn't exactly what we write is treated as "no attachments". */
export function parseStoredChatImages(value: unknown): StoredChatImage[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatImage[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { file, mimeType } = entry as { file?: unknown; mimeType?: unknown };
    if (typeof file !== 'string' || typeof mimeType !== 'string') continue;
    if (!STORED_NAME.test(file)) continue;
    out.push({ file, mimeType });
  }
  return out;
}

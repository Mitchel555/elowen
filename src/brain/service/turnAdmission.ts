import type { BrainStore } from '../../store/brainStore.js';
import type { ConversationTitler } from '../conversationTitler.js';
import { attachmentMarker, storeChatImages, toMessageImages, type StoredChatImage } from '../chatImages.js';
import { projectUserTurn } from '../persistence.js';
import type { LiveBrain } from '../session/liveBrain.js';
import { enqueueMirrored } from '../session/queueMirror.js';
import type { TurnImage, TurnMode } from './turnRequest.js';

interface TurnAdmissionDeps {
  store: BrainStore;
  titler: ConversationTitler;
  /** Where a turn's attachments are written so they outlive it. Absent (in-memory store, tests) → the
   *  message keeps only its `[📎 N× image]` marker, exactly as before. */
  chatImagesDir?: string;
}

interface AdmissionInput {
  live: LiveBrain;
  text: string;
  persistText?: string;
  images?: TurnImage[];
  display?: string;
  mode?: TurnMode;
  visible: boolean;
  titleOnAdmission: boolean;
  onAdmitted?: (sessionId: string) => void;
}

/** Owns the transaction boundary between hidden durable projection and PI acceptance. A row becomes
 * visible only after PI accepts it; every pre-admission failure rolls a visible user turn back. */
export class TurnAdmission {
  private durableId?: string;
  private persistText?: string;
  private stored: StoredChatImage[] = [];
  private admitted = false;
  private rolledBack = false;

  constructor(private d: TurnAdmissionDeps, private input: AdmissionInput) {}

  /** Project the clean durable row before PI preflight so native pre-prompt compaction can see it. */
  prepare(): { durableId: string; persistText: string } {
    if (this.durableId && this.persistText !== undefined) {
      return { durableId: this.durableId, persistText: this.persistText };
    }
    this.persistText = this.durableText();
    this.stored = this.storeImages();
    this.durableId = projectUserTurn(this.d.store, this.input.live.sessionId, this.persistText, this.stored);
    return { durableId: this.durableId, persistText: this.persistText };
  }

  /** Write the attachments once per admission. The base64 is in memory only for this turn, so this is the
   *  single moment it can be captured; the result is reused by both the durable row and the live echo. */
  private storeImages(): StoredChatImage[] {
    if (!this.d.chatImagesDir || !this.input.images?.length) return [];
    return storeChatImages(this.d.chatImagesDir, this.input.images);
  }

  /** PI native preflight callback. False is deliberately a no-op; prompt() throws and the caller rolls
   * the still-hidden projection back through rollbackPending(). */
  preflightResult = (success: boolean): void => {
    if (!success || !this.input.visible || this.admitted) return;
    this.publishAccepted();
  };

  /** Mid-turn admission ends when PI accepts the queue entry, but acceptance is NOT delivery. Keep its
   * durable/display identity on the mirrored queue item; the spawner projects and echoes it only when PI
   * removes that item and emits the matching user message_start. */
  async steer(): Promise<void> {
    const persistText = this.durableText();
    // Store the attachments HERE, not at delivery: the base64 only exists while the message waits in PI's
    // transient queue, and the durable row is written later, by deliverQueuedUserEcho. A queue entry that
    // never gets delivered leaves the files unreferenced, which the daily sweep reclaims.
    this.stored = this.storeImages();
    await enqueueMirrored(
      this.input.live,
      'steer',
      this.input.text,
      this.input.images?.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
      {
        persistText,
        displayText: this.input.display ?? this.input.persistText ?? this.input.text,
        ...(this.stored.length ? { images: this.stored } : {}),
        // The clean model-facing text before the running-subagents block and the attachment marker: what a
        // later Esc-promotion re-composes from (`input.text` still carries the block; `persistText` the marker).
        sourceText: this.input.persistText ?? this.input.text,
        mode: this.input.mode,
        publish: true,
      },
    );
    this.markAdmitted();
  }

  /** Remove only a hidden user projection. Internal turns intentionally remain durable on failure,
   * matching the existing goal/system-turn history semantics. */
  rollbackPending(): void {
    if (!this.input.visible || this.admitted || this.rolledBack || !this.durableId) return;
    this.rolledBack = true;
    this.d.store.deleteMessage(this.input.live.sessionId, this.durableId);
  }

  private publishAccepted(): void {
    if (this.admitted) return;
    const { durableId, persistText } = this.prepare();
    const row = this.input.titleOnAdmission ? this.d.store.getSession(this.input.live.sessionId) : undefined;
    if (row && !row.title) {
      const provisionalTitle = this.input.text.slice(0, 60);
      this.d.store.setTitle(this.input.live.sessionId, provisionalTitle);
      void this.d.titler.run(this.input.live.sessionId, this.input.text, provisionalTitle);
    }
    // Arm the Esc/Stop-before-output discard for THIS turn: reset the output flag and remember the row a
    // discard would delete + the text it would restore (the same text shown in the bubble). Set before the
    // user event is published so a cancel racing the first token reads a consistent `turnProducedOutput`.
    const displayText = this.input.display ?? persistText;
    this.input.live.turnProducedOutput = false;
    this.input.live.lastAdmitted = { durableId, text: displayText };
    this.input.live.replay.publish({
      type: 'user',
      text: displayText,
      durableId,
      ...(this.stored.length ? { images: toMessageImages(this.stored) } : {}),
    });
    this.markAdmitted();
  }

  private durableText(): string {
    const marker = this.input.images?.length ? attachmentMarker(this.input.images.length) : '';
    return (this.input.persistText ?? this.input.text) + marker;
  }

  private markAdmitted(): void {
    if (this.admitted) return;
    this.admitted = true;
    this.input.onAdmitted?.(this.input.live.sessionId);
  }
}

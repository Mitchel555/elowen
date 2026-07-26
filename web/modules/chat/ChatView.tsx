'use client';
import { useRef, useState } from 'react';
import { useFillHeight } from '../../lib/useFillHeight';
import { useMobile } from '../../lib/useMobile';
import { BrainChatSurface } from '../advisor/BrainChatSurface';
import { ChatHistoryRail } from '../advisor/ChatHistoryRail';
import { TelemetryPanel } from '../advisor/TelemetryPanel';
import { ChatDeckHero } from './ChatDeckHero';

/** The full-page chat host. It reads the ONE controller mounted in ShellLayout via the surface + rail
 *  (both call useBrainChat) — it must NEVER wrap its own <BrainChatProvider>, or a second controller +
 *  SSE stream would open. An Elowen-style stat hero sits on top; the conversation renders natively in the
 *  content below (no card frame). The history list is hidden by default and opens as a left drawer from
 *  the surface header button — cleaner and more minimal than a permanent column. useFillHeight gives the
 *  surface a MIN height of one viewport (so a short conversation still fills the screen and pins the
 *  composer to the bottom); a longer transcript grows past it and the page itself scrolls — no inner
 *  scroll box, the whole width is used, and older messages page in on scroll-up.
 *
 *  The telemetry rail is a real column beside the transcript on desktop and a right drawer on mobile:
 *  the choice is made here in JS (not by a CSS breakpoint) so a phone never mounts a second column at
 *  all, which is what would squeeze the conversation off a narrow screen. */
export function ChatView() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillHeight(surfaceRef);
  const mobile = useMobile();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);

  return (
    <>
      <ChatDeckHero />
      <div
        ref={surfaceRef}
        style={fillHeight ? { minHeight: fillHeight } : undefined}
        className="relative flex"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <BrainChatSurface
            variant="full"
            onOpenHistory={() => setHistoryOpen(true)}
            onOpenTelemetry={mobile ? () => setTelemetryOpen(true) : undefined}
          />
        </div>
        {mobile ? null : <TelemetryPanel variant="column" />}
        <ChatHistoryRail variant="drawer" open={historyOpen} onClose={() => setHistoryOpen(false)} />
        {mobile ? (
          <TelemetryPanel variant="drawer" open={telemetryOpen} onClose={() => setTelemetryOpen(false)} />
        ) : null}
      </div>
    </>
  );
}

'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

type Tone = 'ok' | 'error';
interface ToastItem { id: number; message: string; tone: Tone }
interface ToastCtx { toast: (message: string, tone?: Tone) => void }

const Ctx = createContext<ToastCtx | null>(null);
let nextId = 0;
const TOAST_MS = 4500;

function ToastCard({ item, meta, dismissLabel, onDismiss }: { item: ToastItem; meta: { Icon: LucideIcon; color: string; title: string }; dismissLabel: string; onDismiss: () => void }) {
  const { Icon, color, title } = meta;
  const [remaining, setRemaining] = useState(100);
  const paused = useRef(false);

  // A clearly-tinted fill mixed into the theme's own elevated surface (near-black in dark mode, near-white
  // in light) with a strong same-hue border + a lifted accent for icon/title, so it reads as a solid
  // tinted panel on either palette — not muddy, not pale.
  const fill = `color-mix(in srgb, ${color} 22%, var(--color-elevated))`;
  const edge = `color-mix(in srgb, ${color} 58%, var(--color-elevated))`;
  const accent = `color-mix(in srgb, ${color} 82%, var(--color-text))`;

  useEffect(() => {
    // rAF countdown that drives both the progress bar and auto-dismiss; pauses on hover.
    let elapsed = 0;
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      if (!paused.current) elapsed += now - last;
      last = now;
      setRemaining(Math.max(0, 100 - (elapsed / TOAST_MS) * 100));
      if (elapsed >= TOAST_MS) { onDismiss(); return; }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [onDismiss]);

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
      className="pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg py-2.5 pl-3 pr-2.5 sm:gap-3 sm:py-3 sm:pl-4 sm:pr-3"
      style={{
        boxShadow: 'var(--shadow-raised)',
        background: fill,
        border: `1px solid ${edge}`,
        animation: 'toast-in 200ms var(--ease-out)',
      }}
    >
      <Icon size={18} aria-hidden className="mt-px shrink-0" style={{ color: accent }} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold sm:text-sm" style={{ color: accent }}>{title}</div>
        <div className="mt-0.5 break-words text-[13px] leading-snug text-text sm:text-sm">{item.message}</div>
      </div>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text sm:h-7 sm:w-7"
      >
        <X size={15} aria-hidden />
      </button>
      <span className="absolute bottom-0 left-0 h-0.5" style={{ width: `${remaining}%`, backgroundColor: accent, opacity: 0.55 }} aria-hidden />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const TONE: Record<Tone, { Icon: LucideIcon; color: string; title: string }> = {
    ok: { Icon: CheckCircle2, color: '#32CD32', title: t.common.success },
    error: { Icon: AlertCircle, color: '#FF3131', title: t.common.error },
  };
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((message: string, tone: Tone = 'ok') => {
    const id = nextId++;
    setItems((xs) => [...xs, { id, message, tone }]);
  }, []);
  // Stable context value: `toast` never changes identity, so consumers don't re-render every time a
  // toast is shown/dismissed (which would, among other things, churn the SSE subscription in EventBridge).
  const ctx = useMemo(() => ({ toast }), [toast]);
  return (
    <Ctx.Provider value={ctx}>
      {children}
      {/* Top-right, and mobile-first: on a phone the desktop 28rem card filled almost the whole screen and
          sat at the bottom over the input. Narrow it with a small margin, tuck it to the top-right corner,
          and step the size back up from `sm` onward. */}
      <div className="pointer-events-none fixed top-3 right-3 z-50 flex w-[calc(100vw-1.5rem)] flex-col gap-2 sm:top-5 sm:right-5 sm:w-[26rem] sm:gap-2.5">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} meta={TONE[item.tone]} dismissLabel={t.common.dismiss} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

'use client';
import { SlidersHorizontal, AlignLeft, Type, Timer, Brain, ListChecks, Target, Repeat, MessagesSquare, Share2, type LucideIcon } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { Slider } from '../../components/ui/Slider';
import { formatTokens } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import type { BrainLimits } from '../../lib/types';

/** Fallback for seeding the Limits form before the daemon's config arrives (it always sends real values). */
export const BRAIN_LIMIT_DEFAULTS: BrainLimits = {
  toolOutputMaxLines: 80, toolOutputMaxChars: 30000, elicitationTimeoutMs: 300000,
  memoryRecallCount: 6, memoryRecallChars: 6000, goalTurnBudget: 24, goalMaxTurns: 64, channelSessionCap: 32,
  delegateContextChars: 20000,
};

const MILLISECONDS_PER_MINUTE = 60_000;
/** Conventional UI estimate only; canonical limits remain character counts on the wire. */
const CHARACTERS_PER_TOKEN = 4;

type BrainLimitKind = 'duration' | 'size' | 'count';
type BrainLimitField = {
  key: keyof BrainLimits;
  kind: BrainLimitKind;
  min: number;
  max: number;
  step: number;
  icon: LucideIcon;
};

/** Limits in display order. Every min/max MIRRORS the daemon's clamp bound in `src/store/configStore.ts`
 *  (the web may not import it — see the `web-not-to-backend` rule), so a slider can never offer a value
 *  the daemon would silently lower. `web/tests/modules/settings/brainLimitsParity.test.ts` compares the two
 *  tables and fails on drift; `kind` owns the UI unit conversion. */
const BRAIN_LIMIT_FIELDS: BrainLimitField[] = [
  { key: 'toolOutputMaxLines', kind: 'count', min: 40, max: 200, step: 10, icon: AlignLeft },
  { key: 'toolOutputMaxChars', kind: 'size', min: 15000, max: 80000, step: 1000, icon: Type },
  { key: 'elicitationTimeoutMs', kind: 'duration', min: 30000, max: 21600000, step: 30000, icon: Timer },
  { key: 'memoryRecallCount', kind: 'count', min: 3, max: 9, step: 1, icon: Brain },
  { key: 'memoryRecallChars', kind: 'size', min: 3000, max: 20000, step: 500, icon: ListChecks },
  { key: 'goalTurnBudget', kind: 'count', min: 4, max: 500, step: 1, icon: Target },
  { key: 'goalMaxTurns', kind: 'count', min: 8, max: 500, step: 1, icon: Repeat },
  { key: 'channelSessionCap', kind: 'count', min: 4, max: 256, step: 1, icon: MessagesSquare },
  { key: 'delegateContextChars', kind: 'size', min: 10000, max: 80000, step: 1000, icon: Share2 },
];

const DISPLAY_DIVISORS: Record<BrainLimitKind, number> = {
  duration: MILLISECONDS_PER_MINUTE,
  size: CHARACTERS_PER_TOKEN,
  count: 1,
};

function toCanonicalValue(field: BrainLimitField, displayValue: number): number {
  const canonical = Math.round(displayValue * DISPLAY_DIVISORS[field.kind]);
  return Math.min(field.max, Math.max(field.min, canonical));
}

/** Modal editor for operator-tunable brain limits. Edits flow straight back into the caller's state,
 *  which auto-saves through the shared status controller, so there is no Save button. */
export function BrainLimitsModal({ limits, applied, onChange, onClose, presentation }: {
  limits: BrainLimits;
  /** Fields the daemon clamped on the last save, each carrying the value actually in force. A clamp used
   *  to be invisible here, which left the operator believing a refused value had taken effect. */
  applied?: Partial<BrainLimits>;
  onChange: (next: (cur: BrainLimits) => BrainLimits) => void;
  onClose: () => void;
  presentation?: 'center' | 'drawer';
}) {
  const { t } = useTranslation();
  /** A canonical value in the row's own display unit. Token counts are a 4-chars-per-token estimate
   *  already, so the fractional tail of an odd character budget is rounded away. */
  const displayLabel = (field: BrainLimitField, canonical: number): string => {
    const value = canonical / DISPLAY_DIVISORS[field.kind];
    if (field.kind === 'duration') return `${Number(value.toFixed(2))} ${t.brain.limits.minuteUnit}`;
    if (field.kind === 'size') return `≈ ${formatTokens(Math.round(value))} ${t.brain.limits.tokenUnit}`;
    return String(value);
  };
  return (
    <Modal title={t.brain.limits.title} description={t.brain.limits.hint} icon={SlidersHorizontal} size="md" onClose={onClose} presentation={presentation}>
      <ModalBody>
        <div className="flex flex-col divide-y divide-border">
          {BRAIN_LIMIT_FIELDS.map((field) => {
            const Icon = field.icon;
            const divisor = DISPLAY_DIVISORS[field.kind];
            const value = limits[field.key] / divisor;
            const valueLabel = displayLabel(field, limits[field.key]);
            const clamped = applied?.[field.key];
            return (
              <div key={field.key} className="py-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text">
                    {t.brain.limits[field.key]}
                    <HelpTip>{t.brain.limits[`${field.key}Hint`]}</HelpTip>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-accent">{valueLabel}</span>
                </div>
                <Slider
                  value={value}
                  min={field.min / divisor}
                  max={field.max / divisor}
                  step={field.step / divisor}
                  onChange={(next) => onChange((cur) => ({ ...cur, [field.key]: toCanonicalValue(field, next) }))}
                  aria-label={t.brain.limits[field.key]}
                  aria-valuetext={valueLabel}
                  className="mt-3"
                />
                {clamped !== undefined ? (
                  <p className="mt-2 text-tiny leading-relaxed text-text-muted">
                    {t.brain.limits.clamped.replace('{value}', displayLabel(field, clamped))}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="accent" onClick={onClose}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}

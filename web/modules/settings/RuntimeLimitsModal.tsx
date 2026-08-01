'use client';
import { Gauge, TerminalSquare, Radar, Layers, History, type LucideIcon } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { useTranslation } from '../../lib/i18n';
import { plural } from '../../lib/i18n/plural';
import type { RuntimeConfig, RuntimeLimits } from '../../lib/types';

/** Fallback for seeding the Runtime form before the daemon's config arrives (it always sends real values). */
export const RUNTIME_LIMIT_DEFAULTS: RuntimeLimits = {
  localShellTimeoutMs: 30000, memorySemanticFloorPerMille: 300, toolDeferThreshold: 10, eventRetentionDays: 30,
};

const MILLISECONDS_PER_SECOND = 1_000;
/** The semantic floor travels as an integer per mille so the daemon's whole-number clamp cannot round a
 *  cosine threshold away to zero; the slider shows the cosine value the operator reasons about. */
const PER_MILLE = 1_000;

type RuntimeLimitKind = 'seconds' | 'cosine' | 'count' | 'days';
type RuntimeLimitField = {
  key: keyof RuntimeLimits;
  kind: RuntimeLimitKind;
  min: number;
  max: number;
  step: number;
  icon: LucideIcon;
};

/** Runtime knobs in display order. Every min/max MIRRORS the daemon's clamp bound in
 *  `src/store/configStore.ts` (the web may not import it — see the `web-not-to-backend` rule), so a slider
 *  can never offer a value the daemon would silently lower.
 *  `web/tests/modules/settings/runtimeLimitsParity.test.ts` compares the two tables and fails on drift;
 *  `kind` owns the UI unit conversion. */
const RUNTIME_LIMIT_FIELDS: RuntimeLimitField[] = [
  { key: 'localShellTimeoutMs', kind: 'seconds', min: 10000, max: 300000, step: 5000, icon: TerminalSquare },
  { key: 'memorySemanticFloorPerMille', kind: 'cosine', min: 100, max: 800, step: 10, icon: Radar },
  { key: 'toolDeferThreshold', kind: 'count', min: 1, max: 100, step: 1, icon: Layers },
  { key: 'eventRetentionDays', kind: 'days', min: 1, max: 365, step: 1, icon: History },
];

const DISPLAY_DIVISORS: Record<RuntimeLimitKind, number> = {
  seconds: MILLISECONDS_PER_SECOND,
  cosine: PER_MILLE,
  count: 1,
  days: 1,
};

function toCanonicalValue(field: RuntimeLimitField, displayValue: number): number {
  const canonical = Math.round(displayValue * DISPLAY_DIVISORS[field.kind]);
  return Math.min(field.max, Math.max(field.min, canonical));
}

/** Modal editor for the operator-tunable runtime knobs (the sibling of the brain Limits editor). Edits
 *  flow straight back into the caller's state, which auto-saves through the shared status controller, so
 *  there is no Save button. */
export function RuntimeLimitsModal({ runtime, applied, onChange, onClose, presentation }: {
  runtime: RuntimeConfig;
  /** Fields the daemon clamped on the last save, each carrying the value actually in force — otherwise a
   *  refused value would look to the operator like it had taken effect. */
  applied?: Partial<RuntimeLimits>;
  onChange: (next: (cur: RuntimeConfig) => RuntimeConfig) => void;
  onClose: () => void;
  presentation?: 'center' | 'drawer';
}) {
  const { t } = useTranslation();
  /** A canonical value in the row's own display unit. */
  const displayLabel = (field: RuntimeLimitField, canonical: number): string => {
    const value = canonical / DISPLAY_DIVISORS[field.kind];
    if (field.kind === 'seconds') return `${Number(value.toFixed(1))} ${t.brain.runtime.secondUnit}`;
    if (field.kind === 'cosine') return value.toFixed(2);
    if (field.kind === 'days') return `${value} ${plural(t.brain.runtime.dayUnit, value)}`;
    return String(value);
  };
  return (
    <Modal title={t.brain.runtime.title} description={t.brain.runtime.hint} icon={Gauge} size="md" onClose={onClose} presentation={presentation}>
      <ModalBody>
        <div className="flex flex-col divide-y divide-border">
          {RUNTIME_LIMIT_FIELDS.map((field) => {
            const Icon = field.icon;
            const divisor = DISPLAY_DIVISORS[field.kind];
            const value = runtime.limits[field.key] / divisor;
            const valueLabel = displayLabel(field, runtime.limits[field.key]);
            const clamped = applied?.[field.key];
            return (
              <div key={field.key} className="py-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text">
                    {t.brain.runtime[field.key]}
                    <HelpTip>{t.brain.runtime[`${field.key}Hint`]}</HelpTip>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-accent">{valueLabel}</span>
                </div>
                <Slider
                  value={value}
                  min={field.min / divisor}
                  max={field.max / divisor}
                  step={field.step / divisor}
                  onChange={(next) => onChange((cur) => ({ ...cur, limits: { ...cur.limits, [field.key]: toCanonicalValue(field, next) } }))}
                  aria-label={t.brain.runtime[field.key]}
                  aria-valuetext={valueLabel}
                  className="mt-3"
                />
                {clamped !== undefined ? (
                  <p className="mt-2 text-tiny leading-relaxed text-text-muted">
                    {t.brain.runtime.clamped.replace('{value}', displayLabel(field, clamped))}
                  </p>
                ) : null}
              </div>
            );
          })}
          {/* The deferral kill switch sits with the threshold it overrides: off means no tool is ever
              withheld from the prompt, whatever the threshold says. */}
          <div className="flex items-center gap-2.5 py-3.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted">
              <Layers size={18} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text">
              {t.brain.runtime.toolDeferralEnabled}
              <HelpTip>{t.brain.runtime.toolDeferralEnabledHint}</HelpTip>
            </span>
            <Toggle
              checked={runtime.toolDeferralEnabled}
              onChange={(next) => onChange((cur) => ({ ...cur, toolDeferralEnabled: next }))}
              label={t.brain.runtime.toolDeferralEnabled}
            />
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="accent" onClick={onClose}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}

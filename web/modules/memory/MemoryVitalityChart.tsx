'use client';
import { useMemo } from 'react';
import type { MemoryVitalityHistory, MemoryVitalityPoint } from '../../lib/types';
import { useMemoryVitalityHistory } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { parseTs } from '../../lib/format';
import { vitalityPct, vitalityTone } from './memoryMeta';
import { TONE_TEXT } from '../../components/ui/tone';
import { LoadingState } from '../../components/ui/states';

/** A memory's vitality over time: the reconstructed past as a solid line, the "if it is never recalled
 *  again" projection as a dashed one, and the threshold at which retention moves it to the trash.
 *
 *  Drawn as inline SVG rather than with a charting library — the web has none, and every other
 *  visualisation here (the vitality bar, the progress ribbon) is hand-rolled from tokens. The curve is
 *  computed daemon-side: the half-life table is server config the browser deliberately never sees. */

const VIEW_W = 300;
const VIEW_H = 100;
/** Headroom so a curve pinned at 100 is not clipped by the stroke, and the floor label has air. */
const PAD_Y = 6;

const TONE_STROKE: Record<ReturnType<typeof vitalityTone>, string> = {
  default: 'var(--color-text-muted)',
  accent: 'var(--color-accent)',
  muted: 'var(--color-text-muted)',
  danger: 'var(--color-danger)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
};

interface Scale {
  x: (iso: string) => number;
  y: (vitality: number) => number;
}

function buildScale(history: MemoryVitalityHistory): Scale | null {
  const all = [...history.points, ...history.forecast];
  const times = all.map((point) => parseTs(point.at)).filter((ms): ms is number => ms != null);
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (times.length < 2 || !Number.isFinite(min) || !Number.isFinite(max) || max === min) return null;
  return {
    x: (iso) => {
      const ms = parseTs(iso);
      if (ms == null) return 0;
      return ((ms - min) / (max - min)) * VIEW_W;
    },
    y: (vitality) => {
      const clamped = Math.max(0, Math.min(100, vitality));
      return VIEW_H - PAD_Y - (clamped / 100) * (VIEW_H - PAD_Y * 2);
    },
  };
}

const toPath = (points: MemoryVitalityPoint[], scale: Scale): string =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'}${scale.x(point.at).toFixed(2)},${scale.y(point.vitality).toFixed(2)}`).join(' ');

export function MemoryVitalityChart({ memoryId, vitality }: { memoryId: number; vitality: number }) {
  const { t, locale } = useTranslation();
  const query = useMemoryVitalityHistory(memoryId);
  const history = query.data;
  const scale = useMemo(() => (history ? buildScale(history) : null), [history]);

  if (query.isLoading) {
    return <LoadingState variant="block" />;
  }
  // The curve elaborates on a number that is already shown next to it, so a failure here is not worth
  // an error state of its own — the drawer simply carries on without it.
  if (query.isError || !history || !scale) return null;

  const stroke = TONE_STROKE[vitalityTone(vitality)];
  const nowX = scale.x(history.now);
  const floorY = scale.y(history.floor);

  const evictLabel = history.evictAt
    ? new Date(history.evictAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const summary = evictLabel
    ? t.memory.vitalityEvictOn.replace('{date}', evictLabel)
    : t.memory.vitalityNeverEvicted;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.memory.vitalityChart}</span>
        <span className={`text-[11px] ${history.evictAt ? TONE_TEXT.warning : TONE_TEXT.muted}`}>{summary}</span>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-28 w-full rounded-md border border-border/70 bg-elevated/30"
        role="img"
        aria-label={`${t.memory.fieldVitality} ${vitalityPct(vitality)}/100. ${summary}`}
      >
        {/* Retention floor: below this the daily sweep moves the memory to the trash. */}
        <line
          x1={0} y1={floorY} x2={VIEW_W} y2={floorY}
          stroke="var(--color-danger)" strokeWidth={1} strokeDasharray="2 3" opacity={0.55}
          vectorEffect="non-scaling-stroke"
        />
        {/* Where the reconstructed past ends and the projection begins. */}
        <line
          x1={nowX} y1={0} x2={nowX} y2={VIEW_H}
          stroke="var(--color-border-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke"
        />
        {history.points.length > 1 ? (
          <path d={toPath(history.points, scale)} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ) : null}
        {history.forecast.length > 1 ? (
          <path
            d={toPath(history.forecast, scale)}
            fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray="3 3" opacity={0.6}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {/* One mark per recall — the moments that pushed the curve back up. */}
        {history.recalls.map((at) => (
          <circle key={at} cx={scale.x(at)} cy={VIEW_H - 2} r={1.5} fill="var(--color-accent)" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>

      <span className="text-[11px] text-text-muted">
        {history.historyFrom === null ? t.memory.vitalityNoHistory : t.memory.vitalityForecastHint}
      </span>
    </div>
  );
}

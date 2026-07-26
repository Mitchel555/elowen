'use client';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { elowenClient } from '../../lib/elowenClient';
import { formatTokens, formatCost } from '../../lib/format';
import { OAuthUsageRail, usageFillClass } from '../settings/OAuthUsageRail';
import { useBrainChat } from './BrainChatProvider';

/** A section heading: a quiet label with an optional right-aligned meta value, mirroring the CLI rail. */
function SectionHead({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-tiny uppercase tracking-wide text-text-subtle">
      <span>{label}</span>
      {meta ? <span className="truncate font-mono normal-case tracking-normal">{meta}</span> : null}
    </div>
  );
}

/** The context-fill meter. Same pressure colours and same "never read as empty" sliver as the OAuth
 *  limit windows, so both meters in the panel speak one visual language. */
function ContextMeter({ percent }: { percent: number }) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-elevated">
      <span
        className={`block h-full rounded-full ${usageFillClass(pct)} transition-[width] duration-500`}
        style={{ width: `${pct > 0 ? Math.max(pct, 3) : 0}%` }}
      />
    </span>
  );
}

/** The panel's sections, in the CLI rail's order: context fill, subscription limits, project, MCP, LSP.
 *  A section the daemon does not report simply does not render — an empty rail is quieter than a rail
 *  full of dashes. Shared by the desktop column and the mobile drawer. */
function TelemetryBody() {
  const { t } = useTranslation();
  const { usage, telemetry, activeSessionId } = useBrainChat();
  // The subscription rail changes on the scale of hours and lives on its own endpoint (the daemon keeps
  // it out of the hot status poll on purpose) — so it is fetched separately and refreshed slowly.
  const { data: limits } = useQuery({
    queryKey: ['brain-rate-limits-session', activeSessionId],
    queryFn: () => elowenClient.brainRateLimits(activeSessionId ?? undefined),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const project = telemetry.project;
  const mcp = telemetry.mcp;
  const mcpConnected = mcp?.filter((s) => s.status === 'connected') ?? [];
  const hasProject = !!project?.cwd || !!project?.branch;
  const sections = [
    usage !== null,
    !!limits?.windows.length,
    hasProject,
    mcpConnected.length > 0,
    telemetry.lspEnabled !== null,
  ];
  if (!sections.some(Boolean)) {
    return <p className="px-3 py-3 text-xs text-text-muted">{t.telemetry.empty}</p>;
  }

  return (
    <div className="flex flex-col gap-4 px-3 py-3">
      {usage ? (
        <section className="flex flex-col gap-1.5" data-testid="telemetry-context">
          <SectionHead
            label={t.brainChat.context}
            meta={usage.percent == null ? undefined : `${Math.round(usage.percent)}%`}
          />
          <ContextMeter percent={usage.percent ?? 0} />
          <p className="font-mono text-tiny text-text-muted">
            {formatTokens(usage.tokens ?? 0)} / {formatTokens(usage.contextWindow)} · {formatCost(usage.cost, 2)}
          </p>
        </section>
      ) : null}

      {limits?.windows.length ? (
        <section className="flex flex-col gap-1.5" data-testid="telemetry-limits">
          <SectionHead label={t.telemetry.limits} meta={limits.planType ?? undefined} />
          <OAuthUsageRail usage={limits} />
        </section>
      ) : null}

      {hasProject ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-project">
          <SectionHead label={t.telemetry.project} />
          {project?.cwd ? (
            <p className="truncate font-mono text-tiny text-text" title={project.cwd}>{project.cwd}</p>
          ) : null}
          {project?.branch ? (
            <p className="font-mono text-tiny text-text-muted">
              {t.telemetry.branch} <span className="text-accent">{project.branch}</span>
            </p>
          ) : null}
        </section>
      ) : null}

      {mcpConnected.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-mcp">
          <SectionHead
            label={t.telemetry.mcp}
            meta={t.telemetry.mcpActive.replace('{active}', String(mcpConnected.length)).replace('{total}', String(mcp?.length ?? 0))}
          />
          <ul className="flex flex-col gap-0.5">
            {mcpConnected.map((s) => (
              <li key={s.name} className="flex items-center gap-1.5 text-tiny">
                <span className="shrink-0 text-success" aria-hidden>●</span>
                <span className="truncate font-mono text-text" title={s.name}>{s.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {telemetry.lspEnabled !== null ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-lsp">
          <SectionHead label={t.telemetry.lsp} />
          <p className="flex items-center gap-1.5 text-tiny">
            <span className={`shrink-0 ${telemetry.lspEnabled ? 'text-success' : 'text-text-subtle'}`} aria-hidden>●</span>
            <span className="text-text">{telemetry.lspEnabled ? t.telemetry.lspActive : t.telemetry.lspInactive}</span>
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** The chat telemetry rail — the web counterpart of the CLI's right-hand panel. It holds information
 *  rather than asking for attention: quiet labels, one meter vocabulary, no colour unless a number is
 *  under pressure.
 *
 *  `column` is the desktop layout (a real sidebar beside the transcript); `drawer` is the mobile one,
 *  because a second column on a phone would squeeze the conversation off the screen. The host picks
 *  between them via `useMobile()` — this component never renders both. */
export function TelemetryPanel({ variant, open = false, onClose }: {
  variant: 'column' | 'drawer';
  open?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();

  if (variant === 'drawer') {
    // Mounted only while open, like the history drawer: a closed drawer leaves nothing focusable behind.
    if (!open) return null;
    return (
      <div className="fixed inset-0 z-[60]" onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}>
        <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={t.telemetry.title}
          data-testid="telemetry-drawer"
          className="animate-drawer-in absolute inset-y-0 right-0 flex w-72 max-w-[85%] flex-col overflow-y-auto border-l border-border bg-surface shadow-xl"
        >
          <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{t.telemetry.title}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t.telemetry.close}
              title={t.telemetry.close}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
          <TelemetryBody />
        </aside>
      </div>
    );
  }

  return (
    <aside
      aria-label={t.telemetry.title}
      data-testid="telemetry-column"
      className="flex w-60 shrink-0 flex-col border-l border-border"
    >
      {/* The border runs the full column height while the content itself follows the reader, so the rail
          stays legible through a long transcript instead of scrolling away with the first turns. */}
      <div className="sticky top-0 max-h-[100dvh] overflow-y-auto">
        <TelemetryBody />
      </div>
    </aside>
  );
}
